import { basename, dirname, join, sep } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { listDesigns, loadDesign, type RawDesign } from '../core/design';
import { applyDesignOp, type DesignOp } from '../core/designEdit';
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
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    webview.html = webviewHtml(webview, this.context.extensionUri, 'design', 'Design editor');
    const disposables: vscode.Disposable[] = [];
    const send = () => void webview.postMessage({ type: 'state', ...this.state(document) });
    let timer: NodeJS.Timeout | undefined;
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        clearTimeout(timer);
        timer = setTimeout(send, 120);
      }),
      webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'ready') send();
        if (msg.type === 'op') {
          try {
            const text = applyDesignOp(document.getText(), msg.op as DesignOp);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
            await vscode.workspace.applyEdit(edit);
          } catch (e) {
            void vscode.window.showErrorMessage(`Cannot update design.yaml: ${(e as Error).message}`);
          }
        }
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

  private roots(document: vscode.TextDocument): string[] {
    const dir = dirname(document.uri.fsPath);
    const project = this.projects.projectOf(dir) ?? this.projects.active;
    const roots = [dirname(dir), ...(project ? this.projects.designRoots(project) : [this.projects.builtinDesignsDir])];
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
    };
  }
}
