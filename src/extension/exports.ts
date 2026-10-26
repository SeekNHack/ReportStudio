import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { outputName } from '../core/build';
import { EXPORT_FORMATS, exportProject, type ExportFormat } from '../core/export';
import { resolveTheme } from '../core/theme';
import { isRemoteUi } from './pdfViewer';
import type { ProjectService } from './projects';

/** "Export Data…": findings and every collection as Excel, CSV, JSON or SARIF. */
export function registerExports(context: vscode.ExtensionContext, projects: ProjectService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('reportStudio.exportData', async (preset?: unknown) => {
      const dir = projects.active;
      const loaded = dir ? projects.load(dir) : undefined;
      if (!dir || !loaded) {
        void vscode.window.showWarningMessage('No report project in this workspace.');
        return;
      }
      const design = loaded.design;
      if (!design) {
        void vscode.window.showErrorMessage(loaded.error?.message ?? 'The design of this project cannot be loaded.');
        return;
      }
      const hasSeverity = design.collections.some((c) => c.hasSeverity);
      let format = typeof preset === 'string' ? (preset as ExportFormat) : undefined;
      if (!format) {
        const pick = await vscode.window.showQuickPick(
          EXPORT_FORMATS.filter((f) => f.id !== 'sarif' || hasSeverity).map((f) => ({ label: f.label, description: `.${f.ext}`, detail: f.detail, id: f.id })),
          { title: 'Export Data', placeHolder: 'Format — placeholders are resolved, Markdown is kept as text' },
        );
        if (!pick) return;
        format = pick.id;
      }
      let collection: string | undefined;
      if (format === 'csv') {
        const cols = design.collections.filter((c) => loaded.project.items[c.id]?.length);
        if (!cols.length) {
          void vscode.window.showInformationMessage('There are no entries to export yet.');
          return;
        }
        if (cols.length > 1) {
          const pick = await vscode.window.showQuickPick(
            cols.map((c) => ({ label: `$(${c.icon}) ${c.label}`, description: `${loaded.project.items[c.id].length} entries`, id: c.id })),
            { title: 'Export CSV', placeHolder: 'Which collection?' },
          );
          if (!pick) return;
          collection = pick.id;
        } else collection = cols[0].id;
      }

      const ext = EXPORT_FORMATS.find((f) => f.id === format)!.ext;
      const outDir = join(dir, vscode.workspace.getConfiguration('reportStudio').get<string>('outputDir') || 'out');
      const file = join(outDir, `${outputName(loaded.project)}${collection && collection !== 'findings' ? `-${collection}` : ''}.${ext}`);
      try {
        const accent = String(resolveTheme(design.theme, loaded.project.report.theme as Record<string, unknown> | undefined).accent ?? '');
        const content = exportProject(loaded.project, design, format, { collection, accent });
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      } catch (e) {
        void vscode.window.showErrorMessage(`Export failed: ${(e as Error).message}`);
        return;
      }
      const uri = vscode.Uri.file(file);
      const text = format !== 'xlsx';
      const actions = [...(text ? ['Open'] : isRemoteUi() ? [] : ['Open']), isRemoteUi() ? 'Reveal in Explorer' : 'Show in Folder'];
      const a = await vscode.window.showInformationMessage(`Exported ${basename(file)}${isRemoteUi() ? ' — right-click it in the Explorer and choose Download to save it locally.' : ''}`, ...actions);
      if (a === 'Open') {
        if (text) await vscode.window.showTextDocument(uri, { preview: false });
        else void vscode.env.openExternal(uri);
      }
      if (a === 'Show in Folder') void vscode.commands.executeCommand('revealFileInOS', uri);
      if (a === 'Reveal in Explorer') void vscode.commands.executeCommand('revealInExplorer', uri);
    }),
  );
}
