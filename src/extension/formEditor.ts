import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { readForAnnotation, saveAnnotation, type AnnotationSidecar } from '../core/annotations';
import { listDesigns, markdownFieldIds, SECTION_TYPES } from '../core/design';
import { findingValues, parseFinding, serializeFinding, setFindingValue, setYamlValue } from '../core/findingFile';
import { ASSETS_DIR, collectionOfFile, numberFor, reportYamlDocument, slugify, sortItems } from '../core/project';
import { resolveTheme, THEME_FIELDS } from '../core/theme';
import type { CollectionDef, Design, FieldDef } from '../core/types';
import type { DiagnosticsService } from './diagnostics';
import type { ProjectService } from './projects';
import { webviewHtml } from './webviewHtml';

type Kind = 'finding' | 'report';

/** Placeholder names offered by autocomplete inside Markdown fields. */
const COMPUTED_FINDING = ['number', 'severity', 'score'];
const STATS = ['total', 'fixed', 'open', 'counts.critical', 'counts.high', 'counts.medium', 'counts.low', 'counts.info'];

/**
 * Form editor for finding files and report.yaml. The text document stays the
 * source of truth: every form change is written back as a text edit, so undo,
 * dirty state, git and "Reopen with text editor" behave as usual.
 */
export class FormEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: ProjectService,
    private readonly diagnostics: DiagnosticsService,
    private readonly kind: Kind,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const dir = this.projects.projectOf(document.uri.fsPath);
    const webview = panel.webview;
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')];
    if (dir) roots.push(vscode.Uri.file(dir));
    webview.options = { enableScripts: true, localResourceRoots: roots };
    webview.html = webviewHtml(webview, this.context.extensionUri, 'form', `${this.kind === 'report' ? 'Report' : 'Finding'} form`);

    let lastWritten: string | undefined;
    let lastDesignKey = '';
    const disposables: vscode.Disposable[] = [];

    const send = (full: boolean) => {
      const state = this.state(document, dir, webview);
      const designKey = JSON.stringify(state.fields);
      if (full || designKey !== lastDesignKey) {
        lastDesignKey = designKey;
        void webview.postMessage({ type: 'init', ...state });
      } else {
        void webview.postMessage({ type: 'values', values: state.values, meta: state.meta, issues: state.issues });
      }
    };

    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString() || !e.contentChanges.length) return;
        if (document.getText() === lastWritten) return; // our own edit
        send(false);
      }),
      // The design (fields) or other findings (numbering) may change.
      this.projects.onDidChange((d) => d === (dir ?? this.projects.active) && send(false)),
      this.diagnostics.onDidChange(() => send(false)),
      webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case 'ready':
            send(true);
            break;
          case 'change': {
            const text = this.applyChange(document, msg.key as string, msg.value, dir);
            if (text === undefined || text === document.getText()) break;
            lastWritten = text;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
            await vscode.workspace.applyEdit(edit);
            if (msg.key === 'design') send(true);
            break;
          }
          case 'saveImage': {
            const rel = this.saveImage(dir ?? dirname(document.uri.fsPath), msg.name as string, msg.data as string);
            void webview.postMessage({ type: 'imageSaved', requestId: msg.requestId, path: rel, url: webview.asWebviewUri(vscode.Uri.file(join(dir ?? '', rel))).toString() });
            break;
          }
          case 'readImage': {
            const r = readForAnnotation(dir ?? dirname(document.uri.fsPath), String(msg.path ?? ''));
            void webview.postMessage({ type: 'imageRead', requestId: msg.requestId, ...r });
            break;
          }
          case 'saveAnnotated': {
            let r: { path?: string; error?: string };
            try {
              r = saveAnnotation(dir ?? dirname(document.uri.fsPath), {
                path: String(msg.path),
                source: String(msg.source),
                data: String(msg.data),
                doc: msg.doc as AnnotationSidecar,
                keep: msg.keep !== false,
                editedFile: document.uri.fsPath,
              });
            } catch (e) {
              r = { error: (e as Error).message };
            }
            void webview.postMessage({ type: 'annotationSaved', requestId: msg.requestId, ...r });
            break;
          }
          case 'pickImage': {
            const font = msg.accept === 'font';
            const filters: Record<string, string[]> = font ? { Fonts: ['woff2', 'woff', 'ttf', 'otf'] } : { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] };
            const sub = font ? join(ASSETS_DIR, 'fonts') : ASSETS_DIR;
            const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters, defaultUri: dir ? vscode.Uri.file(join(dir, sub)) : undefined });
            if (!picked?.[0]) break;
            let target = picked[0].fsPath;
            if (dir && relative(dir, target).startsWith('..')) {
              const dest = join(dir, sub, basename(target));
              mkdirSync(dirname(dest), { recursive: true });
              await vscode.workspace.fs.copy(picked[0], vscode.Uri.file(dest), { overwrite: false }).then(undefined, () => undefined);
              target = dest;
            }
            const rel = dir ? relative(dir, target).split('\\').join('/') : target;
            void webview.postMessage({ type: 'imageSaved', requestId: msg.requestId, path: rel, url: webview.asWebviewUri(vscode.Uri.file(target)).toString() });
            break;
          }
          case 'command':
            if (msg.command === 'openAsText') await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
            else await vscode.commands.executeCommand(msg.command as string, ...(msg.args ?? []));
            break;
          case 'openLink':
            void vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
            break;
        }
      }),
    );
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
  }

  /** Collection of an item file: its folder inside the project; library entries use "findings". */
  private collectionFor(file: string, dir: string | undefined, design: Design | undefined): CollectionDef | undefined {
    if (!design) return undefined;
    const id = dir ? collectionOfFile(dir, file) : undefined;
    return design.collections.find((c) => c.id === id) ?? (dir ? undefined : (design.collections.find((c) => c.id === 'findings') ?? design.collections[0]));
  }

  private fieldsFor(file: string, dir: string | undefined, design: Design | undefined): FieldDef[] {
    if (this.kind === 'report') return design?.reportFields ?? [];
    return this.collectionFor(file, dir, design)?.fields ?? [];
  }

  private state(document: vscode.TextDocument, dir: string | undefined, webview: vscode.Webview) {
    const loaded = this.projects.load(dir ?? this.projects.active);
    const design = loaded?.design;
    const fields = this.fieldsFor(document.uri.fsPath, dir, design);
    const collection = this.kind === 'finding' ? this.collectionFor(document.uri.fsPath, dir, design) : undefined;
    let values: Record<string, unknown> = {};
    let parseError: string | undefined;
    try {
      values = this.kind === 'report' ? ((reportYamlDocument(document.getText()).toJS() as Record<string, unknown>) ?? {}) : findingValues(parseFinding(document.getText()));
    } catch (e) {
      parseError = (e as Error).message;
    }
    let number: string | undefined;
    if (collection && design && loaded) {
      const sorted = sortItems(loaded.project.items[collection.id] ?? [], collection, design);
      const i = sorted.findIndex((f) => f.file === document.uri.fsPath);
      if (i >= 0 && collection.prefix) number = numberFor(collection, i, sorted.length);
    }
    const designs = dir ? listDesigns(this.projects.designRoots(dir)).map((d) => ({ id: d.id, builtin: this.projects.isBuiltin(join(d.dir, 'design.yaml')) })) : [];
    return {
      kind: this.kind,
      fields,
      values,
      issues: this.diagnostics.issuesFor(document.uri.fsPath).map((i) => ({ field: i.field, message: i.message, severity: i.severity })),
      meta: {
        file: vscode.workspace.asRelativePath(document.uri),
        projectName: dir ? this.projects.displayName(dir) : undefined,
        inProject: !!dir,
        library: document.uri.fsPath.split(sep).includes('library'),
        designId: loaded?.project.designId,
        designName: design?.name,
        designError: loaded?.error?.message,
        designs,
        severities: collection && !collection.hasSeverity ? [] : (design?.severities ?? []),
        collection: collection && { id: collection.id, label: collection.label, itemLabel: collection.itemLabel, itemVar: collection.itemVar, titleField: collection.titleField, hasSeverity: collection.hasSeverity },
        collectionMissing: this.kind === 'finding' && !!design && !collection,
        themeFields: this.kind === 'report' ? THEME_FIELDS : [],
        themeDefaults: this.kind === 'report' ? resolveTheme(design?.theme) : {},
        number,
        parseError,
        projectBase: dir ? webview.asWebviewUri(vscode.Uri.file(dir)).toString() : undefined,
        placeholders: {
          report: design?.reportFields.map((f) => ({ id: f.id, label: f.label, type: f.type })) ?? [],
          finding: [...fields.map((f) => ({ id: f.id, label: f.label, type: f.type })), ...COMPUTED_FINDING.map((id) => ({ id, label: id, type: 'computed' }))],
          itemVar: collection?.itemVar ?? 'finding',
          collections: design?.collections.map((c) => c.id) ?? [],
          stats: STATS,
        },
      },
    };

  }

  /** Returns the new document text after setting `key`, or undefined if it cannot be parsed. */
  private applyChange(document: vscode.TextDocument, key: string, value: unknown, dir: string | undefined): string | undefined {
    const loaded = this.projects.load(dir ?? this.projects.active);
    const fields = this.fieldsFor(document.uri.fsPath, dir, loaded?.design);
    const field = fields.find((f) => f.id === key);
    try {
      if (this.kind === 'report') {
        const doc = reportYamlDocument(document.getText());
        if (doc.errors.length) return undefined;
        if (key.startsWith('theme.')) {
          const sub = key.slice('theme.'.length);
          if (value === undefined || value === null || value === '') doc.deleteIn(['theme', sub]);
          else doc.setIn(['theme', sub], value);
          const theme = doc.get('theme') as { items?: unknown[] } | undefined;
          if (theme && Array.isArray(theme.items) && !theme.items.length) doc.delete('theme');
          return doc.toString({ lineWidth: 0 });
        }
        setYamlValue(doc, key, value);
        return doc.toString({ lineWidth: 0 });
      }
      const parsed = parseFinding(document.getText());
      if (parsed.front.errors.length) return undefined;
      setFindingValue(parsed, key, value, !!field && SECTION_TYPES.includes(field.type), markdownFieldIds(fields));
      return serializeFinding(parsed);
    } catch {
      return undefined;
    }
  }

  private saveImage(dir: string, name: string, base64: string): string {
    const ext = extname(name) || '.png';
    const stem = slugify(basename(name, ext)) || 'image';
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const rel = `${ASSETS_DIR}/${stem === 'image' ? `screenshot-${stamp}` : stem}${ext}`;
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(base64, 'base64'));
    return rel;
  }
}
