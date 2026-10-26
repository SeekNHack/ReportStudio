import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import { renderReport } from '../core/render';
import type { Issue } from '../core/types';
import { validateProject } from '../core/validate';
import type { ProjectService } from './projects';

const SEVERITY: Record<Issue['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** Validates projects (required fields, CVSS, images, template errors) into the Problems panel. */
export class DiagnosticsService implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('reportStudio');
  private readonly byProject = new Map<string, Set<string>>();
  private readonly issuesByFile = new Map<string, Issue[]>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly projects: ProjectService) {
    this.disposables.push(
      this.collection,
      projects.onDidChange((dir) => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => dir && this.validate(dir), 400);
      }),
    );
  }

  validate(dir: string): void {
    const loaded = this.projects.load(dir);
    if (!loaded) return;
    if (!loaded.design) {
      this.set(dir, [{ file: loaded.error?.file ?? loaded.project.reportFile, message: loaded.error?.message ?? 'Invalid design', severity: 'error', line: 1 }]);
      return;
    }
    const issues = validateProject(loaded.project, loaded.design, this.projects.read);
    try {
      issues.push(...renderReport(loaded.project, loaded.design, { read: this.projects.read, assetUrl: (p) => pathToFileURL(p).href }).issues);
    } catch (e) {
      issues.push({ file: loaded.design.templatePath, message: (e as Error).message, severity: 'error', line: 1 });
    }
    this.set(dir, issues);
  }

  set(dir: string, issues: Issue[]): void {
    for (const file of this.byProject.get(dir) ?? []) {
      this.collection.delete(vscode.Uri.file(file));
      this.issuesByFile.delete(file);
    }
    const grouped = new Map<string, Issue[]>();
    for (const i of issues) grouped.set(i.file, [...(grouped.get(i.file) ?? []), i]);
    for (const [file, list] of grouped) {
      this.issuesByFile.set(file, list);
      this.collection.set(
        vscode.Uri.file(file),
        list.map((i) => {
          const line = Math.max(0, (i.line ?? 1) - 1);
          const col = Math.max(0, (i.column ?? 1) - 1);
          const d = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 200), i.message, SEVERITY[i.severity]);
          d.source = 'Report Studio';
          return d;
        }),
      );
    }
    this.byProject.set(dir, new Set(grouped.keys()));
    this.emitter.fire();
  }

  issuesFor(file: string): Issue[] {
    return this.issuesByFile.get(file) ?? [];
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}
