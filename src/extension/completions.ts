import { sep } from 'node:path';
import * as vscode from 'vscode';
import { collectionOfFile } from '../core/project';
import type { FieldDef } from '../core/types';
import type { ProjectService } from './projects';

const FINDING_COMPUTED: [string, string][] = [
  ['number', 'Finding number, e.g. F-01'],
  ['index', '1-based position'],
  ['anchor', 'HTML id of the finding, for links'],
  ['severity', 'Severity id (explicit or derived from CVSS)'],
  ['severity_label', 'Severity label'],
  ['severity_color', 'Severity color'],
  ['score', 'CVSS score'],
  ['cvss_vector', 'Normalized CVSS vector'],
  ['cvss_version', 'CVSS version'],
  ['is_fixed', 'true when fixed or retest_status is fixed'],
  ['raw', 'Raw values (Markdown not rendered)'],
  ['display', 'Human readable values (enum labels, dates)'],
];
const STATS: [string, string][] = [
  ['total', 'Number of findings'],
  ['fixed', 'Fixed findings'],
  ['open', 'Open findings'],
  ['counts', 'counts.<severity>'],
  ['by_severity', 'List of severities with count'],
];
const HELPERS: [string, string, string][] = [
  ['toc', 'toc(${1:2})', 'Table of contents with page numbers'],
  ['pagebreak', 'pagebreak()', 'Force a page break'],
  ['severity_chart', "severity_chart('${1|donut,bar|}', '${2:Findings by severity}')", 'Severity chart (SVG)'],
  ['status_chart', "status_chart('${1:Remediation status}')", 'Fixed vs open donut chart'],
  ['finding_table', "finding_table(findings, '${1:number,title,severity,score}')", 'Overview table of findings'],
  ['badge', 'badge(${1:finding.severity})', 'Severity badge'],
  ['ref', "ref('${1:finding-id}')", 'Cross-reference to a finding with page number'],
  ['cvss_table', 'cvss_table(${1:finding.cvss})', 'Table of CVSS metrics'],
  ['asset', "asset('${1:logo.svg}')", 'URL of a file in the design assets/ folder'],
  ['field_label', "field_label('${1:report}', '${2:id}')", 'Label of a field from design.yaml'],
  ['render_field', "render_field(${1:item}, '${2:field}')", 'Any field rendered according to its type'],
  ['item_table', 'item_table(${1:list})', 'Table of the entries of a collection'],
  ['timeline', "timeline(${1:events}, '${2:timestamp}')", 'Chronological timeline'],
  ['chart', "chart(${1:list}, '${2:field}', '${3|donut,bar|}')", 'Chart counting entries by a field'],
  ['count_by', "count_by(${1:list}, '${2:field}')", 'Counts entries by the values of a field'],
  ['report_fields_in', "report_fields_in('${1|before,after,details|}', report)", 'Report fields of a generic section'],
  ['item_fields', "item_fields(item, '${1|meta,body|}')", 'Fields of an entry with a value'],
];

function fieldItem(f: FieldDef, range?: vscode.Range): vscode.CompletionItem {
  const item = new vscode.CompletionItem({ label: f.id, description: f.type }, vscode.CompletionItemKind.Field);
  item.detail = f.label;
  item.documentation = new vscode.MarkdownString([f.help, f.type === 'markdown' ? 'Rendered as HTML. Use `.raw.' + f.id + '` for the source.' : undefined].filter(Boolean).join('\n\n'));
  item.range = range;
  return item;
}

/** Completes `report.`, `finding.`, `stats.` and helper functions in templates and Markdown fields. */
export function registerCompletions(context: vscode.ExtensionContext, projects: ProjectService): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(doc, pos) {
      const dir = projects.projectOf(doc.uri.fsPath) ?? projects.active;
      const design = projects.load(dir)?.design;
      if (!design) return;
      const line = doc.lineAt(pos.line).text.slice(0, pos.character);
      const isTemplate = doc.languageId === 'html' || doc.uri.fsPath.endsWith('.njk');
      // Only inside {{ }} or {% %} (template) / {{ }} (markdown)
      const open = Math.max(line.lastIndexOf('{{'), isTemplate ? line.lastIndexOf('{%') : -1);
      const close = Math.max(line.lastIndexOf('}}'), line.lastIndexOf('%}'));
      if (open < 0 || close > open) return;
      const m = /([\w.]+)\.(\w*)$/.exec(line);
      const word = doc.getWordRangeAtPosition(pos, /\w+/);
      if (m) {
        const path = m[1].split('.');
        const root = path[0];
        // Which collection does `root` refer to? item / finding / event … or a loop variable.
        const cid = doc.uri.fsPath.split(sep).slice(-2, -1)[0];
        const loopOver = new RegExp(`for\\s+${root}\\s+in\\s+(?:collections\\.)?(\\w+)`).exec(doc.getText())?.[1];
        const collection =
          design.collections.find((c) => c.itemVar === root) ??
          (loopOver ? design.collections.find((c) => c.id === loopOver) : undefined) ??
          (root === 'item' ? (design.collections.find((c) => c.id === cid) ?? design.collections[0]) : undefined);
        const isFinding = !!collection;
        const itemFields = collection?.fields ?? [];
        if (root === 'report' && path.length === 1) return design.reportFields.map((f) => fieldItem(f, word)).concat(isTemplate ? [new vscode.CompletionItem('display', vscode.CompletionItemKind.Property), new vscode.CompletionItem('raw', vscode.CompletionItemKind.Property)] : []);
        if (root === 'report' && ['display', 'raw'].includes(path[1])) return design.reportFields.map((f) => fieldItem(f, word));
        if (isFinding && path.length === 1)
          return [
            ...itemFields.map((f) => fieldItem(f, word)),
            ...FINDING_COMPUTED.map(([id, d]) => Object.assign(new vscode.CompletionItem({ label: id, description: 'computed' }, vscode.CompletionItemKind.Property), { detail: d, range: word })),
          ];
        if (isFinding && ['display', 'raw'].includes(path[1])) return itemFields.map((f) => fieldItem(f, word));
        if (root === 'collections' && path.length === 1) return design.collections.map((c) => Object.assign(new vscode.CompletionItem(c.id, vscode.CompletionItemKind.Module), { detail: c.label }));
        if (root === 'stats' && path.length === 1) return STATS.map(([id, d]) => Object.assign(new vscode.CompletionItem(id, vscode.CompletionItemKind.Property), { detail: d }));
        if (root === 'stats' && path[1] === 'counts') return design.severities.map((s) => Object.assign(new vscode.CompletionItem(s.id, vscode.CompletionItemKind.Property), { detail: s.label }));
        if (root === 'design' && path.length === 1) return ['id', 'name', 'severities', 'report_fields', 'finding_fields'].map((id) => new vscode.CompletionItem(id, vscode.CompletionItemKind.Property));
        return;
      }
      const itemVars = design.collections.map((c) => c.itemVar);
      const roots = ['report', 'stats', 'now', 'collections', 'item', ...itemVars, ...(isTemplate ? ['theme', 'design', ...design.collections.map((c) => c.id)] : [])].map((id) => new vscode.CompletionItem(id, vscode.CompletionItemKind.Variable));
      const helpers = isTemplate
        ? HELPERS.map(([id, snippet, d]) => Object.assign(new vscode.CompletionItem(id, vscode.CompletionItemKind.Function), { insertText: new vscode.SnippetString(snippet), detail: d }))
        : [];
      return [...roots, ...helpers];
    },
  };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider([{ language: 'html', scheme: 'file' }, { pattern: '**/*.njk' }, { language: 'markdown', scheme: 'file' }], provider, '.', '{', ' '),
  );

  // Context key that shows Preview / Build buttons on design files.
  const update = (e?: vscode.TextEditor) => {
    const file = e?.document.uri.fsPath;
    const isDesign = !!file && [...new Set([...projects.designRoots(), ...projects.projects.flatMap((d) => projects.designRoots(d))])].some((r) => file.startsWith(r + sep));
    void vscode.commands.executeCommand('setContext', 'reportStudio.isDesignFile', isDesign);
    const dir = file && file.endsWith('.md') ? projects.projectOf(file) : undefined;
    const cid = dir && file ? collectionOfFile(dir, file) : undefined;
    void vscode.commands.executeCommand('setContext', 'reportStudio.isItemFile', !!cid);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(update));
  update(vscode.window.activeTextEditor);
}
