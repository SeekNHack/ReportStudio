import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { normalizeLayout, type LayoutBlock } from './layout';
import { FIELD_TYPES, type CollectionDef, type CollectionLayout, type Design, type FieldDef, type FieldOption, type FieldType, type ReadFile, type SeverityDef } from './types';

export const DEFAULT_SEVERITIES: SeverityDef[] = [
  { id: 'critical', label: 'Critical', color: '#c2185b', min: 9 },
  { id: 'high', label: 'High', color: '#e8590c', min: 7 },
  { id: 'medium', label: 'Medium', color: '#e0a800', min: 4 },
  { id: 'low', label: 'Low', color: '#1f7ae0', min: 0.1 },
  { id: 'info', label: 'Info', color: '#6b7280', min: 0 },
];

/** Folders of a project that are never collections. */
export const RESERVED_FOLDERS = ['assets', 'designs', 'out', 'library', 'node_modules'];

export class DesignError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(message);
  }
}

export interface RawCollection {
  label?: string;
  item_label?: string;
  item_var?: string;
  prefix?: string;
  sort?: string;
  title_field?: string;
  layout?: CollectionLayout;
  columns?: string[];
  page_break?: boolean;
  chart?: string;
  icon?: string;
  description?: string;
  fields?: Record<string, unknown>;
}

export interface RawDesign {
  name?: string;
  description?: string;
  extends?: string;
  finding_prefix?: string;
  template?: string;
  stylesheets?: string[];
  severities?: Partial<SeverityDef>[];
  report_fields?: Record<string, unknown>;
  /** shorthand for collections.findings.fields */
  finding_fields?: Record<string, unknown>;
  collections?: Record<string, RawCollection | null>;
  theme?: Record<string, unknown>;
  layout?: unknown[];
}

/** Lists available designs: the first root containing a given id wins. */
export function listDesigns(roots: string[]): { id: string; dir: string }[] {
  const seen = new Map<string, string>();
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      if (!seen.has(name) && statSync(dir).isDirectory() && existsSync(join(dir, 'design.yaml'))) seen.set(name, dir);
    }
  }
  return [...seen].map(([id, dir]) => ({ id, dir }));
}

export function findDesignDir(roots: string[], id: string): string | undefined {
  for (const root of roots) {
    const dir = root && join(root, id);
    if (dir && existsSync(join(dir, 'design.yaml'))) return dir;
  }
  return undefined;
}

interface MutableCollection extends Omit<CollectionDef, 'fields' | 'hasSeverity'> {
  fields: Map<string, FieldDef>;
}

export function loadDesign(roots: string[], id: string, read: ReadFile): Design {
  const chain: { id: string; dir: string; raw: RawDesign }[] = [];
  let current: string | undefined = id;
  while (current) {
    if (chain.some((c) => c.id === current)) throw new DesignError(`Circular "extends" in design "${current}"`);
    const dir = findDesignDir(roots, current);
    if (!dir) {
      const from = chain[chain.length - 1];
      throw new DesignError(from ? `Design "${from.id}" extends unknown design "${current}"` : `Design "${current}" not found`, from ? join(from.dir, 'design.yaml') : undefined);
    }
    const file = join(dir, 'design.yaml');
    let raw: RawDesign;
    try {
      raw = (parse(read(file)) ?? {}) as RawDesign;
    } catch (e) {
      throw new DesignError(`Invalid design.yaml: ${(e as Error).message}`, file);
    }
    chain.push({ id: current, dir, raw });
    current = raw.extends;
  }

  // Merge from the root ancestor down to the requested design.
  const reportFields = new Map<string, FieldDef>();
  const collections = new Map<string, MutableCollection>();
  let severities = DEFAULT_SEVERITIES;
  let templatePath: string | undefined;
  const stylesheets: string[] = [];
  const theme: Record<string, unknown> = {};
  let layout: LayoutBlock[] | undefined;
  for (const { dir, raw } of [...chain].reverse()) {
    const file = join(dir, 'design.yaml');
    mergeFields(reportFields, raw.report_fields, file);
    const rawCollections: Record<string, RawCollection | null> = { ...(raw.collections ?? {}) };
    if (raw.finding_fields || raw.finding_prefix !== undefined) {
      const f = (rawCollections.findings ?? {}) as RawCollection;
      rawCollections.findings = { ...f, fields: { ...(raw.finding_fields ?? {}), ...(f.fields ?? {}) }, prefix: f.prefix ?? raw.finding_prefix };
    }
    for (const [cid, spec] of Object.entries(rawCollections)) {
      if (spec === null) {
        collections.delete(cid);
        continue;
      }
      const prev = collections.get(cid);
      const col: MutableCollection = prev ?? {
        id: cid,
        label: humanize(cid),
        itemLabel: singular(humanize(cid)),
        itemVar: singular(cid).replace(/[^\w]/g, '_'),
        prefix: '',
        sort: 'manual',
        titleField: 'title',
        layout: 'sections',
        pageBreak: cid === 'findings',
        icon: cid === 'findings' ? 'bug' : 'symbol-namespace',
        fields: new Map(),
      };
      if (spec.label) col.label = spec.label;
      if (spec.item_label) col.itemLabel = spec.item_label;
      else if (spec.label && !prev) col.itemLabel = singular(spec.label);
      if (spec.item_var) col.itemVar = spec.item_var;
      if (spec.prefix !== undefined) col.prefix = String(spec.prefix);
      if (spec.sort) col.sort = spec.sort;
      if (spec.title_field) col.titleField = spec.title_field;
      if (spec.layout) col.layout = spec.layout;
      if (spec.columns) col.columns = spec.columns;
      if (spec.page_break !== undefined) col.pageBreak = !!spec.page_break;
      if (spec.chart !== undefined) col.chart = spec.chart || undefined;
      if (spec.icon) col.icon = spec.icon;
      if (spec.description !== undefined) col.description = spec.description;
      mergeFields(col.fields, spec.fields, file);
      collections.set(cid, col);
    }
    if (raw.severities) severities = normalizeSeverities(raw.severities);
    // A layout replaces the inherited one as a whole.
    if (raw.layout !== undefined) layout = normalizeLayout(raw.layout);
    Object.assign(theme, themeLayer(raw.theme, dir));
    const tpl = join(dir, raw.template ?? 'template.html');
    if (existsSync(tpl)) templatePath = tpl;
    for (const css of raw.stylesheets ?? ['styles.css']) {
      const p = join(dir, css);
      if (existsSync(p)) stylesheets.push(p);
    }
  }
  const self = chain[0];
  if (!templatePath) throw new DesignError(`Design "${id}" has no template.html (extend "base" to get a generic one)`, join(self.dir, 'design.yaml'));

  const finalCollections: CollectionDef[] = [...collections.values()].map((c) => {
    if (!c.fields.has(c.titleField)) c.fields = new Map([[c.titleField, { id: c.titleField, type: 'string', label: 'Title', required: true }], ...c.fields]);
    const fields = [...c.fields.values()];
    const hasSeverity = fields.some((f) => f.id === 'cvss' && f.type === 'cvss') || fields.some((f) => f.id === 'severity' && f.type === 'enum');
    const sort = c.sort === 'manual' && hasSeverity && !chainSetsSort(chain, c.id) ? 'severity' : c.sort;
    return { ...c, sort, fields, hasSeverity };
  });
  const findings = finalCollections.find((c) => c.id === 'findings');

  return {
    id,
    name: self.raw.name ?? id,
    description: self.raw.description,
    dir: self.dir,
    parents: chain.slice(1).map(({ id, dir }) => ({ id, dir })),
    reportFields: [...reportFields.values()],
    collections: finalCollections,
    findingFields: findings?.fields ?? [],
    severities,
    templatePath,
    stylesheets,
    findingPrefix: findings?.prefix ?? 'F-',
    theme,
    layout: layout?.length ? layout : undefined,
  };
}

function chainSetsSort(chain: { raw: RawDesign }[], cid: string): boolean {
  return chain.some((c) => !!c.raw.collections?.[cid]?.sort);
}

function mergeFields(target: Map<string, FieldDef>, raw: Record<string, unknown> | undefined, file: string): void {
  if (!raw) return;
  for (const [id, spec] of Object.entries(raw)) {
    if (spec === null || spec === false) {
      target.delete(id);
      continue;
    }
    target.set(id, normalizeField(id, spec, target.get(id), file));
  }
}

export function humanize(id: string): string {
  const s = id.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function singular(s: string): string {
  if (/ies$/i.test(s)) return s.replace(/ies$/i, 'y');
  if (/(ss|us)$/i.test(s)) return s;
  return s.replace(/s$/i, '');
}

export function normalizeField(id: string, spec: unknown, prev: FieldDef | undefined, file?: string): FieldDef {
  const o: Record<string, unknown> = typeof spec === 'string' ? { type: spec } : { ...(spec as object) };
  const type = (o.type ?? prev?.type ?? 'string') as FieldType;
  if (!FIELD_TYPES.includes(type)) throw new DesignError(`Field "${id}": unknown type "${type}" (use one of ${FIELD_TYPES.join(', ')})`, file);
  const field: FieldDef = { ...prev, ...(o as Partial<FieldDef>), id, type, label: (o.label as string) ?? prev?.label ?? humanize(id) };
  if (o.options) field.options = normalizeOptions(o.options);
  if (o.columns) {
    const cols = o.columns as Record<string, unknown> | unknown[];
    field.columns = Array.isArray(cols)
      ? cols.map((c) => (typeof c === 'string' ? normalizeField(c, 'string', undefined, file) : normalizeField(String((c as FieldDef).id), c, undefined, file)))
      : Object.entries(cols).map(([cid, c]) => normalizeField(cid, c ?? 'string', undefined, file));
  }
  if (type === 'enum' && !field.options?.length) throw new DesignError(`Field "${id}": enum needs "options"`, file);
  if (type === 'table' && !field.columns?.length) throw new DesignError(`Field "${id}": table needs "columns"`, file);
  return field;
}

function normalizeOptions(raw: unknown): FieldOption[] {
  if (Array.isArray(raw)) {
    return raw.map((o) =>
      typeof o === 'object' && o !== null
        ? { value: String((o as FieldOption).value), label: (o as FieldOption).label ?? humanize(String((o as FieldOption).value)), color: (o as FieldOption).color }
        : { value: String(o), label: humanize(String(o)) },
    );
  }
  if (raw && typeof raw === 'object') return Object.entries(raw).map(([value, label]) => ({ value, label: String(label) }));
  return [];
}

function normalizeSeverities(raw: Partial<SeverityDef>[]): SeverityDef[] {
  return raw.map((s) => ({ id: String(s.id), label: s.label ?? humanize(String(s.id)), color: s.color ?? '#888888', min: Number(s.min ?? 0) })).sort((a, b) => b.min - a.min);
}

/** `screenshots` entries are { image, caption } maps, or plain paths. */
export function screenshotPath(s: unknown): string | undefined {
  const p = typeof s === 'string' ? s : (s as { image?: unknown } | null)?.image;
  return typeof p === 'string' && p ? p : undefined;
}

/** Field types whose value lives in a `<!-- field:x -->` section of item files. */
export const SECTION_TYPES: FieldType[] = ['markdown', 'code'];

/** Fields whose value lives in a Markdown section of item files. */
export function markdownFieldIds(fields: FieldDef[]): string[] {
  return fields.filter((f) => SECTION_TYPES.includes(f.type)).map((f) => f.id);
}

export function collectionOf(design: Design, id: string): CollectionDef | undefined {
  return design.collections.find((c) => c.id === id);
}

const THEME_FILE = /\.(png|jpe?g|gif|svg|webp|woff2?|ttf|otf)$/i;

/** Theme values of one design: images and font files are relative to that design's folder. */
function themeLayer(theme: Record<string, unknown> | undefined, dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(theme ?? {})) {
    out[k] = typeof v === 'string' && THEME_FILE.test(v) && !isAbsolute(v) && !/^([a-z]+:|\/\/)/i.test(v) ? join(dir, v) : v;
  }
  return out;
}
