import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import { webviewHtml } from './webviewHtml';

/** True when the system PDF viewer cannot reach the file (code-server, vscode.dev, Remote-SSH, containers…). */
export function isRemoteUi(): boolean {
  return vscode.env.uiKind === vscode.UIKind.Web || !!vscode.env.remoteName;
}

/**
 * Built-in PDF viewer (pdf.js), used where the PDF lives on another machine
 * than the browser/window showing VS Code. Includes a Download button.
 */
export class PdfViewer implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private version = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  show(file: string): void {
    const existing = this.panels.get(file);
    if (existing) {
      existing.reveal();
      this.post(existing, file);
      return;
    }
    const panel = vscode.window.createWebviewPanel('reportStudio.pdf', basename(file), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.file(dirname(file))],
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, 'pdf', basename(file));
    this.panels.set(file, panel);
    panel.onDidDispose(() => this.panels.delete(file));
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') this.post(panel, file);
      if (msg.type === 'reveal') await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
      if (msg.type === 'build') await vscode.commands.executeCommand('reportStudio.buildPdf');
      if (msg.type === 'downloadFailed') {
        const a = await vscode.window.showWarningMessage('The download was blocked by the browser. Right-click the PDF in the Explorer and choose Download.', 'Reveal in Explorer');
        if (a) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
      }
    });
  }

  /** Reloads open viewers after a rebuild. */
  refresh(file: string): boolean {
    const panel = this.panels.get(file);
    if (panel) this.post(panel, file);
    return !!panel;
  }

  private post(panel: vscode.WebviewPanel, file: string): void {
    void panel.webview.postMessage({ type: 'show', url: panel.webview.asWebviewUri(vscode.Uri.file(file)).toString(), name: basename(file), version: ++this.version });
  }

  dispose(): void {
    this.panels.forEach((p) => p.dispose());
  }
}
