import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { build, type BuildOutput } from '../core/build';
import { ChromeNotFoundError } from '../core/pdf';
import type { DiagnosticsService } from './diagnostics';
import { isRemoteUi, PdfViewer } from './pdfViewer';
import type { ProjectService } from './projects';

/**
 * Builds PDF/HTML from the GUI: status bar button, commands, editor/view
 * title buttons and a `reportStudio` task type (Terminal → Run Build Task).
 */
export class BuildService implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('Report Studio');
  private readonly status = vscode.window.createStatusBarItem('reportStudio.build', vscode.StatusBarAlignment.Left, 100);
  private running = false;
  private readonly disposables: vscode.Disposable[] = [];
  private lastFile = new Map<string, string>();
  private readonly lastEmitter = new vscode.EventEmitter<void>();
  private readonly viewer: PdfViewer;
  readonly onDidBuild = this.lastEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: ProjectService,
    private readonly diagnostics: DiagnosticsService,
  ) {
    this.viewer = new PdfViewer(context);
    this.status.name = 'Report Studio: Build PDF';
    this.status.command = 'reportStudio.buildPdf';
    this.idle();
    this.disposables.push(
      this.status,
      this.output,
      this.viewer,
      vscode.commands.registerCommand('reportStudio.openOutput', (file: string) => this.open(file)),
      projects.onDidChangeProjects(() => this.idle()),
      vscode.tasks.registerTaskProvider('reportStudio', {
        provideTasks: () => this.tasks(),
        resolveTask: (task) => this.toTask(task.definition as TaskDef, task.scope),
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!vscode.workspace.getConfiguration('reportStudio').get<boolean>('buildOnSave')) return;
        const dir = projects.projectOf(doc.uri.fsPath);
        if (dir && !this.running) void this.run('pdf', dir, { silent: true });
      }),
    );
  }

  lastOutput(dir: string): string | undefined {
    return this.lastFile.get(dir);
  }

  private idle(): void {
    const dir = this.projects.active;
    if (!dir) return this.status.hide();
    this.status.text = '$(file-pdf) Build PDF';
    this.status.tooltip = new vscode.MarkdownString(`**Build PDF** for \`${this.projects.displayName(dir)}\`\n\nCtrl+Alt+B`);
    this.status.backgroundColor = undefined;
    this.status.show();
  }

  async run(format: 'pdf' | 'html', dir = this.projects.active, opts: { silent?: boolean; log?: (s: string) => void } = {}): Promise<BuildOutput | undefined> {
    if (!dir) {
      const pick = await vscode.window.showWarningMessage('No report project found in this workspace.', 'Create Report Project');
      if (pick) await vscode.commands.executeCommand('reportStudio.newProject');
      return undefined;
    }
    if (this.running) {
      void vscode.window.showInformationMessage('A build is already running.');
      return undefined;
    }
    this.running = true;
    this.status.text = '$(sync~spin) Building PDF…';
    const cfg = vscode.workspace.getConfiguration('reportStudio');
    const log = (s: string) => {
      this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`);
      opts.log?.(s);
    };
    try {
      const result = await vscode.window.withProgress(
        { location: opts.silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: `Building ${format.toUpperCase()}…`, cancellable: false },
        () =>
          build({
            projectDir: dir,
            extensionRoot: this.context.extensionPath,
            format,
            outDir: cfg.get<string>('outputDir') || 'out',
            designsPath: this.projects.extraDesignsPath(),
            chromePath: cfg.get<string>('chromePath') || undefined,
            read: this.projects.read,
            log,
          }),
      );
      this.lastFile.set(dir, result.file);
      this.lastEmitter.fire();
      this.diagnostics.set(dir, result.issues);
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      const warnings = result.issues.filter((i) => i.severity === 'warning').length;
      const summary = errors + warnings ? ` with ${errors ? `${errors} error(s)` : ''}${errors && warnings ? ' and ' : ''}${warnings ? `${warnings} warning(s)` : ''}` : '';
      const reloaded = format === 'pdf' && this.viewer.refresh(result.file);
      if (format === 'pdf' && cfg.get<boolean>('openAfterBuild') && !opts.silent && !reloaded) await this.open(result.file);
      if (!opts.silent) {
        const actions = [format === 'pdf' ? 'Open PDF' : 'Open HTML', 'Show in Folder', ...(summary ? ['Show Problems'] : [])];
        void vscode.window.showInformationMessage(`Built ${vscode.workspace.asRelativePath(result.file)}${summary}.`, ...actions).then((a) => {
          if (a === 'Open PDF' || a === 'Open HTML') void this.open(result.file);
          if (a === 'Show in Folder') void vscode.commands.executeCommand(isRemoteUi() ? 'revealInExplorer' : 'revealFileInOS', vscode.Uri.file(result.file));
          if (a === 'Show Problems') void vscode.commands.executeCommand('workbench.actions.view.problems');
        });
      }
      return result;
    } catch (e) {
      log(`Build failed: ${(e as Error).stack ?? e}`);
      if (e instanceof ChromeNotFoundError) {
        const a = await vscode.window.showErrorMessage(e.message, 'Set Chrome Path', 'Export HTML Instead');
        if (a === 'Set Chrome Path') void vscode.commands.executeCommand('workbench.action.openSettings', 'reportStudio.chromePath');
        if (a === 'Export HTML Instead') {
          this.running = false;
          return this.run('html', dir);
        }
      } else {
        const a = await vscode.window.showErrorMessage(`Build failed: ${(e as Error).message}`, 'Show Log');
        if (a) this.output.show();
      }
      return undefined;
    } finally {
      this.running = false;
      this.idle();
    }
  }

  async open(file: string): Promise<void> {
    if (!existsSync(file)) return;
    const viewer = vscode.workspace.getConfiguration('reportStudio').get<string>('pdfViewer') ?? 'auto';
    const builtin = viewer === 'builtin' || (viewer === 'auto' && isRemoteUi());
    if (file.endsWith('.pdf') && builtin) return this.viewer.show(file);
    if (isRemoteUi()) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
      return;
    }
    await vscode.env.openExternal(vscode.Uri.file(file));
  }

  private tasks(): vscode.Task[] {
    return this.projects.projects.flatMap((dir) =>
      (['pdf', 'html'] as const).map((format) => this.toTask({ type: 'reportStudio', format, project: dir }, vscode.TaskScope.Workspace)),
    );
  }

  private toTask(def: TaskDef, scope: vscode.TaskScope | vscode.WorkspaceFolder | undefined): vscode.Task {
    const name = `build ${def.format.toUpperCase()}${def.project && this.projects.projects.length > 1 ? ` (${this.projects.displayName(def.project)})` : ''}`;
    const task = new vscode.Task(
      def,
      scope ?? vscode.TaskScope.Workspace,
      name,
      'Report Studio',
      new vscode.CustomExecution(async () => new BuildTerminal(this, def)),
    );
    task.group = vscode.TaskGroup.Build;
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true };
    return task;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

interface TaskDef extends vscode.TaskDefinition {
  format: 'pdf' | 'html';
  project?: string;
}

class BuildTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;
  constructor(
    private readonly service: BuildService,
    private readonly def: TaskDef,
  ) {}
  open(): void {
    void this.service
      .run(this.def.format, this.def.project, { silent: true, log: (s) => this.writeEmitter.fire(`${s}\r\n`) })
      .then((r) => {
        for (const i of r?.issues ?? []) this.writeEmitter.fire(`${i.severity}: ${vscode.workspace.asRelativePath(i.file)}${i.line ? `:${i.line}` : ''} ${i.message}\r\n`);
        this.closeEmitter.fire(r ? 0 : 1);
      });
  }
  close(): void {}
}
