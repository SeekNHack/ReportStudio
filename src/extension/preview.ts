import { statSync } from 'node:fs';
import * as vscode from 'vscode';
import { renderReport } from '../core/render';
import type { ProjectService } from './projects';
import { webviewHtml } from './webviewHtml';

/**
 * Live paged preview. Renders the same HTML used for the PDF and lets the
 * webview paginate it with Paged.js inside a sandboxed iframe.
 */
export class PreviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private dir: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private version = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: ProjectService,
  ) {
    this.disposables.push(
      projects.onDidChange((dir) => {
        if (!this.panel) return;
        if (dir === projects.active && dir !== this.dir) this.dir = dir;
        if (dir !== this.dir) return;
        if (!vscode.workspace.getConfiguration('reportStudio').get<boolean>('preview.autoRefresh')) return;
        this.schedule();
      }),
    );
  }

  show(dir = this.projects.active): void {
    if (!dir) {
      void vscode.window.showWarningMessage('Open a report project first.');
      return;
    }
    this.dir = dir;
    if (this.panel) {
      this.panel.reveal(undefined, true);
      this.resetRoots();
      this.render();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('reportStudio.preview', 'Report Preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: this.roots(),
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = webviewHtml(this.panel.webview, this.context.extensionUri, 'preview', 'Report Preview');
    this.panel.onDidDispose(() => (this.panel = undefined), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
        case 'refresh':
          this.render();
          break;
        case 'openFinding': {
          const f = Object.values(this.projects.load(this.dir)?.project.items ?? {})
            .flat()
            .find((x) => x.id === msg.id);
          if (f) await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(f.file), 'reportStudio.findingForm', vscode.ViewColumn.One);
          break;
        }
        case 'openIssue':
          await vscode.window.showTextDocument(vscode.Uri.file(msg.file), { selection: new vscode.Range((msg.line ?? 1) - 1, 0, (msg.line ?? 1) - 1, 0), viewColumn: vscode.ViewColumn.One });
          break;
        case 'command':
          await vscode.commands.executeCommand(msg.command);
          break;
      }
    }, null, this.disposables);
  }

  private roots(): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'media'), vscode.Uri.joinPath(this.context.extensionUri, 'dist')];
    if (this.dir) roots.push(vscode.Uri.file(this.dir), ...this.projects.designRoots(this.dir).map((d) => vscode.Uri.file(d)));
    return roots;
  }

  private resetRoots(): void {
    if (this.panel) this.panel.webview.options = { ...this.panel.webview.options, localResourceRoots: this.roots() };
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), 250);
  }

  render(): void {
    const panel = this.panel;
    if (!panel || !this.dir) return;
    const loaded = this.projects.load(this.dir);
    if (!loaded) return;
    const version = ++this.version;
    if (!loaded.design) {
      void panel.webview.postMessage({ type: 'error', version, message: loaded.error?.message ?? 'Cannot load design', file: loaded.error?.file });
      return;
    }
    try {
      const t0 = Date.now();
      const result = renderReport(loaded.project, loaded.design, {
        read: this.projects.read,
        // The modification time busts the preview's resource cache when an image changes.
        assetUrl: (p) => panel.webview.asWebviewUri(vscode.Uri.file(p)).with({ query: `v=${mtime(p)}` }).toString(),
      });
      panel.title = `Preview: ${result.title}`;
      void panel.webview.postMessage({
        type: 'render',
        version,
        body: result.body,
        css: result.css,
        title: result.title,
        design: loaded.design.name,
        issues: result.issues,
        renderMs: Date.now() - t0,
        lang: String(loaded.project.report.language ?? 'en'),
      });
    } catch (e) {
      void panel.webview.postMessage({ type: 'error', version, message: (e as Error).message });
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function mtime(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}
