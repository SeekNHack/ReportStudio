import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import * as vscode from 'vscode';
import { convertProject, describePlan, isExcludedFromCopy, suggestMapping, type ConversionMode } from '../core/convert';
import { listDesigns, loadDesign, markdownFieldIds } from '../core/design';
import { findingValues, newFindingText, parseFinding, serializeFinding, setFindingValue, setYamlValue } from '../core/findingFile';
import { ASSETS_DIR, collectionOfFile, DESIGNS_DIR, REPORT_FILE, reportYamlDocument, slugify, uniqueItemFile } from '../core/project';
import type { Design } from '../core/types';
import type { BuildService } from './build';
import type { HomeTab } from '../../webview/home/types';
import type { HomePanel } from './home';
import type { PreviewPanel } from './preview';
import type { ProjectService } from './projects';
import { isFixed, readLibrary, type LibraryEntry } from './trees';

const FINDING_FORM = 'reportStudio.findingForm';
const REPORT_FORM = 'reportStudio.reportForm';

/** Resolves the finding a command applies to: tree node, URI, or the active editor tab. */
function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const node = arg as { finding?: { file: string }; file?: string } | undefined;
  if (node?.finding?.file) return vscode.Uri.file(node.finding.file);
  if (node?.file) return vscode.Uri.file(node.file);
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) return input.uri;
  return undefined;
}

export function registerCommands(context: vscode.ExtensionContext, projects: ProjectService, builds: BuildService, preview: PreviewPanel, home: HomePanel, refreshTrees: () => void): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  const requireProject = async (): Promise<string | undefined> => {
    if (projects.active) return projects.active;
    const a = await vscode.window.showWarningMessage('No engagement yet. Create one from the Report Studio home, starting from any template.', 'New Engagement', 'Open Home');
    if (a === 'New Engagement') home.show('engagements', { newEngagement: true });
    if (a === 'Open Home') home.show('home');
    return undefined;
  };

  const openFinding = (uri: vscode.Uri, column?: vscode.ViewColumn) => vscode.commands.executeCommand('vscode.openWith', uri, FINDING_FORM, column);

  /* ------------------------------------------------------------ build */
  reg('reportStudio.buildPdf', (uri?: vscode.Uri) => builds.run('pdf', uri instanceof vscode.Uri ? projects.projectOf(uri.fsPath) : undefined));
  reg('reportStudio.exportHtml', () => builds.run('html'));
  reg('reportStudio.openPreview', async (arg?: unknown) => {
    const node = (arg as { kind?: string; dir?: string } | undefined)?.kind === 'engagement' ? (arg as { dir: string }).dir : undefined;
    if (node) projects.setActive(node);
    const dir = node ?? (await requireProject());
    if (dir) preview.show(dir);
  });

  /* ---------------------------------------------------------- project */
  reg('reportStudio.openHome', (tab?: unknown, opts?: { newEngagement?: string | true }) =>
    home.show(typeof tab === 'string' ? (tab as HomeTab) : undefined, { newEngagement: opts?.newEngagement }),
  );
  /** New engagement: the dialog of the home, optionally with a template already chosen. */
  reg('reportStudio.newProject', (designId?: unknown) => home.show('engagements', { newEngagement: typeof designId === 'string' ? designId : true }));

  reg('reportStudio.openEngagement', async (dir?: unknown) => {
    const target = typeof dir === 'string' ? dir : (dir as { dir?: string } | undefined)?.dir;
    if (!target) return vscode.commands.executeCommand('reportStudio.selectProject');
    projects.setActive(target);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(join(target, REPORT_FILE)), REPORT_FORM);
  });

  reg('reportStudio.selectProject', async () => {
    const pick = await vscode.window.showQuickPick(
      projects.projects.map((d) => ({ label: projects.displayName(d), description: d === projects.active ? 'active' : '', detail: d, dir: d })),
      { placeHolder: 'Select the active report project' },
    );
    if (pick) projects.setActive(pick.dir);
  });

  reg('reportStudio.openReport', async () => {
    const dir = await requireProject();
    if (dir) await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(join(dir, REPORT_FILE)), REPORT_FORM);
  });

  reg('reportStudio.refresh', async () => {
    await projects.discover();
    refreshTrees();
  });

  /* ----------------------------------------------------------- items */
  /** Creates an entry of a collection (default: findings) and opens its form. */
  const createItem = async (dir: string, collectionId: string | undefined, values: Record<string, unknown>, from?: string) => {
    const loaded = projects.load(dir);
    const design = loaded?.design;
    if (!design) {
      void vscode.window.showErrorMessage(loaded?.error?.message ?? 'The design of this project cannot be loaded.');
      return;
    }
    const collection = design.collections.find((c) => c.id === collectionId) ?? design.collections.find((c) => c.id === 'findings') ?? design.collections[0];
    if (!collection) {
      const a = await vscode.window.showWarningMessage(`Design "${design.name}" has no collections. Add one in the design editor.`, 'Edit Design');
      if (a) void vscode.commands.executeCommand('reportStudio.editDesign');
      return;
    }
    const title = String(values[collection.titleField] ?? values.title ?? collection.itemLabel);
    const file = uniqueItemFile(dir, collection.id, title);
    mkdirSync(dirname(file), { recursive: true });
    const merged: Record<string, unknown> = {};
    for (const f of collection.fields) if (f.default !== undefined) merged[f.id] = f.default;
    for (const f of collection.fields) if (f.type === 'datetime' && f.required && merged[f.id] === undefined) merged[f.id] = localNow();
    Object.assign(merged, values);
    if (values.title !== undefined && collection.titleField !== 'title') {
      merged[collection.titleField] = values.title;
      delete merged.title;
    }
    const md = markdownFieldIds(collection.fields);
    writeFileSync(file, from ? retarget(from, merged, md, collection.titleField) : newFindingText(merged, md, collection.fields.map((f) => f.id)));
    await openFinding(vscode.Uri.file(file));
    return file;
  };

  const pickCollection = async (dir: string, placeHolder: string) => {
    const cols = projects.load(dir)?.design?.collections ?? [];
    if (cols.length <= 1) return cols[0];
    const pick = await vscode.window.showQuickPick(
      cols.map((c) => ({ label: `$(${c.icon}) ${c.itemLabel}`, description: c.label, detail: c.description, c })),
      { placeHolder },
    );
    return pick?.c;
  };

  const askAndCreate = async (dir: string, collectionId?: string) => {
    const design = projects.load(dir)?.design;
    const collection = collectionId ? design?.collections.find((c) => c.id === collectionId) : await pickCollection(dir, 'What do you want to add?');
    if (!collection && design?.collections.length) return;
    const label = collection?.itemLabel ?? 'Entry';
    const title = await vscode.window.showInputBox({ title: `New ${label}`, prompt: `${design?.collections.find((c) => c.id === collection?.id)?.fields.find((f) => f.id === collection?.titleField)?.label ?? 'Title'}` });
    if (!title) return;
    await createItem(dir, collection?.id, { [collection?.titleField ?? 'title']: title });
  };

  reg('reportStudio.newItem', async (collectionId?: string) => {
    const dir = await requireProject();
    if (dir) await askAndCreate(dir, typeof collectionId === 'string' ? collectionId : undefined);
  });
  reg('reportStudio.newItemInCollection', async (node?: { collection?: { id: string } }) => {
    const dir = await requireProject();
    if (dir) await askAndCreate(dir, node?.collection?.id);
  });
  reg('reportStudio.newFinding', async () => {
    const dir = await requireProject();
    if (!dir) return;
    const hasFindings = projects.load(dir)?.design?.collections.some((c) => c.id === 'findings');
    await askAndCreate(dir, hasFindings ? 'findings' : undefined);
  });

  reg('reportStudio.openFinding', (uri: vscode.Uri) => openFinding(uri));
  reg('reportStudio.openAsForm', async (arg?: unknown) => {
    const uri = targetUri(arg);
    if (uri) await openFinding(uri);
  });

  reg('reportStudio.openAsText', async (arg?: unknown) => {
    const uri = targetUri(arg);
    if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  });

  reg('reportStudio.duplicateFinding', async (arg?: unknown) => {
    const uri = targetUri(arg);
    const dir = uri && projects.projectOf(uri.fsPath);
    if (!uri || !dir) return;
    const text = projects.read(uri.fsPath);
    const cid = collectionOfFile(dir, uri.fsPath);
    const collection = projects.load(dir)?.design?.collections.find((c) => c.id === cid);
    const values = findingValues(parseFinding(text));
    const key = collection?.titleField ?? 'title';
    await createItem(dir, cid, { [key]: `${String(values[key] ?? collection?.itemLabel ?? 'Entry')} (copy)` }, text);
  });

  reg('reportStudio.deleteFinding', async (arg?: unknown) => {
    const uri = targetUri(arg);
    if (!uri) return;
    const title = String(findingValues(parseFinding(projects.read(uri.fsPath))).title ?? basename(uri.fsPath));
    const ok = await vscode.window.showWarningMessage(`Delete finding "${title}"?`, { modal: true, detail: 'The file is moved to the trash when possible.' }, 'Delete');
    if (ok !== 'Delete') return;
    for (const group of vscode.window.tabGroups.all)
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri };
        if (input?.uri?.toString() === uri.toString()) await vscode.window.tabGroups.close(tab);
      }
    await vscode.workspace.fs.delete(uri, { useTrash: true }).then(undefined, () => rmSync(uri.fsPath, { force: true }));
  });

  reg('reportStudio.toggleFixed', async (arg?: unknown) => {
    const uri = targetUri(arg);
    const dir = uri && projects.projectOf(uri.fsPath);
    const design = dir ? projects.load(dir)?.design : undefined;
    if (!uri || !design) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const parsed = parseFinding(doc.getText());
    const values = findingValues(parsed);
    const next = !isFixed(values);
    if (design.findingFields.some((f) => f.id === 'fixed')) setFindingValue(parsed, 'fixed', next, false);
    const status = design.findingFields.find((f) => f.id === 'retest_status');
    if (status?.options) {
      const values = status.options.map((o) => o.value);
      const pick = (candidates: string[]) => candidates.find((v) => values.includes(v));
      const value = next ? pick(['solved', 'fixed', 'resolved']) : pick(['not_solved', 'not_fixed', 'open']);
      if (value) setFindingValue(parsed, 'retest_status', value, false);
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), serializeFinding(parsed));
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  });

  /* ---------------------------------------------------------- designs */
  const setDesign = async (dir: string, id: string) => {
    const reportUri = vscode.Uri.file(join(dir, REPORT_FILE));
    const doc = await vscode.workspace.openTextDocument(reportUri);
    const y = reportYamlDocument(doc.getText());
    setYamlValue(y, 'design', id);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(reportUri, new vscode.Range(0, 0, doc.lineCount, 0), y.toString({ lineWidth: 0 }));
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  };

  const pickDesign = async (dir: string | undefined, placeHolder: string) => {
    const current = dir ? projects.load(dir)?.project.designId : undefined;
    const items = listDesigns(projects.designRoots(dir)).map((d) => {
      let name = d.id;
      let description: string | undefined;
      try {
        const loaded = loadDesign(projects.designRoots(dir), d.id, projects.read);
        name = loaded.name;
        description = loaded.description;
      } catch {
        /* keep id */
      }
      return { label: `${d.id === current ? '$(check) ' : ''}${name}`, description: `${d.id}${projects.isBuiltin(d.dir) ? ' · built-in' : ''}`, detail: description, id: d.id, dir: d.dir };
    });
    return vscode.window.showQuickPick(items, { placeHolder });
  };

  /**
   * Changes the report type: converts this report in place, or creates a new
   * report from it (e.g. the retest of a pentest) without copying anything by hand.
   */
  const changeType = async (preset?: ConversionMode) => {
    const dir = await requireProject();
    const loaded = dir ? projects.load(dir) : undefined;
    if (!dir || !loaded) return;
    const current = loaded.project.designId;
    const pick = await pickDesign(dir, preset === 'copy' ? 'Type of the new report (e.g. Penetration Test Retest)' : 'New report type — values are carried over to the fields of the new type');
    if (!pick) return;
    let to: Design;
    try {
      to = loadDesign(projects.designRoots(dir), pick.id, projects.read);
    } catch (e) {
      void vscode.window.showErrorMessage(`Cannot load design "${pick.id}": ${(e as Error).message}`);
      return;
    }
    let mode = preset ?? (pick.id === current ? 'copy' : undefined);
    if (!mode) {
      const m = await vscode.window.showQuickPick(
        [
          { label: '$(copy) Create a new report from this one', detail: 'This report stays as it is. Findings, details and screenshots are copied into a new project folder — typical for a retest.', mode: 'copy' as const },
          { label: '$(arrow-swap) Convert this report', detail: 'Changes the type of this report in place. Values the new type does not use are kept in the files, hidden.', mode: 'inplace' as const },
        ],
        { title: `Change report type to "${to.name}"`, placeHolder: 'What do you want to do?' },
      );
      if (!m) return;
      mode = m.mode;
    }

    // Collections: same id is automatic, the others are asked.
    const map = suggestMapping(loaded.project, loaded.design, to);
    for (const [sid, suggested] of Object.entries(map)) {
      const count = loaded.project.items[sid]?.length ?? 0;
      if (!count || suggested === sid) continue;
      const label = loaded.design?.collections.find((c) => c.id === sid)?.label ?? sid;
      const choice = await vscode.window.showQuickPick(
        [
          ...to.collections.map((c) => ({ label: `$(${c.icon}) ${c.label}`, description: c.id === suggested ? 'suggested' : c.id, id: c.id as string | null })),
          { label: mode === 'copy' ? '$(circle-slash) Do not copy' : '$(circle-slash) Leave the files as they are', description: '', id: null },
        ].sort((a, b) => (b.description === 'suggested' ? 1 : 0) - (a.description === 'suggested' ? 1 : 0)),
        { title: `"${to.name}" has no "${label}"`, placeHolder: `Where should the ${count} ${label.toLowerCase()} go?` },
      );
      if (!choice) return;
      map[sid] = choice.id;
    }

    let target = dir;
    if (mode === 'copy') {
      const parent = dirname(dir);
      const suffix = to.id === current ? 'round-2' : to.id;
      const name = await vscode.window.showInputBox({
        title: 'New report folder',
        prompt: `Created next to "${basename(dir)}"`,
        value: `${basename(dir).replace(new RegExp(`-${suffix}$`), '')}-${suffix}`,
        validateInput: (v) => (!v.trim() ? 'Required' : existsSync(join(parent, slugify(v))) ? 'A folder with this name already exists' : undefined),
      });
      if (!name) return;
      target = join(parent, slugify(name));
    }

    await vscode.workspace.saveAll(false);
    const project = projects.load(dir)?.project ?? loaded.project;
    const run = (dropUnused: boolean) => convertProject(project, loaded.design, to, { mode: mode!, map, dropUnused }, projects.read);
    const planned = run(false);
    const hasUnused = [planned.plan.report, ...planned.plan.collections.map((c) => c.changes)].some((c) => c.unused.length);
    const go = mode === 'copy' ? 'Create Report' : 'Convert';
    const goDrop = `${go} and Remove Unused Values`;
    const answer = await vscode.window.showInformationMessage(
      mode === 'copy' ? `Create "${basename(target)}" as ${to.name}?` : `Convert this report to ${to.name}?`,
      { modal: true, detail: describePlan(planned) + (hasUnused ? '\n\nUnused values stay in the files (hidden) so you can switch back, unless you remove them.' : '') },
      go,
      ...(hasUnused ? [goDrop] : []),
    );
    if (!answer) return;
    const result = answer === goDrop ? run(true) : planned;

    if (mode === 'copy') cpSync(dir, target, { recursive: true, filter: (src) => !isExcludedFromCopy(dir, src, result.skipDirs) });
    for (const w of result.writes) {
      mkdirSync(dirname(join(target, w.path)), { recursive: true });
      writeFileSync(join(target, w.path), w.content);
    }
    for (const d of result.deletes) rmSync(join(target, d), { force: true });
    for (const c of to.collections) mkdirSync(join(target, c.id), { recursive: true });

    await projects.discover();
    if (mode === 'inplace') {
      projects.setActive(dir);
      refreshTrees();
      void vscode.window.showInformationMessage(`Converted to ${to.name}.`, 'Open Report', 'Open Preview').then((a) => {
        if (a === 'Open Report') void vscode.commands.executeCommand('reportStudio.openReport');
        if (a === 'Open Preview') preview.show(dir);
      });
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.some((f) => target.startsWith(f.uri.fsPath + sep))) {
      const a = await vscode.window.showInformationMessage(`Created ${target}.`, 'Open Folder', 'Add to Workspace');
      if (a === 'Open Folder') return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target));
      if (a === 'Add to Workspace') {
        vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(target) });
        await new Promise((r) => setTimeout(r, 500));
        await projects.discover();
      } else return;
    }
    projects.setActive(target);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(join(target, REPORT_FILE)), REPORT_FORM);
    void vscode.window.showInformationMessage(`New ${to.name} created from "${basename(dir)}". It is now the active report.`);
  };

  reg('reportStudio.switchDesign', () => changeType());
  reg('reportStudio.newReportFrom', () => changeType('copy'));

  /** Where new templates go: the workspace designs/ folder, shared by every engagement. */
  const templatesDir = () => {
    const dir = projects.templatesDir;
    if (!dir) void vscode.window.showWarningMessage('Open a folder first: templates are stored in its designs/ folder.', 'Open Folder').then((a) => a && vscode.commands.executeCommand('workbench.action.files.openFolder'));
    return dir;
  };

  /** After creating a template: offer to use it for the active engagement. */
  const offerTemplate = async (id: string, name: string, where: string) => {
    const dir = projects.active;
    const actions = dir ? ['New Engagement', 'Use for Current Report'] : ['New Engagement'];
    void vscode.window.showInformationMessage(`Template "${name}" created in ${where}. Open the template preview to see your changes live.`, 'Preview', ...actions).then(async (a) => {
      if (a === 'Preview') preview.showTemplate(id);
      if (a === 'New Engagement') home.show('engagements', { newEngagement: id });
      if (a === 'Use for Current Report' && dir) await setDesign(dir, id);
    });
  };

  reg('reportStudio.copyDesign', async (presetId?: unknown) => {
    const root = templatesDir();
    if (!root) return;
    const roots = projects.designRoots(projects.active);
    const preset = typeof presetId === 'string' ? listDesigns(roots).find((d) => d.id === presetId) : undefined;
    const pick = preset ?? (await pickDesign(projects.active, 'Template to copy into the workspace (designs/) so you can edit everything, HTML included'));
    if (!pick) return;
    const name = await vscode.window.showInputBox({
      title: 'Copy Template',
      prompt: `Folder name in ${vscode.workspace.asRelativePath(root)}/`,
      value: `${pick.id}-custom`,
      validateInput: (v) => (!/^[\w.-]+$/.test(v) ? 'Letters, numbers, dot, dash and underscore only' : listDesigns(roots).some((d) => d.id === v) ? 'A template with this id already exists' : undefined),
    });
    if (!name) return;
    const target = join(root, name);
    cpSync(pick.dir, target, { recursive: true });
    // Templates inherited from parents are copied too, so every part of the layout is editable here.
    const design = loadDesign(roots, pick.id, projects.read);
    for (const parent of design.parents) {
      for (const file of readdirSync(parent.dir)) {
        if (file.endsWith('.html') && !existsSync(join(target, file))) copyFileSync(join(parent.dir, file), join(target, file));
      }
    }
    if (!existsSync(join(target, 'styles.css')))
      writeFileSync(join(target, 'styles.css'), `/* Overrides on top of the styles of "${design.parents[0]?.id ?? pick.id}". Example:\n:root { --accent: #0f766e; }\n*/\n`);
    // Keep the name unique in the template gallery.
    const yamlFile = join(target, 'design.yaml');
    const y = reportYamlDocument(readFileSync(yamlFile, 'utf8'));
    setYamlValue(y, 'name', `${design.name} (custom)`);
    writeFileSync(yamlFile, y.toString({ lineWidth: 0 }));
    await projects.discover();
    await vscode.window.showTextDocument(vscode.Uri.file(join(target, existsSync(join(target, 'template.html')) ? 'template.html' : 'design.yaml')));
    preview.showTemplate(name);
    await offerTemplate(name, `${design.name} (custom)`, vscode.workspace.asRelativePath(target));
  });

  reg('reportStudio.importTemplate', async () => {
    const root = templatesDir();
    if (!root) return;
    const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Import', title: 'Import Templates: choose folders with a design.yaml' });
    if (!chosen?.length) return;
    const existing = listDesigns(projects.designRoots(projects.active)).map((d) => d.id);
    const imported: string[] = [];
    for (const uri of chosen) {
      // A folder with design.yaml, or a folder of such folders.
      const dirs = existsSync(join(uri.fsPath, 'design.yaml')) ? [uri.fsPath] : listDesigns([uri.fsPath]).map((d) => d.dir);
      for (const src of dirs) {
        let id = basename(src);
        for (let i = 2; existing.includes(id); i++) id = `${basename(src)}-${i}`;
        cpSync(src, join(root, id), { recursive: true });
        existing.push(id);
        imported.push(id);
      }
    }
    if (!imported.length) {
      void vscode.window.showWarningMessage('No template found: a template is a folder with a design.yaml (plus optional template.html and styles.css).');
      return;
    }
    await projects.discover();
    home.show('templates');
    void vscode.window.showInformationMessage(`Imported ${imported.length} template(s): ${imported.join(', ')}.`);
  });

  /** Opens a template in the design editor; built-in ones are offered to extend or copy. */
  const editTemplate = async (id: string) => {
    const t = listDesigns(projects.designRoots(projects.active)).find((d) => d.id === id);
    if (!t) return;
    const file = join(t.dir, 'design.yaml');
    if (projects.isBuiltin(file)) {
      const a = await vscode.window.showInformationMessage(
        `"${id}" is a built-in template and cannot be changed. Create your own template that extends it (you only add or change what you need), or copy it with its HTML.`,
        'Create Template Extending It',
        'Copy Template',
        'View Read-only',
      );
      if (a === 'Create Template Extending It') return vscode.commands.executeCommand('reportStudio.newDesign', id);
      if (a === 'Copy Template') return vscode.commands.executeCommand('reportStudio.copyDesign', id);
      if (!a) return;
    }
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'reportStudio.designEditor');
  };

  reg('reportStudio.editTemplate', async (id?: unknown) => {
    if (typeof id === 'string') return editTemplate(id);
    const pick = await pickDesign(projects.active, 'Template to edit');
    if (pick) await editTemplate(pick.id);
  });

  reg('reportStudio.previewTemplate', async (id?: unknown) => {
    const pick = typeof id === 'string' ? { id } : await pickDesign(projects.active, 'Template to preview with sample data');
    if (pick) preview.showTemplate(pick.id);
  });

  reg('reportStudio.editDesign', async () => {
    const dir = await requireProject();
    const design = dir ? projects.load(dir)?.design : undefined;
    if (design) await editTemplate(design.id);
  });

  reg('reportStudio.newDesign', async (presetParent?: unknown) => {
    const root = templatesDir();
    if (!root) return;
    const roots = projects.designRoots(projects.active);
    const existing = listDesigns(roots);
    type StartPick = vscode.QuickPickItem & { mode: 'blank' | 'extend' | 'copy'; id?: string };
    let start: StartPick | undefined;
    if (typeof presetParent === 'string') start = { label: '', mode: 'extend', id: presetParent };
    else {
      const items: StartPick[] = [
        { label: '$(new-file) Blank template', detail: 'Extends "base": cover, table of contents and automatic layout of every field. Define fields and collections in the GUI, no HTML needed.', mode: 'blank' },
        { label: 'Extend an existing template', kind: vscode.QuickPickItemKind.Separator, mode: 'extend' },
        ...existing.filter((d) => d.id !== 'base').map((d) => ({ label: `$(symbol-color) ${d.id}`, description: projects.isBuiltin(d.dir) ? 'built-in' : 'workspace', detail: 'Inherit everything, then add or hide fields', mode: 'extend' as const, id: d.id })),
      ];
      start = await vscode.window.showQuickPick(items, { title: 'New Template (1/2)', placeHolder: 'How do you want to start?' });
    }
    if (!start) return;
    const name = await vscode.window.showInputBox({
      title: 'New Template (2/2)',
      prompt: 'Name of the report type',
      placeHolder: 'e.g. Incident Response, Code Review, Phishing Campaign, Audit…',
      validateInput: (v) => (!v.trim() ? 'Required' : existing.some((d) => d.id === slugify(v)) ? 'A template with this id already exists' : undefined),
    });
    if (!name) return;
    const id = slugify(name);
    const target = join(root, id);
    mkdirSync(target, { recursive: true });
    const parent = start.mode === 'blank' ? 'base' : start.id!;
    const body =
      start.mode === 'blank'
        ? `# Created with "Report Studio: New Design". Edit it with the Design editor or by hand.\nname: ${JSON.stringify(name)}\nextends: base\n\nreport_fields:\n  summary: { type: markdown, label: Summary, required: true }\n\ncollections:\n  items:\n    label: Items\n    item_label: Item\n    prefix: "#"\n    fields:\n      title: { type: string, required: true }\n      description: { type: markdown }\n`
        : `# Extends "${parent}": add fields here, or set an inherited field to null to hide it.\nname: ${JSON.stringify(name)}\nextends: ${parent}\n`;
    writeFileSync(join(target, 'design.yaml'), body);
    await projects.discover();
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(join(target, 'design.yaml')), 'reportStudio.designEditor');
    await offerTemplate(id, name, vscode.workspace.asRelativePath(target));
  });

  /* ---------------------------------------------------------- library */
  const insertEntry = async (entry: LibraryEntry) => {
    const dir = await requireProject();
    if (!dir) return;
    const collection = projects.load(dir)?.design?.collections.find((c) => c.id === 'findings') ?? (await pickCollection(dir, 'Insert the library entry into…'));
    if (!collection) return;
    await createItem(dir, collection.id, { [collection.titleField]: entry.values.title ?? entry.values[collection.titleField] }, projects.read(entry.file));
  };

  reg('reportStudio.insertFromLibrary', async () => {
    const entries = readLibrary(projects.libraryRoots(), projects.read);
    if (!entries.length) {
      const a = await vscode.window.showInformationMessage('The library is empty. Save a finding to the library first, or set "reportStudio.libraryPath".', 'Open Settings');
      if (a) void vscode.commands.executeCommand('workbench.action.openSettings', 'reportStudio.libraryPath');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      entries.map((e) => ({ label: String(e.values.title ?? basename(e.file)), description: [e.values.category, e.values.cvss ? 'CVSS' : ''].filter(Boolean).join(' · '), detail: String(e.values.description ?? '').split('\n')[0].slice(0, 160), entry: e })),
      { placeHolder: 'Search the finding library', matchOnDescription: true, matchOnDetail: true },
    );
    if (pick) await insertEntry(pick.entry);
  });

  reg('reportStudio.insertLibraryItem', (e: LibraryEntry) => insertEntry(e));

  reg('reportStudio.saveToLibrary', async (arg?: unknown) => {
    const uri = targetUri(arg);
    if (!uri || !uri.fsPath.endsWith('.md')) {
      void vscode.window.showInformationMessage('Open a finding (or right-click one in the Findings view) to save it to the library.');
      return;
    }
    const roots = projects.libraryRoots();
    if (!roots.length) return;
    const root = roots.find((r) => existsSync(r)) ?? roots[0];
    const parsed = parseFinding(projects.read(uri.fsPath));
    // Engagement specific data does not belong in a reusable entry.
    for (const key of ['fixed', 'retest_status', 'retest_date', 'retest_notes', 'affected', 'id', 'order']) setFindingValue(parsed, key, undefined, false);
    parsed.sections = parsed.sections.filter((s) => !['retest_notes', 'proof_of_concept'].includes(s.id));
    const title = String(findingValues(parsed).title ?? basename(uri.fsPath, '.md'));
    let file = join(root, `${slugify(title)}.md`);
    if (existsSync(file)) {
      const a = await vscode.window.showWarningMessage(`"${basename(file)}" already exists in the library.`, 'Overwrite', 'Keep Both');
      if (!a) return;
      if (a === 'Keep Both') file = join(root, `${slugify(title)}-${Date.now().toString(36)}.md`);
    }
    mkdirSync(root, { recursive: true });
    writeFileSync(file, serializeFinding(parsed));
    refreshTrees();
    void vscode.window.showInformationMessage(`Saved "${title}" to ${vscode.workspace.asRelativePath(file)}.`);
  });
}

function localNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Copies an existing finding text, replacing its title (and dropping a fixed `id`). */
function retarget(text: string, values: Record<string, unknown>, markdownFields: string[], titleField = 'title'): string {
  const parsed = parseFinding(text);
  setFindingValue(parsed, 'id', undefined, false);
  const existing = findingValues(parsed);
  for (const [k, v] of Object.entries(values)) {
    if (k === titleField || existing[k] === undefined) setFindingValue(parsed, k, v, markdownFields.includes(k));
  }
  return serializeFinding(parsed);
}
