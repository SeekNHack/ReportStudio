import { readdirSync } from 'node:fs';
import type { Design, FieldDef, ReadFile } from './types';

/**
 * Visual layout of a report: the ordered list of blocks in `design.yaml → layout`.
 * Templates whose HTML includes "layout.html" (base, pentest and everything that
 * extends them) print these blocks in order instead of their built-in sequence;
 * a template.html written from scratch decides everything itself.
 */
export type LayoutBlockType =
  | 'cover'
  | 'toc'
  | 'heading'
  | 'field'
  | 'fields_table'
  | 'collection'
  | 'severity_summary'
  | 'findings_table'
  | 'severity_scale'
  | 'chart'
  | 'text'
  | 'html'
  | 'page_break';

export interface LayoutBlock {
  type: LayoutBlockType;
  /** heading printed above the block */
  title?: string;
  /** 1 = new chapter (h1, new page), 2 = section (h2), 0 = no heading */
  level?: number;
  /** field: report field id */
  field?: string;
  /** fields_table: explicit field ids (otherwise the "details" fields) */
  fields?: string[];
  /** fields_table: ids left out of the "details" fields */
  exclude?: string[];
  /** collection / chart: collection id */
  collection?: string;
  /** chart: field to count by */
  by?: string;
  /** chart: donut | bar */
  kind?: string;
  /** text: Markdown with {{ placeholders }} */
  body?: string;
  /** html: partial of the template (e.g. summary-extra.html) */
  file?: string;
  /** toc: heading depth */
  depth?: number;
  /** field: print the heading even when the field is empty */
  always?: boolean;
}

export const LAYOUT_BLOCKS: { type: LayoutBlockType; label: string; icon: string; text: string; level: number }[] = [
  { type: 'cover', label: 'Cover', icon: 'book', text: 'Cover page (layout and colors in the Theme tab)', level: 0 },
  { type: 'toc', label: 'Table of contents', icon: 'list-tree', text: 'Chapters and sections with page numbers', level: 0 },
  { type: 'heading', label: 'Heading', icon: 'symbol-text', text: 'Only a title: starts a chapter that the next sections belong to', level: 1 },
  { type: 'field', label: 'Report field', icon: 'symbol-field', text: 'The value of one report field', level: 1 },
  { type: 'fields_table', label: 'Fields table', icon: 'table', text: 'Label / value table of several report fields', level: 2 },
  { type: 'collection', label: 'Collection', icon: 'bug', text: 'All entries of a collection (findings, events…)', level: 1 },
  { type: 'severity_summary', label: 'Severity summary', icon: 'pie-chart', text: 'Donut chart and one counter per severity', level: 0 },
  { type: 'findings_table', label: 'Findings table', icon: 'checklist', text: 'Number, title, severity and score of every finding', level: 2 },
  { type: 'severity_scale', label: 'Severity scale', icon: 'symbol-ruler', text: 'Severities with their CVSS ranges', level: 2 },
  { type: 'chart', label: 'Chart', icon: 'graph', text: 'Entries of a collection counted by a field', level: 0 },
  { type: 'text', label: 'Text', icon: 'markdown', text: 'Fixed Markdown text with {{ placeholders }}', level: 2 },
  { type: 'html', label: 'Custom HTML', icon: 'file-code', text: 'An HTML/Nunjucks file of the template', level: 0 },
  { type: 'page_break', label: 'Page break', icon: 'whitespace', text: 'Continue on a new page', level: 0 },
];

const BODY_TYPES = ['markdown', 'code', 'screenshots'];

/** Where generic templates print a report field: before | after | details | none. */
export function fieldSection(f: FieldDef): string {
  return f.section ?? (BODY_TYPES.includes(f.type) ? 'before' : 'details');
}

/** Fields the pentest template prints itself (cover, summary, scope…). */
const PENTEST_HANDLED = ['title', 'subtitle', 'client', 'target', 'version', 'report_date', 'classification', 'language', 'authors', 'start_date', 'end_date'];
const PENTEST_CHAPTERS = ['executive_summary', 'scope', 'methodology', 'conclusion'];

/**
 * The order the built-in HTML prints things in, as blocks: the starting point of
 * the layout editor. `partials` are the optional hook files the template has.
 */
export function defaultLayout(design: Design, partials: string[] = []): LayoutBlock[] {
  const has = (f: string) => partials.includes(f);
  const pentest = design.id === 'pentest' || design.parents.some((p) => p.id === 'pentest');
  const fields = design.reportFields;
  const field = (f: FieldDef, level = 1): LayoutBlock => ({ type: 'field', field: f.id, title: f.label, level });
  const blocks: LayoutBlock[] = [{ type: 'cover' }, { type: 'toc' }];
  if (pentest) {
    const byId = (id: string) => fields.find((f) => f.id === id);
    if (byId('executive_summary')) blocks.push({ type: 'field', field: 'executive_summary', title: 'Executive Summary', level: 1, always: true });
    else blocks.push({ type: 'heading', title: 'Executive Summary', level: 1 });
    blocks.push({ type: 'severity_summary' });
    if (has('summary-extra.html')) blocks.push({ type: 'html', file: 'summary-extra.html' });
    blocks.push({ type: 'findings_table', title: 'Findings Overview', level: 2 });
    blocks.push({ type: 'heading', title: 'Scope and Methodology', level: 1 });
    if (byId('scope')) blocks.push({ type: 'field', field: 'scope', title: 'Scope', level: 2, always: true });
    if (byId('methodology')) blocks.push({ type: 'field', field: 'methodology', title: 'Methodology', level: 2, always: true });
    blocks.push({ type: 'fields_table', title: 'Engagement Details', level: 2, exclude: PENTEST_HANDLED });
    blocks.push({ type: 'severity_scale', title: 'Severity Rating', level: 2 });
    for (const f of fields) if (fieldSection(f) === 'before' && !PENTEST_CHAPTERS.includes(f.id)) blocks.push(field(f));
    for (const c of design.collections) blocks.push({ type: 'collection', collection: c.id, title: c.label, level: 1 });
    for (const f of fields) if (fieldSection(f) === 'after' && f.id !== 'conclusion') blocks.push(field(f));
    if (fields.some((f) => f.id === 'conclusion')) blocks.push({ type: 'field', field: 'conclusion', title: 'Conclusion', level: 1 });
    if (has('appendix-extra.html')) blocks.push({ type: 'html', file: 'appendix-extra.html' });
    return blocks;
  }
  blocks.push({ type: 'fields_table', title: 'Document Information', level: 1 });
  for (const f of fields) if (fieldSection(f) === 'before') blocks.push(field(f));
  if (has('summary-extra.html')) blocks.push({ type: 'html', file: 'summary-extra.html' });
  for (const c of design.collections) blocks.push({ type: 'collection', collection: c.id, title: c.label, level: 1 });
  for (const f of fields) if (fieldSection(f) === 'after') blocks.push(field(f));
  return blocks;
}

/** Keeps only well-formed blocks (a hand-edited design.yaml can contain anything). */
export function normalizeLayout(raw: unknown): LayoutBlock[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const types = LAYOUT_BLOCKS.map((b) => b.type);
  return raw
    .map((b) => (typeof b === 'string' ? { type: b } : b))
    .filter((b): b is LayoutBlock => !!b && typeof b === 'object' && types.includes((b as LayoutBlock).type))
    .map((b) => {
      const info = LAYOUT_BLOCKS.find((x) => x.type === b.type)!;
      return { ...b, level: b.level === undefined || b.level === null ? info.level : Number(b.level) };
    });
}

/** Nunjucks placeholder for a field, by type, for templates written by hand. */
export function placeholderFor(f: FieldDef, obj = 'report'): string {
  const v = `${obj}.${f.id}`;
  switch (f.type) {
    case 'date':
    case 'datetime':
      return `{{ ${v} | date }}`;
    case 'enum':
    case 'boolean':
      return `{{ ${obj}.display.${f.id} }}`;
    case 'list':
      return `{{ ${v} | join(', ') }}`;
    case 'image':
    case 'table':
    case 'screenshots':
    case 'cvss':
    case 'user':
      return `{{ render_field(${obj}, '${f.id}') }}`;
    default:
      return `{{ ${v} }}`;
  }
}

/** HTML files of the template and its parents (nearest first, unique names). */
export function templatePartials(design: Design): string[] {
  const names = new Set<string>();
  for (const dir of [design.dir, ...design.parents.map((p) => p.dir)]) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('.html')) names.add(f);
    } catch {
      /* folder gone */
    }
  }
  return [...names];
}

/** Whether the template.html that is rendered prints `layout` (base, pentest and their children). */
export function supportsLayout(design: Design, read: ReadFile): boolean {
  try {
    return /["']layout\.html["']/.test(read(design.templatePath));
  } catch {
    return false;
  }
}
