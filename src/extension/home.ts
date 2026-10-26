import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { scoreCvss } from '../core/cvss';
import { listDesigns, loadDesign } from '../core/design';
import { findingSeverity, REPORT_FILE, scaffoldProject, slugify } from '../core/project';
import { isResolved } from '../core/render';
import { resolveTheme } from '../core/theme';
import type { Design } from '../core/types';
import type { EngagementInfo, HomeNavigate, HomeState, HomeTab, LibraryInfo, TemplateInfo } from '../../webview/home/types';
import { PRESET_ICONS, presetGroup, presetOrder } from './presets';
import type { PreviewPanel } from './preview';
import type { ProjectService } from './projects';
import { readLibrary } from './trees';
import { webviewHtml } from './webviewHtml';

const REPORT_FORM = 'reportStudio.reportForm';
const TEMPLATE_FILES = /\.(html|css)$/i;

/**
 * The Report Studio home: engagements, templates (report types) and the finding
 * library in one tab. Templates can be browsed, previewed with sample data and
 * customised before any engagement exists.
 */
export class HomePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: ProjectService,
    private readonly preview: PreviewPanel,
  ) {
    const refresh = () => this.schedule();
    this.disposables.push(projects.onDidChangeProjects(refresh), projects.onDidChange(refresh), projects.onDidChangeDesigns(refresh), vscode.workspace.onDidChangeWorkspaceFolders(refresh));
  }

  get visible(): boolean {
    return !!this.panel;
  }

  show(tab?: HomeTab, opts: { newEngagement?: string | true; preserveFocus?: boolean } = {}): void {
    const nav: HomeNavigate = { type: 'navigate', tab, newEngagement: opts.newEngagement };
    if (this.panel) {
      this.panel.reveal(undefined, opts.preserveFocus);
      if (tab || opts.newEngagement) void this.panel.webview.postMessage(nav);
      return;
    }
    const panel = vscode.window.createWebviewPanel('reportStudio.home', 'Report Studio', { viewColumn: vscode.ViewColumn.Active, preserveFocus: opts.preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, 'home', 'Report Studio');
    panel.onDidDispose(() => (this.panel = undefined), null, this.disposables);
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        this.send();
        if (tab || opts.newEngagement) void panel.webview.postMessage(nav);
        return;
      }
      try {
        const reply = await this.handle(msg);
        if (msg.requestId) void panel.webview.postMessage({ requestId: msg.requestId, ...(reply ?? {}) });
      } catch (e) {
        if (msg.requestId) void panel.webview.postMessage({ requestId: msg.requestId, error: (e as Error).message });
        else void vscode.window.showErrorMessage((e as Error).message);
      }
    }, null, this.disposables);
  }

  private schedule(): void {
    if (!this.panel) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(), 200);
  }

  private send(): void {
    void this.panel?.webview.postMessage({ type: 'state', state: this.state() });
  }

  /* ------------------------------------------------------------ state */

  private state(): HomeState {
    const ws = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
    const engagementsDir = this.projects.engagementsDir;
    const engagements = this.projects.projects.map((d) => this.engagement(d)).sort((a, b) => b.modified - a.modified);
    const used = new Map<string, number>();
    for (const e of engagements) used.set(e.designId, (used.get(e.designId) ?? 0) + 1);
    return {
      workspace: vscode.workspace.name,
      hasFolder: !!ws,
      engagementsDir: engagementsDir ? this.rel(engagementsDir) : undefined,
      templatesDir: this.projects.templatesDir ? this.rel(this.projects.templatesDir) : undefined,
      taken: engagementsDir && existsSync(engagementsDir) ? readdirSync(engagementsDir) : [],
      engagements,
      templates: this.templates(used),
      library: this.library(),
      hasActive: !!this.projects.active,
    };
  }

  private rel(p: string): string {
    return vscode.workspace.asRelativePath(p, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
  }

  private engagement(dir: string): EngagementInfo {
    const loaded = this.projects.load(dir);
    const report = loaded?.project.report ?? {};
    const design = loaded?.design;
    const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v instanceof Date ? v.toISOString().slice(0, 10) : v));
    const items = loaded?.project.items ?? {};
    let modified = mtime(join(dir, REPORT_FILE));
    for (const list of Object.values(items)) for (const i of list) modified = Math.max(modified, mtime(i.file));
    const sevCollection = design?.collections.find((c) => c.hasSeverity && items[c.id]?.length);
    const tracks = sevCollection?.fields.some((f) => f.id === 'fixed' || f.id === 'retest_status');
    return {
      dir,
      name: basename(dir),
      path: this.rel(dir),
      title: str(report.title),
      client: str(report.client),
      designId: loaded?.project.designId ?? '',
      designName: design?.name ?? loaded?.project.designId ?? '',
      icon: iconFor(design, 'file'),
      dates: { start: str(report.start_date), end: str(report.end_date), report: str(report.report_date) },
      collections: (design?.collections ?? []).map((c) => ({ id: c.id, label: c.label, icon: c.icon, count: items[c.id]?.length ?? 0 })),
      severities:
        design && sevCollection
          ? design.severities.map((s) => ({ id: s.id, label: s.label, color: s.color, count: items[sevCollection.id].filter((i) => findingSeverity(i.values, design).id === s.id).length }))
          : [],
      open: tracks && sevCollection ? items[sevCollection.id].filter((i) => !isResolved(i.values)).length : undefined,
      modified,
      active: dir === this.projects.active,
      error: loaded?.error?.message,
    };
  }

  private templates(used: Map<string, number>): TemplateInfo[] {
    const roots = this.projects.designRoots(this.projects.active);
    const builtin = this.projects.builtinDesignsDir;
    const workspaceRoots = this.projects.workspaceDesignsDirs();
    return listDesigns(roots)
      .map(({ id, dir }): TemplateInfo => {
        const source: TemplateInfo['source'] = dir.startsWith(builtin + sep) ? 'builtin' : workspaceRoots.some((r) => dir.startsWith(r + sep)) ? 'workspace' : this.projects.projects.some((p) => dir.startsWith(join(p, 'designs') + sep)) ? 'project' : 'settings';
        let design: Design | undefined;
        let error: string | undefined;
        let raw: { extends?: string; name?: string; description?: string } = {};
        try {
          raw = (parse(this.projects.read(join(dir, 'design.yaml'))) ?? {}) as typeof raw;
          design = loadDesign(roots, id, this.projects.read);
        } catch (e) {
          error = (e as Error).message;
        }
        const theme = resolveTheme(design?.theme);
        return {
          id,
          name: design?.name ?? raw.name ?? id,
          description: design?.description ?? raw.description,
          group: source === 'builtin' ? (presetGroup(id) ?? 'General') : 'Your templates',
          icon: PRESET_ICONS[id] ?? iconFor(design, 'symbol-color'),
          source,
          location: source === 'builtin' ? 'built-in' : this.rel(dir),
          dir,
          extends: raw.extends,
          collections: (design?.collections ?? []).map((c) => ({ label: c.label, icon: c.icon, fields: c.fields.length })),
          reportFields: design?.reportFields.length ?? 0,
          files: source === 'builtin' ? [] : readdirSync(dir).filter((f) => TEMPLATE_FILES.test(f)),
          theme: {
            accent: String(theme.accent ?? '#3b3fd8'),
            coverStart: String(theme.cover_start ?? '#14183a'),
            coverEnd: String(theme.cover_end ?? '#3b3fd8'),
            coverText: String(theme.cover_text ?? '#ffffff'),
            layout: String(theme.cover_layout ?? 'gradient'),
          },
          usedBy: used.get(id) ?? 0,
          hasDates: !!design?.reportFields.some((f) => f.id === 'start_date'),
          error,
        };
      })
      .sort((a, b) => (a.source === 'builtin' ? 1 : 0) - (b.source === 'builtin' ? 1 : 0) || presetOrder(a.id) - presetOrder(b.id) || a.name.localeCompare(b.name));
  }

  private library(): LibraryInfo[] {
    return readLibrary(this.projects.libraryRoots(), this.projects.read)
      .map((e) => {
        const cvss = scoreCvss(e.values.cvss);
        return {
          file: e.file,
          title: String(e.values.title ?? basename(e.file, '.md')),
          category: e.values.category ? String(e.values.category) : undefined,
          severity: typeof e.values.severity === 'string' ? e.values.severity : cvss ? cvssSeverity(cvss.score) : undefined,
          score: cvss?.score,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /* ---------------------------------------------------------- actions */

  private async handle(msg: { type: string; [k: string]: any }): Promise<Record<string, unknown> | void> {
    const cmd = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(id, ...args);
    const activate = (dir: string) => {
      if (!this.projects.projects.includes(dir)) throw new Error('This engagement no longer exists.');
      this.projects.setActive(dir);
    };
    switch (msg.type) {
      case 'command':
        await cmd(msg.command, ...(msg.args ?? []));
        return;
      case 'createEngagement':
        return this.createEngagement(msg);
      case 'openEngagement':
        activate(msg.dir);
        await cmd('vscode.openWith', vscode.Uri.file(join(msg.dir, REPORT_FILE)), REPORT_FORM);
        await cmd('workbench.view.extension.reportStudio');
        return;
      case 'engagementAction': {
        activate(msg.dir);
        const map: Record<string, string> = { preview: 'reportStudio.openPreview', build: 'reportStudio.buildPdf', export: 'reportStudio.exportData', newFrom: 'reportStudio.newReportFrom', changeType: 'reportStudio.switchDesign', addEntry: 'reportStudio.newItem' };
        if (msg.action === 'reveal') await cmd('revealInExplorer', vscode.Uri.file(join(msg.dir, REPORT_FILE)));
        else if (map[msg.action]) await cmd(map[msg.action]);
        return;
      }
      case 'templateAction':
        return this.templateAction(msg.action, msg.id, msg.file);
      case 'openLibrary':
        await vscode.window.showTextDocument(vscode.Uri.file(msg.file));
        return;
      case 'insertLibrary':
        if (msg.dir) activate(msg.dir);
        await cmd('reportStudio.insertLibraryItem', readLibrary(this.projects.libraryRoots(), this.projects.read).find((e) => e.file === msg.file));
        return;
    }
  }

  private async createEngagement(msg: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const parent = this.projects.engagementsDir;
    if (!parent) throw new Error('Open a folder first: engagements and templates are stored in the workspace.');
    const name = slugify(String(msg.name ?? ''));
    if (!name) throw new Error('Enter a name for the engagement.');
    const dir = join(parent, name);
    if (existsSync(dir)) throw new Error(`"${relative(parent, dir)}" already exists.`);
    const design = loadDesign(this.projects.designRoots(), String(msg.design), this.projects.read);
    scaffoldProject(dir, design, { client: msg.client?.trim(), start_date: msg.start_date, end_date: msg.end_date });
    await this.projects.discover();
    this.projects.setActive(dir);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(join(dir, REPORT_FILE)), REPORT_FORM);
    await vscode.commands.executeCommand('workbench.view.extension.reportStudio');
    return { dir };
  }

  private async templateAction(action: string, id: string, file?: string): Promise<void> {
    const t = listDesigns(this.projects.designRoots(this.projects.active)).find((d) => d.id === id);
    if (!t) throw new Error(`Template "${id}" not found.`);
    const builtin = this.projects.isBuiltin(join(t.dir, 'design.yaml'));
    switch (action) {
      case 'preview':
        this.preview.showTemplate(id);
        return;
      case 'edit':
        await vscode.commands.executeCommand('reportStudio.editTemplate', id);
        return;
      case 'extend':
        await vscode.commands.executeCommand('reportStudio.newDesign', id);
        return;
      case 'copy':
        await vscode.commands.executeCommand('reportStudio.copyDesign', id);
        return;
      case 'open':
        if (file && !file.includes('..')) await vscode.window.showTextDocument(vscode.Uri.file(join(t.dir, file)), { preview: false });
        return;
      case 'reveal':
        await vscode.commands.executeCommand(builtin ? 'revealFileInOS' : 'revealInExplorer', vscode.Uri.file(join(t.dir, 'design.yaml')));
        return;
      case 'delete': {
        if (builtin) return;
        const users = this.projects.projects.filter((d) => this.projects.load(d)?.project.designId === id);
        const ok = await vscode.window.showWarningMessage(
          `Delete the template "${id}"?`,
          { modal: true, detail: `${this.rel(t.dir)} is moved to the trash.${users.length ? `\n\n${users.length} engagement(s) use it and will no longer render: ${users.map((d) => basename(d)).join(', ')}.` : ''}` },
          'Delete',
        );
        if (ok !== 'Delete') return;
        await vscode.workspace.fs.delete(vscode.Uri.file(t.dir), { recursive: true, useTrash: true }).then(undefined, () => rmSync(t.dir, { recursive: true, force: true }));
        return;
      }
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Icon of the closest built-in ancestor (a design extending "pentest" gets the bug). */
function iconFor(design: Design | undefined, fallback: string): string {
  const id = design && [design.id, ...design.parents.map((p) => p.id)].find((x) => PRESET_ICONS[x] && x !== 'base');
  return id ? PRESET_ICONS[id] : fallback;
}

function cvssSeverity(score: number): string {
  return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'info';
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
