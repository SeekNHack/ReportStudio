import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { listDesigns, loadDesign, type RawDesign } from '../core/design';
import { applyDesignOp, type DesignOp } from '../core/designEdit';
import { ASSETS_DIR, slugify } from '../core/project';
import { defaultLayout, LAYOUT_BLOCKS, placeholderFor, supportsLayout, templatePartials } from '../core/layout';
import { themeDefaultsFor, themeFieldsFor } from '../core/theme';
import type { CollectionDef, Design, FieldDef } from '../core/types';
import { FIELD_TYPES } from '../core/types';
import type { ProjectService } from './projects';
import { webviewHtml } from './webviewHtml';

type Origin = 'own' | 'inherited' | 'override';

export interface FieldRow extends FieldDef {
  origin: Origin;
}

export interface CollectionRow extends Omit<CollectionDef, 'fields'> {
  origin: Origin;
  fields: FieldRow[];
  removedFields: FieldDef[];
}

/**
 * Graphical editor for design.yaml: fields, types, collections and layout options.
 * The webview sends operations; they are applied to the YAML document so that
 * comments and formatting survive, and the text editor stays fully usable.
 */
export class DesignEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: ProjectService,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    const designDir = dirname(document.uri.fsPath);
    const readOnly = document.uri.fsPath.startsWith(this.projects.builtinDesignsDir + sep);
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media'), vscode.Uri.file(designDir)] };
    webview.html = webviewHtml(webview, this.context.extensionUri, 'design', 'Design editor');
    const disposables: vscode.Disposable[] = [];
    const send = () => void webview.postMessage({ type: 'state', ...this.state(document), base: webview.asWebviewUri(vscode.Uri.file(designDir)).toString() });
    const reply = (msg: { requestId?: number }, abs: string) =>
      void webview.postMessage({ type: 'imageSaved', requestId: msg.requestId, path: relative(designDir, abs).split('\\').join('/'), url: webview.asWebviewUri(vscode.Uri.file(abs)).toString() });
    let timer: NodeJS.Timeout | undefined;
    let edits: Promise<void> = Promise.resolve();
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        clearTimeout(timer);
        timer = setTimeout(send, 120);
      }),
      webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ready') send();
        if (msg.type === 'op') {
          if (readOnly) return;
          // One edit at a time: each operation must start from the text the previous one produced.
          edits = edits.then(async () => {
            try {
              const text = applyDesignOp(document.getText(), msg.op as DesignOp);
              if (text === document.getText()) return;
              const edit = new vscode.WorkspaceEdit();
              edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
              await vscode.workspace.applyEdit(edit);
            } catch (e) {
              void vscode.window.showErrorMessage(`Cannot update design.yaml: ${(e as Error).message}`);
            }
          });
        }
        // Theme images and fonts are stored in the template's own assets folder.
        if (msg.type === 'saveImage' && !readOnly) {
          const ext = extname(String(msg.name)) || '.png';
          const abs = join(designDir, ASSETS_DIR, `${slugify(basename(String(msg.name), ext)) || 'image'}${ext}`);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, Buffer.from(String(msg.data), 'base64'));
          reply(msg, abs);
        }
        if (msg.type === 'pickImage' && !readOnly) {
          const font = msg.accept === 'font';
          const sub = font ? join(ASSETS_DIR, 'fonts') : ASSETS_DIR;
          const filters: Record<string, string[]> = font ? { Fonts: ['woff2', 'woff', 'ttf', 'otf'] } : { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] };
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters, defaultUri: vscode.Uri.file(join(designDir, sub)) });
          if (!picked?.[0]) return;
          let abs = picked[0].fsPath;
          if (relative(designDir, abs).startsWith('..')) {
            const dest = join(designDir, sub, basename(abs));
            mkdirSync(dirname(dest), { recursive: true });
            await vscode.workspace.fs.copy(picked[0], vscode.Uri.file(dest), { overwrite: false }).then(undefined, () => undefined);
            abs = dest;
          }
          reply(msg, abs);
        }
        // Custom template.html: insert a placeholder where the cursor is.
        if (msg.type === 'insertPlaceholder') await this.insertPlaceholder(document, String(msg.text));
        if (msg.type === 'command') {
          if (msg.command === 'openAsText') await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          else if (msg.command === 'openTemplate') {
            const d = this.load(document).design;
            if (d) await vscode.window.showTextDocument(vscode.Uri.file(d.templatePath));
          } else await vscode.commands.executeCommand(msg.command, ...(msg.args ?? []));
        }
      }),
    );
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
  }

  private layoutState(design: Design, raw: RawDesign, parent: Design | undefined) {
    const partials = templatePartials(design);
    const own = Array.isArray((raw as { layout?: unknown }).layout);
    const supported = supportsLayout(design, this.projects.read);
    const scalar = (f: FieldDef) => ['enum', 'boolean', 'string', 'user', 'date', 'number'].includes(f.type);
    const report = design.reportFields.map((f) => ({ id: f.id, label: f.label, type: f.type, snippet: placeholderFor(f) }));
    return {
      supported,
      own,
      inheritedFrom: !own && design.layout ? parent?.name ?? design.parents[0]?.id : undefined,
      blocks: design.layout ?? defaultLayout(design, partials),
      defaults: defaultLayout(design, partials),
      kinds: LAYOUT_BLOCKS,
      // Hook files that make sense as "Custom HTML" blocks (not the building blocks of the template).
      partials: partials.filter((f) => !['template.html', 'layout.html', 'cover.html', 'collection.html', 'collection-body.html', 'item.html', 'finding.html'].includes(f) && !f.startsWith('item-')),
      report,
      collections: design.collections.map((c) => ({
        id: c.id,
        label: c.label,
        itemVar: c.itemVar,
        chartFields: [...(c.hasSeverity ? [{ id: 'severity', label: 'Severity' }] : []), ...c.fields.filter((f) => scalar(f) && f.id !== 'severity' && f.id !== c.titleField).map((f) => ({ id: f.id, label: f.label }))],
        fields: c.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, snippet: placeholderFor(f, c.itemVar) })),
      })),
      ownTemplate: design.templatePath.startsWith(design.dir + sep) ? basename(design.templatePath) : undefined,
    };
  }

  private async insertPlaceholder(document: vscode.TextDocument, text: string): Promise<void> {
    const design = this.load(document).design;
    const own = design && design.templatePath.startsWith(design.dir + sep) ? design.templatePath : undefined;
    if (!own) {
      void vscode.window.showWarningMessage('This template has no template.html of its own. Use "Copy Template with HTML and CSS" to get one you can edit.');
      return;
    }
    const uri = vscode.Uri.file(own);
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === own);
    const editor = visible ?? (await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }));
    await editor.edit((b) => b.replace(editor.selection, text));
    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
  }

  private roots(document: vscode.TextDocument): string[] {
    const dir = dirname(document.uri.fsPath);
    const project = this.projects.projectOf(dir) ?? this.projects.active;
    const roots = [dirname(dir), ...this.projects.designRoots(project)];
    return [...new Set(roots)];
  }

  private load(document: vscode.TextDocument): { design?: Design; parent?: Design; error?: string; raw: RawDesign } {
    const file = document.uri.fsPath;
    const read = (p: string) => (p === file ? document.getText() : this.projects.read(p));
    let raw: RawDesign = {};
    try {
      raw = (parse(document.getText()) ?? {}) as RawDesign;
    } catch (e) {
      return { raw, error: (e as Error).message };
    }
    const roots = this.roots(document);
    let design: Design | undefined;
    let parent: Design | undefined;
    let error: string | undefined;
    try {
      design = loadDesign(roots, basename(dirname(file)), read);
    } catch (e) {
      error = (e as Error).message;
    }
    try {
      if (raw.extends) parent = loadDesign(roots, raw.extends, read);
    } catch {
      /* reported through `error` */
    }
    return { design, parent, error, raw };
  }

  private state(document: vscode.TextDocument) {
    const { design, parent, error, raw } = this.load(document);
    const own = (scope: string): Record<string, unknown> => {
      if (scope === '_report') return raw.report_fields ?? {};
      const c = raw.collections?.[scope]?.fields ?? {};
      return scope === 'findings' ? { ...(raw.finding_fields ?? {}), ...c } : c;
    };
    const rows = (scope: string, fields: FieldDef[], parentFields: FieldDef[] | undefined): FieldRow[] =>
      fields.map((f) => {
        const inParent = parentFields?.some((p) => p.id === f.id);
        const ownSpec = own(scope)[f.id];
        return { ...f, origin: inParent ? (ownSpec !== undefined ? 'override' : 'inherited') : 'own' };
      });
    const removed = (scope: string, parentFields: FieldDef[] | undefined) =>
      Object.entries(own(scope))
        .filter(([, v]) => v === null || v === false)
        .map(([id]) => parentFields?.find((p) => p.id === id))
        .filter((f): f is FieldDef => !!f);

    const collections: CollectionRow[] = (design?.collections ?? []).map((c) => {
      const pc = parent?.collections.find((x) => x.id === c.id);
      const ownSpec = raw.collections?.[c.id] ?? (c.id === 'findings' && raw.finding_fields ? {} : undefined);
      return { ...c, origin: pc ? (ownSpec ? 'override' : 'inherited') : 'own', fields: rows(c.id, c.fields, pc?.fields), removedFields: removed(c.id, pc?.fields) };
    });
    const removedCollections = Object.entries(raw.collections ?? {})
      .filter(([, v]) => v === null)
      .map(([id]) => parent?.collections.find((c) => c.id === id))
      .filter((c): c is CollectionDef => !!c)
      .map((c) => ({ id: c.id, label: c.label }));

    const selfId = basename(dirname(document.uri.fsPath));
    return {
      file: vscode.workspace.asRelativePath(document.uri),
      id: selfId,
      readOnly: document.uri.fsPath.startsWith(this.projects.builtinDesignsDir + sep),
      error,
      name: raw.name ?? '',
      description: raw.description ?? '',
      extends: raw.extends ?? '',
      designs: listDesigns(this.roots(document))
        .map((d) => d.id)
        .filter((id) => id !== selfId),
      types: FIELD_TYPES.filter((t) => !['color', 'font', 'range'].includes(t)),
      report: rows('_report', design?.reportFields ?? [], parent?.reportFields),
      removedReport: removed('_report', parent?.reportFields),
      collections,
      removedCollections,
      hasTemplate: !!design && !!design.templatePath,
      templateFile: design ? join(...design.templatePath.split(sep).slice(-2)) : undefined,
      theme: raw.theme && typeof raw.theme === 'object' ? raw.theme : {},
      themeFields: themeFieldsFor(design),
      // What the template gets when it sets nothing: the built-in defaults and its parents' theme.
      themeDefaults: themeDefaultsFor(design, parent?.theme),
      layout: design ? this.layoutState(design, raw, parent) : undefined,
    };
  }
}
