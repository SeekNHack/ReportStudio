import * as vscode from 'vscode';
import { BuildService } from './build';
import { registerCommands } from './commands';
import { registerCompletions } from './completions';
import { DesignEditorProvider } from './designEditor';
import { DiagnosticsService } from './diagnostics';
import { registerExports } from './exports';
import { FormEditorProvider } from './formEditor';
import { PreviewPanel } from './preview';
import { ProjectService } from './projects';
import { FindingsTree, LibraryTree, ReportTree } from './trees';

export async function activate(context: vscode.ExtensionContext): Promise<{ projects: ProjectService }> {
  const projects = new ProjectService(context);
  const diagnostics = new DiagnosticsService(projects);
  const builds = new BuildService(context, projects, diagnostics);
  const preview = new PreviewPanel(context, projects);
  context.subscriptions.push(projects, diagnostics, builds, preview);

  const reportTree = new ReportTree(projects, builds);
  const findingsTree = new FindingsTree(projects, diagnostics);
  const libraryTree = new LibraryTree(projects);
  const findingsView = vscode.window.createTreeView('reportStudio.findings', { treeDataProvider: findingsTree, showCollapseAll: true });
  findingsTree.view = findingsView;
  context.subscriptions.push(
    vscode.window.createTreeView('reportStudio.report', { treeDataProvider: reportTree }),
    findingsView,
    vscode.window.createTreeView('reportStudio.library', { treeDataProvider: libraryTree }),
  );

  const formOptions = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('reportStudio.findingForm', new FormEditorProvider(context, projects, diagnostics, 'finding'), formOptions),
    vscode.window.registerCustomEditorProvider('reportStudio.reportForm', new FormEditorProvider(context, projects, diagnostics, 'report'), formOptions),
    vscode.window.registerCustomEditorProvider('reportStudio.designEditor', new DesignEditorProvider(context, projects), formOptions),
  );

  registerCommands(context, projects, builds, preview, () => {
    reportTree.refresh();
    findingsTree.refresh();
    libraryTree.refresh();
  });
  registerExports(context, projects);
  registerCompletions(context, projects);

  await projects.discover();
  findingsTree.refresh();
  if (projects.active) diagnostics.validate(projects.active);
  return { projects };
}

export function deactivate(): void {}
