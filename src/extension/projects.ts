import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { DesignError, loadDesign } from '../core/design';
import { designRoots, DESIGNS_DIR, loadProject, REPORT_FILE } from '../core/project';
import type { Design, Project, ReadFile } from '../core/types';

export interface Loaded {
  project: Project;
  design?: Design;
  error?: { message: string; file?: string };
}

/**
 * Tracks the report projects (folders with a report.yaml) of the workspace and
 * which one is active, and fires `onDidChange` when any of their files change,
 * including unsaved edits in open editors.
 */
export class ProjectService implements vscode.Disposable {
  private dirs: string[] = [];
  private activeDir: string | undefined;
  private cache = new Map<string, Loaded>();
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  private readonly listEmitter = new vscode.EventEmitter<void>();
  private readonly designsEmitter = new vscode.EventEmitter<void>();
  private designsTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private changedDirs = new Set<string>();

  /** Fired (debounced) with the project dir whose files changed. */
  readonly onDidChange = this.emitter.event;
  readonly onDidChangeProjects = this.listEmitter.event;
  /** Fired (debounced) when a file of a non built-in design changes, is added or removed. */
  readonly onDidChangeDesigns = this.designsEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFs = (uri: vscode.Uri) => {
      if (uri.path.endsWith(`/${REPORT_FILE}`)) void this.discover();
      this.touch(uri.fsPath);
    };
    watcher.onDidCreate(onFs, null, this.disposables);
    watcher.onDidDelete(onFs, null, this.disposables);
    watcher.onDidChange(onFs, null, this.disposables);
    this.disposables.push(
      watcher,
      vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length && this.touch(e.document.uri.fsPath)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()),
      vscode.window.onDidChangeActiveTextEditor((e) => e && this.followFile(e.document.uri.fsPath)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('reportStudio') && this.touchAll()),
    );
  }

  get builtinDesignsDir(): string {
    return join(this.context.extensionPath, 'designs');
  }

  get projects(): string[] {
    return this.dirs;
  }

  get active(): string | undefined {
    return this.activeDir;
  }

  async discover(): Promise<void> {
    const files = await vscode.workspace.findFiles(`**/${REPORT_FILE}`, '**/{node_modules,.git,out,dist}/**', 200);
    this.dirs = files.map((f) => dirname(f.fsPath)).sort();
    const saved = this.context.workspaceState.get<string>('activeProject');
    if (!this.activeDir || !this.dirs.includes(this.activeDir)) {
      this.activeDir = saved && this.dirs.includes(saved) ? saved : this.dirs[0];
    }
    this.cache.clear();
    await vscode.commands.executeCommand('setContext', 'reportStudio.hasProject', this.dirs.length > 0);
    this.listEmitter.fire();
    this.emitter.fire(this.activeDir);
  }

  setActive(dir: string): void {
    if (!this.dirs.includes(dir)) this.dirs = [...this.dirs, dir].sort();
    if (this.activeDir === dir) return;
    this.activeDir = dir;
    void this.context.workspaceState.update('activeProject', dir);
    void vscode.commands.executeCommand('setContext', 'reportStudio.hasProject', true);
    this.listEmitter.fire();
    this.emitter.fire(dir);
  }

  /** Project dir a file belongs to (nearest report.yaml, at most 5 levels up). */
  projectOf(file: string): string | undefined {
    const known = this.dirs.filter((d) => file === d || file.startsWith(d + sep)).sort((a, b) => b.length - a.length)[0];
    if (known) return known;
    let dir = dirname(file);
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(dir, REPORT_FILE))) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return undefined;
  }

  /** Reads a file, preferring the unsaved content of an open editor. */
  readonly read: ReadFile = (path) => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === path);
    return doc ? doc.getText() : readFileSync(path, 'utf8');
  };

  extraDesignsPath(): string | undefined {
    const extra = vscode.workspace.getConfiguration('reportStudio').get<string>('designsPath');
    return extra ? this.resolveSetting(extra) : undefined;
  }

  /** `designs/` of every workspace folder: templates shared by all the engagements. */
  workspaceDesignsDirs(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => join(f.uri.fsPath, DESIGNS_DIR));
  }

  /** Where new templates are created, undefined without a workspace folder. */
  get templatesDir(): string | undefined {
    return this.workspaceDesignsDirs()[0];
  }

  /** Where new engagements are created (`reportStudio.engagementsFolder`). */
  get engagementsDir(): string | undefined {
    const ws = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
    if (!ws) return undefined;
    const setting = vscode.workspace.getConfiguration('reportStudio').get<string>('engagementsFolder') ?? 'engagements';
    return setting.trim() ? this.resolveSetting(setting.trim()) : ws;
  }

  /** Design search path: the project's own designs, the workspace ones, the setting, then the built-in presets. */
  designRoots(dir?: string): string[] {
    if (dir) return designRoots(dir, this.builtinDesignsDir, this.extraDesignsPath(), this.workspaceDesignsDirs());
    return [...new Set([...this.workspaceDesignsDirs(), this.extraDesignsPath() ?? '', this.builtinDesignsDir].filter(Boolean))];
  }

  libraryRoots(): string[] {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => join(f.uri.fsPath, 'library'));
    const extra = vscode.workspace.getConfiguration('reportStudio').get<string>('libraryPath');
    if (extra) roots.push(this.resolveSetting(extra));
    return roots;
  }

  private resolveSetting(p: string): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const r = p.replace(/^~(?=$|[\\/])/, process.env.HOME ?? '~').replace('${workspaceFolder}', ws);
    return isAbsolute(r) ? r : join(ws, r);
  }

  isBuiltin(path: string): boolean {
    return path.startsWith(this.builtinDesignsDir + sep);
  }

  load(dir = this.activeDir): Loaded | undefined {
    if (!dir) return undefined;
    const cached = this.cache.get(dir);
    if (cached) return cached;
    let loaded: Loaded;
    try {
      const project = loadProject(dir, this.read);
      try {
        loaded = { project, design: loadDesign(this.designRoots(dir), project.designId, this.read) };
      } catch (e) {
        loaded = { project, error: { message: (e as Error).message, file: e instanceof DesignError ? e.file : undefined } };
      }
    } catch (e) {
      loaded = {
        project: { dir, reportFile: join(dir, REPORT_FILE), designId: '', report: {}, items: {}, findings: [] },
        error: { message: `report.yaml: ${(e as Error).message}`, file: join(dir, REPORT_FILE) },
      };
    }
    this.cache.set(dir, loaded);
    return loaded;
  }

  displayName(dir: string): string {
    const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
    return ws ? relative(ws.uri.fsPath, dir) || basename(dir) : basename(dir);
  }

  private followFile(file: string): void {
    const dir = this.projectOf(file);
    if (dir && this.dirs.includes(dir)) this.setActive(dir);
  }

  private touch(file: string): void {
    const designRoots = this.designRoots().filter((r) => r !== this.builtinDesignsDir);
    if (designRoots.some((r) => file === r || file.startsWith(r + sep)) || this.dirs.some((d) => file.startsWith(join(d, DESIGNS_DIR) + sep))) {
      clearTimeout(this.designsTimer);
      this.designsTimer = setTimeout(() => this.designsEmitter.fire(), 200);
    }
    for (const dir of this.dirs) {
      const inProject = file === dir || file.startsWith(dir + sep);
      const inDesign = !inProject && this.designRoots(dir).some((r) => file.startsWith(r + sep));
      if ((inProject && !file.includes(`${sep}out${sep}`)) || inDesign) this.changedDirs.add(dir);
    }
    if (!this.changedDirs.size) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const dirs = [...this.changedDirs];
      this.changedDirs.clear();
      for (const d of dirs) {
        this.cache.delete(d);
        this.emitter.fire(d);
      }
    }, 150);
  }

  private touchAll(): void {
    this.cache.clear();
    for (const d of this.dirs) this.emitter.fire(d);
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.designsTimer);
    this.designsEmitter.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
    this.listEmitter.dispose();
  }
}
