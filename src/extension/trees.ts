import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { scoreCvss } from '../core/cvss';
import { findingValues, parseFinding } from '../core/findingFile';
import { findingSeverity, numberFor, sortItems } from '../core/project';
import { isResolved } from '../core/render';
import type { CollectionDef, Design, FieldDef, Item } from '../core/types';
import type { BuildService } from './build';
import type { DiagnosticsService } from './diagnostics';
import type { ProjectService } from './projects';

const SEVERITY_ICON_COLORS = ['critical', 'high', 'medium', 'low', 'info'];

function severityColor(id: string): vscode.ThemeColor {
  return new vscode.ThemeColor(SEVERITY_ICON_COLORS.includes(id) ? `reportStudio.${id}` : 'foreground');
}

export function isFixed(values: Record<string, unknown>): boolean {
  return isResolved(values);
}

/* ------------------------------------------------------------ content */

type ContentNode =
  | { kind: 'collection'; collection: CollectionDef; items: Item[] }
  | { kind: 'group'; collection: CollectionDef; severity: Design['severities'][number]; items: Item[] }
  | { kind: 'item'; collection: CollectionDef; item: Item; number: string; finding: Item };

/** All collections of the active project (findings, timeline events, IOCs …). */
export class FindingsTree implements vscode.TreeDataProvider<ContentNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  view?: vscode.TreeView<ContentNode>;

  constructor(
    private readonly projects: ProjectService,
    private readonly diagnostics: DiagnosticsService,
  ) {
    projects.onDidChange((dir) => dir === projects.active && this.refresh());
    projects.onDidChangeProjects(() => this.refresh());
    diagnostics.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
    const loaded = this.projects.load();
    if (!this.view) return;
    void vscode.commands.executeCommand('setContext', 'reportStudio.hasCollections', !!loaded?.design?.collections.length);
    const collections = loaded?.design?.collections ?? [];
    const total = collections.reduce((n, c) => n + (loaded?.project.items[c.id]?.length ?? 0), 0);
    this.view.description = total ? String(total) : undefined;
    const findings = loaded?.project.findings ?? [];
    const hasFixed = collections.find((c) => c.id === 'findings')?.fields.some((f) => f.id === 'fixed' || f.id === 'retest_status');
    const open = hasFixed ? findings.filter((f) => !isFixed(f.values)).length : 0;
    this.view.badge = open ? { value: open, tooltip: `${open} open finding(s)` } : undefined;
  }

  getChildren(node?: ContentNode): ContentNode[] {
    const loaded = this.projects.load();
    if (!loaded?.design) return [];
    const design = loaded.design;
    const numbered = (c: CollectionDef) => {
      const sorted = sortItems(loaded.project.items[c.id] ?? [], c, design);
      return sorted.map((item, i) => ({ kind: 'item' as const, collection: c, item, finding: item, number: numberFor(c, i, sorted.length) }));
    };
    if (!node) {
      const cols = design.collections;
      // A single collection is shown directly, without an extra level.
      if (cols.length === 1) return this.getChildren({ kind: 'collection', collection: cols[0], items: loaded.project.items[cols[0].id] ?? [] });
      return cols.map((c) => ({ kind: 'collection' as const, collection: c, items: loaded.project.items[c.id] ?? [] }));
    }
    if (node.kind === 'collection') {
      const c = node.collection;
      if (!c.hasSeverity) return numbered(c);
      return design.severities
        .map((severity) => ({ kind: 'group' as const, collection: c, severity, items: node.items.filter((f) => findingSeverity(f.values, design).id === severity.id) }))
        .filter((g) => g.items.length);
    }
    if (node.kind === 'group') return numbered(node.collection).filter((n) => findingSeverity(n.item.values, design).id === node.severity.id);
    return [];
  }

  getTreeItem(node: ContentNode): vscode.TreeItem {
    if (node.kind === 'collection') {
      const c = node.collection;
      const item = new vscode.TreeItem(c.label, node.items.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.description = String(node.items.length);
      item.iconPath = new vscode.ThemeIcon(c.icon);
      item.contextValue = 'collection';
      item.id = `collection:${c.id}`;
      item.tooltip = c.description ?? `${c.label} — folder ${c.id}/`;
      return item;
    }
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.severity.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.items.length);
      item.iconPath = new vscode.ThemeIcon('circle-large-filled', severityColor(node.severity.id));
      item.contextValue = 'severityGroup';
      item.id = `group:${node.collection.id}:${node.severity.id}`;
      return item;
    }
    const { item: entry, number, collection: c } = node;
    const loaded = this.projects.load()!;
    const design = loaded.design!;
    const values = entry.values;
    const fixed = isFixed(values);
    const fixable = c.fields.some((f) => f.id === 'fixed');
    const issues = this.diagnostics.issuesFor(entry.file).filter((i) => i.severity !== 'info');
    const title = String(values[c.titleField] ?? values.title ?? entry.id);
    const ti = new vscode.TreeItem(c.prefix ? `${number}  ${title}` : title, vscode.TreeItemCollapsibleState.None);
    ti.id = `item:${entry.file}`;
    ti.resourceUri = vscode.Uri.file(entry.file);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${c.prefix ? `${number} ` : ''}${escapeMd(title)}**\n\n`);
    if (c.hasSeverity) {
      const sev = findingSeverity(values, design);
      const parts = [sev.score !== undefined ? sev.score.toFixed(1) : undefined, fixable || values.retest_status ? (values.retest_status ? `${fixed ? '✓ ' : ''}${statusLabel(values, c)}` : fixed ? '✓ fixed' : 'open') : undefined, issues.length ? `⚠ ${issues.length}` : undefined];
      ti.description = parts.filter(Boolean).join(' · ');
      ti.iconPath = fixed ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('reportStudio.fixed')) : new vscode.ThemeIcon(issues.length ? 'warning' : c.icon, severityColor(sev.id));
      md.appendMarkdown(`$(circle-filled) ${design.severities.find((s) => s.id === sev.id)?.label ?? sev.id}${sev.score !== undefined ? ` · CVSS ${sev.score.toFixed(1)}` : ''}\n\n`);
      if (scoreCvss(values.cvss)) md.appendMarkdown(`\`${String(values.cvss)}\`\n\n`);
    } else {
      // Show the first short fields (date, status …) as description.
      const short = c.fields.filter((f) => f.id !== c.titleField && ['date', 'datetime', 'enum', 'string', 'user', 'boolean'].includes(f.type) && values[f.id] !== undefined && values[f.id] !== '').slice(0, 2);
      ti.description = [...short.map((f) => shortValue(f, values[f.id])), issues.length ? `⚠ ${issues.length}` : undefined].filter(Boolean).join(' · ');
      const status = c.fields.find((f) => f.type === 'enum' && f.options?.some((o) => o.color));
      const opt = status?.options?.find((o) => o.value === values[status.id]);
      ti.iconPath = new vscode.ThemeIcon(issues.length ? 'warning' : c.icon, opt ? closestColor(opt.color!) : undefined);
    }
    for (const i of issues) md.appendMarkdown(`$(warning) ${escapeMd(i.message)}\n\n`);
    md.appendMarkdown(`_${vscode.workspace.asRelativePath(entry.file)}_`);
    ti.tooltip = md;
    ti.contextValue = `finding item${fixable ? ' fixable' : ''}${fixed ? ' fixed' : ''}`;
    ti.command = { command: 'reportStudio.openFinding', title: 'Open', arguments: [vscode.Uri.file(entry.file)] };
    return ti;
  }
}

function shortValue(f: FieldDef, v: unknown): string {
  if (f.type === 'enum') return f.options?.find((o) => o.value === v)?.label ?? String(v);
  if (f.type === 'boolean') return v ? f.label : '';
  if (f.type === 'datetime') return String(v).replace('T', ' ').slice(0, 16);
  return String(v).slice(0, 40);
}

/** Maps an arbitrary option color to the nearest themable severity color. */
function closestColor(hex: string): vscode.ThemeColor {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return new vscode.ThemeColor('foreground');
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  if (g > r && g > b) return new vscode.ThemeColor('reportStudio.fixed');
  if (b > r && b > g) return new vscode.ThemeColor('reportStudio.low');
  if (r > 180 && g > 150) return new vscode.ThemeColor('reportStudio.medium');
  if (r > 180 && g > 70) return new vscode.ThemeColor('reportStudio.high');
  if (r > 150) return new vscode.ThemeColor('reportStudio.critical');
  return new vscode.ThemeColor('reportStudio.info');
}

function statusLabel(values: Record<string, unknown>, c: CollectionDef): string {
  const f = c.fields.find((x) => x.id === 'retest_status');
  return f?.options?.find((o) => o.value === values.retest_status)?.label.toLowerCase() ?? 'open';
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

/* -------------------------------------------------------------- report */

type ReportNode =
  | { kind: 'details' }
  | { kind: 'design' }
  | { kind: 'designFile'; path: string; builtin: boolean }
  | { kind: 'action'; label: string; icon: string; command: string; description?: string }
  | { kind: 'project' }
  | { kind: 'output'; path: string }
  | { kind: 'error'; message: string; file?: string };

export class ReportTree implements vscode.TreeDataProvider<ReportNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly projects: ProjectService,
    private readonly builds: BuildService,
  ) {
    projects.onDidChange(() => this.emitter.fire());
    projects.onDidChangeProjects(() => this.emitter.fire());
    builds.onDidBuild(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(node?: ReportNode): ReportNode[] {
    const loaded = this.projects.load();
    if (!loaded) return [];
    if (node?.kind === 'design') {
      if (!loaded.design) return [];
      const d = loaded.design;
      const dirs = [d.dir, ...d.parents.map((p) => p.dir)];
      const seen = new Set<string>();
      const files: ReportNode[] = [];
      for (const dir of dirs) {
        for (const name of listFiles(dir)) {
          const rel = relative(dir, name);
          if (seen.has(rel)) continue;
          seen.add(rel);
          files.push({ kind: 'designFile', path: name, builtin: this.projects.isBuiltin(name) });
        }
      }
      return files;
    }
    if (node) return [];
    const nodes: ReportNode[] = [];
    if (this.projects.projects.length > 1) nodes.push({ kind: 'project' });
    if (loaded.error) nodes.push({ kind: 'error', message: loaded.error.message, file: loaded.error.file });
    nodes.push({ kind: 'details' }, { kind: 'design' });
    nodes.push({ kind: 'action', label: 'Edit Fields & Collections', icon: 'settings-gear', command: 'reportStudio.editDesign' });
    nodes.push({ kind: 'action', label: 'Live Preview', icon: 'open-preview', command: 'reportStudio.openPreview', description: 'Ctrl+Alt+P' });
    nodes.push({ kind: 'action', label: 'Build PDF', icon: 'file-pdf', command: 'reportStudio.buildPdf', description: 'Ctrl+Alt+B' });
    nodes.push({ kind: 'action', label: 'Export HTML', icon: 'file-code', command: 'reportStudio.exportHtml' });
    nodes.push({ kind: 'action', label: 'Export Data', icon: 'table', command: 'reportStudio.exportData', description: 'Excel, CSV, JSON, SARIF' });
    nodes.push({ kind: 'action', label: 'New Report from This One', icon: 'repo-forked', command: 'reportStudio.newReportFrom', description: 'e.g. retest' });
    const last = this.builds.lastOutput(loaded.project.dir);
    if (last && existsSync(last)) nodes.push({ kind: 'output', path: last });
    return nodes;
  }

  getTreeItem(node: ReportNode): vscode.TreeItem {
    const loaded = this.projects.load()!;
    switch (node.kind) {
      case 'project': {
        const item = new vscode.TreeItem(this.projects.displayName(loaded.project.dir));
        item.description = 'switch project';
        item.iconPath = new vscode.ThemeIcon('folder-library');
        item.command = { command: 'reportStudio.selectProject', title: 'Select Project' };
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(node.message);
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        item.tooltip = node.message;
        if (node.file) item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.file)] };
        return item;
      }
      case 'details': {
        const r = loaded.project.report;
        const item = new vscode.TreeItem(String(r.title ?? 'Report details'));
        item.description = [r.client, r.version ? `v${r.version}` : undefined].filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon('book');
        item.tooltip = 'Edit report details';
        item.command = { command: 'reportStudio.openReport', title: 'Edit' };
        return item;
      }
      case 'design': {
        const d = loaded.design;
        const item = new vscode.TreeItem(`Design: ${d?.name ?? loaded.project.designId}`, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = d && this.projects.isBuiltin(join(d.dir, 'design.yaml')) ? 'built-in' : 'workspace';
        item.iconPath = new vscode.ThemeIcon('symbol-color');
        item.contextValue = 'design';
        item.tooltip = d?.description ?? '';
        return item;
      }
      case 'designFile': {
        const item = new vscode.TreeItem(basename(node.path));
        item.resourceUri = vscode.Uri.file(node.path);
        item.description = node.builtin ? 'read-only · copy design to edit' : relative(loaded.project.dir, node.path).startsWith('..') ? 'shared' : undefined;
        item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.path)] };
        return item;
      }
      case 'action': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = node.description;
        item.command = { command: node.command, title: node.label };
        return item;
      }
      case 'output': {
        const item = new vscode.TreeItem(basename(node.path));
        item.description = `last build · ${new Date(statSync(node.path).mtime).toLocaleTimeString()}`;
        item.iconPath = new vscode.ThemeIcon('output');
        item.command = { command: 'reportStudio.openOutput', title: 'Open', arguments: [node.path] };
        item.tooltip = node.path;
        return item;
      }
    }
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------- library */

export interface LibraryEntry {
  file: string;
  values: Record<string, unknown>;
}

export function readLibrary(roots: string[], read: (p: string) => string): LibraryEntry[] {
  const entries: LibraryEntry[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of listFiles(root)) {
      if (!file.endsWith('.md')) continue;
      try {
        entries.push({ file, values: findingValues(parseFinding(read(file))) });
      } catch {
        /* ignore malformed entries */
      }
    }
  }
  return entries.sort((a, b) => String(a.values.title).localeCompare(String(b.values.title)));
}

export class LibraryTree implements vscode.TreeDataProvider<LibraryEntry> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly projects: ProjectService) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/library/**/*.md');
    watcher.onDidCreate(() => this.refresh());
    watcher.onDidDelete(() => this.refresh());
    watcher.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(node?: LibraryEntry): LibraryEntry[] {
    return node ? [] : readLibrary(this.projects.libraryRoots(), this.projects.read);
  }

  getTreeItem(e: LibraryEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(String(e.values.title ?? basename(e.file, '.md')));
    const s = scoreCvss(e.values.cvss);
    item.description = [s ? s.score.toFixed(1) : undefined, e.values.category].filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon('library');
    item.resourceUri = vscode.Uri.file(e.file);
    item.contextValue = 'libraryEntry';
    item.tooltip = `${e.file}\nClick to open · use + to insert into the report`;
    item.command = { command: 'reportStudio.openFinding', title: 'Open', arguments: [vscode.Uri.file(e.file)] };
    return item;
  }
}
