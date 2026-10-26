import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { scoreCvss, severityForScore } from './cvss';
import { RESERVED_FOLDERS } from './design';
import { findingValues, parseFinding, setYamlValue } from './findingFile';
import type { CollectionDef, Design, Item, Project, ReadFile } from './types';

export const REPORT_FILE = 'report.yaml';
export const FINDINGS_DIR = 'findings';
export const ASSETS_DIR = 'assets';
export const DESIGNS_DIR = 'designs';

export const defaultRead: ReadFile = (p) => readFileSync(p, 'utf8');

/** Loads report.yaml and every collection folder (any sub-folder with .md files). */
export function loadProject(dir: string, read: ReadFile = defaultRead): Project {
  const reportFile = join(dir, REPORT_FILE);
  const report = ((parse(read(reportFile)) as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const items: Record<string, Item[]> = {};
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (name.startsWith('.') || RESERVED_FOLDERS.includes(name)) continue;
    const cdir = join(dir, name);
    if (!statSync(cdir).isDirectory()) continue;
    const files = readdirSync(cdir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    if (files.length || name === FINDINGS_DIR) items[name] = files.map((f) => loadItem(join(cdir, f), name, read));
  }
  return { dir, reportFile, designId: String(report.design ?? 'pentest'), report, items, findings: items[FINDINGS_DIR] ?? [] };
}

export function loadItem(file: string, collection: string, read: ReadFile = defaultRead): Item {
  const values = findingValues(parseFinding(read(file)));
  return { id: String(values.id ?? basename(file, '.md')), file, collection, values };
}
/** @deprecated use loadItem */
export const loadFinding = (file: string, read: ReadFile = defaultRead) => loadItem(file, basename(dirname(file)), read);

/** Collection id of an item file inside a project (its folder name). */
export function collectionOfFile(projectDir: string, file: string): string | undefined {
  const rel = relative(projectDir, file);
  if (rel.startsWith('..')) return undefined;
  const parts = rel.split(sep);
  return parts.length === 2 && parts[1].endsWith('.md') ? parts[0] : undefined;
}

/** Finds the project directory a file belongs to (nearest parent with report.yaml). */
export function projectDirOf(file: string): string | undefined {
  let dir = dirname(file);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, REPORT_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/**
 * Design search path: the project's own designs/, the designs/ of its parent
 * folders (templates shared by the engagements of a workspace), the extra
 * folder from the settings, then the built-in presets.
 */
export function designRoots(projectDir: string, builtinDir: string, extra?: string, workspaceDirs: string[] = []): string[] {
  const roots = [join(projectDir, DESIGNS_DIR)];
  for (let dir = dirname(projectDir), i = 0; i < 4 && dir !== dirname(dir); dir = dirname(dir), i++) {
    if (existsSync(join(dir, DESIGNS_DIR, '.')) && !existsSync(join(dir, REPORT_FILE))) roots.push(join(dir, DESIGNS_DIR));
  }
  return [...new Set([...roots, ...workspaceDirs, extra ?? '', builtinDir].filter(Boolean))];
}

/** Severity of an item: explicit value, else derived from CVSS. */
export function findingSeverity(values: Record<string, unknown>, design: Design): { id: string; score?: number } {
  const cvss = scoreCvss(values.cvss);
  const explicit = typeof values.severity === 'string' ? values.severity : undefined;
  if (explicit && design.severities.some((s) => s.id === explicit)) return { id: explicit, score: cvss?.score };
  if (cvss) return { id: severityForScore(cvss.score, design.severities).id, score: cvss.score };
  return { id: design.severities[design.severities.length - 1].id };
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null || a === '') return 1;
  if (b === undefined || b === null || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const da = a instanceof Date ? a.getTime() : NaN;
  const db = b instanceof Date ? b.getTime() : NaN;
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** Sorts items as configured by the collection (`sort`). */
export function sortItems(items: Item[], collection: CollectionDef | undefined, design: Design): Item[] {
  const sort = collection?.sort ?? 'severity';
  const title = collection?.titleField ?? 'title';
  const manual = (a: Item, b: Item) => compare(a.values.order, b.values.order) || compare(a.values[title], b.values[title]);
  if (sort === 'severity') {
    const rank = (f: Item) => design.severities.findIndex((s) => s.id === findingSeverity(f.values, design).id);
    return [...items].sort((a, b) => rank(a) - rank(b) || (findingSeverity(b.values, design).score ?? 0) - (findingSeverity(a.values, design).score ?? 0) || manual(a, b));
  }
  if (sort === 'manual') return [...items].sort(manual);
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  const field = collection?.fields.find((f) => f.id === key);
  const value = (i: Item) => {
    const v = i.values[key];
    if (field?.type === 'enum') return field.options?.findIndex((o) => o.value === v) ?? 0;
    if ((field?.type === 'date' || field?.type === 'datetime') && v) return new Date(String(v instanceof Date ? v.toISOString() : v));
    return v;
  };
  return [...items].sort((a, b) => (desc ? compare(value(b), value(a)) : compare(value(a), value(b))) || manual(a, b));
}

/** Sort for the "findings" collection (severity first). */
export function sortFindings(findings: Item[], design: Design): Item[] {
  return sortItems(findings, design.collections.find((c) => c.id === FINDINGS_DIR), design);
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

export function uniqueItemFile(dir: string, collection: string, base: string): string {
  const cdir = join(dir, collection);
  let name = slugify(base);
  let i = 2;
  while (existsSync(join(cdir, `${name}.md`))) name = `${slugify(base)}-${i++}`;
  return join(cdir, `${name}.md`);
}

export function uniqueFindingFile(dir: string, base: string): string {
  return uniqueItemFile(dir, FINDINGS_DIR, base);
}

export function reportYamlDocument(text: string) {
  return parseDocument(text);
}

export function numberFor(collection: CollectionDef | undefined, index: number, total: number): string {
  if (!collection?.prefix) return String(index + 1);
  return `${collection.prefix}${String(index + 1).padStart(Math.max(2, String(total).length), '0')}`;
}

/** Creates an engagement folder: report.yaml with the design defaults, collection folders, assets/. */
export function scaffoldProject(dir: string, design: Design, values: Record<string, unknown> = {}): void {
  const doc = reportYamlDocument('');
  setYamlValue(doc, 'design', design.id);
  for (const f of design.reportFields) if (f.default !== undefined) setYamlValue(doc, f.id, f.default);
  if (design.reportFields.some((f) => f.id === 'report_date')) setYamlValue(doc, 'report_date', new Date().toISOString().slice(0, 10));
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') setYamlValue(doc, k, v);
  for (const c of design.collections) mkdirSync(join(dir, c.id), { recursive: true });
  mkdirSync(join(dir, ASSETS_DIR), { recursive: true });
  writeFileSync(join(dir, ASSETS_DIR, '.gitkeep'), '');
  writeFileSync(join(dir, REPORT_FILE), `# Report project — open with the Report form or edit as YAML.\n${doc.toString({ lineWidth: 0 })}`);
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), 'out/\n');
}
