import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function nonce(): string {
  return randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
}

/** Shell page for a webview bundle in dist/webview/<name>.js (+ .css). */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, name: 'form' | 'preview' | 'design' | 'pdf', title: string, extraCsp = ''): string {
  const n = nonce();
  const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p)).toString();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: https: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data: blob:`,
    `script-src 'nonce-${n}' ${webview.cspSource}`,
    `frame-src ${webview.cspSource} 'self' data: blob:`,
    `connect-src ${webview.cspSource}`,
    extraCsp,
  ]
    .filter(Boolean)
    .join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${asset('media', 'vendor', 'codicon.css')}">
<link rel="stylesheet" href="${asset('dist', 'webview', `${name}.css`)}">
</head>
<body>
<div id="app" data-nonce="${n}" data-vendor="${asset('media', 'vendor')}"></div>
<script nonce="${n}" src="${asset('dist', 'webview', `${name}.js`)}"></script>
</body>
</html>`;
}
