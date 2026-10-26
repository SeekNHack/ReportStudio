import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { listDesigns } from '../core/design';
import { REPORT_FILE } from '../core/project';
import type { ProjectService } from './projects';
import { readLibrary } from './trees';

type WorkspaceNode = { kind: 'link'; label: string; icon: string; tab: string; description?: string; expandable?: boolean } | { kind: 'engagement'; dir: string } | { kind: 'new' };

/** Sidebar entry points to the home: Home, Engagements (with the list), Templates, Library. */
export class WorkspaceTree implements vscode.TreeDataProvider<WorkspaceNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly projects: ProjectService) {
    projects.onDidChangeProjects(() => this.refresh());
    projects.onDidChangeDesigns(() => this.refresh());
    projects.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(node?: WorkspaceNode): WorkspaceNode[] {
    if (node?.kind === 'link' && node.tab === 'engagements') return [...this.projects.projects.map((dir) => ({ kind: 'engagement' as const, dir })), { kind: 'new' as const }];
    if (node) return [];
    const own = listDesigns(this.projects.designRoots(this.projects.active)).filter((d) => !this.projects.isBuiltin(join(d.dir, 'design.yaml'))).length;
    const library = readLibrary(this.projects.libraryRoots(), this.projects.read).length;
    return [
      { kind: 'link', label: 'Home', icon: 'home', tab: 'home' },
      { kind: 'link', label: 'Engagements', icon: 'briefcase', tab: 'engagements', description: String(this.projects.projects.length), expandable: true },
      { kind: 'link', label: 'Templates', icon: 'symbol-color', tab: 'templates', description: own ? `${own} yours` : 'presets' },
      { kind: 'link', label: 'Library', icon: 'library', tab: 'library', description: library ? String(library) : undefined },
    ];
  }

  getTreeItem(node: WorkspaceNode): vscode.TreeItem {
    if (node.kind === 'new') {
      const item = new vscode.TreeItem('New Engagement…');
      item.iconPath = new vscode.ThemeIcon('add');
      item.command = { command: 'reportStudio.newProject', title: 'New Engagement' };
      return item;
    }
    if (node.kind === 'engagement') {
      const loaded = this.projects.load(node.dir);
      const report = loaded?.project.report ?? {};
      const item = new vscode.TreeItem(basename(node.dir));
      item.id = `engagement:${node.dir}`;
      item.description = [report.client, loaded?.design?.name].filter(Boolean).join(' · ');
      const active = node.dir === this.projects.active;
      item.iconPath = new vscode.ThemeIcon(active ? 'circle-large-filled' : 'circle-large-outline', active ? new vscode.ThemeColor('focusBorder') : undefined);
      item.tooltip = `${this.projects.displayName(node.dir)}${active ? ' (active)' : ''}`;
      item.resourceUri = vscode.Uri.file(join(node.dir, REPORT_FILE));
      item.contextValue = 'engagement';
      item.command = { command: 'reportStudio.openEngagement', title: 'Open Engagement', arguments: [node.dir] };
      return item;
    }
    const item = new vscode.TreeItem(node.label, node.expandable ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = `link:${node.tab}`;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.description = node.description;
    item.command = { command: 'reportStudio.openHome', title: 'Open', arguments: [node.tab] };
    return item;
  }
}
