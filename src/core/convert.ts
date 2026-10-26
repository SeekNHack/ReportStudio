import { basename, relative } from 'node:path';
import { SECTION_TYPES, markdownFieldIds } from './design';
import { findingValues, parseFinding, serializeFinding, setFindingValue, setYamlValue, type ParsedFinding } from './findingFile';
import { REPORT_FILE, reportYamlDocument } from './project';
import type { CollectionDef, Design, FieldDef, FieldOption, Project, ReadFile } from './types';

/**
 * Changes the report type (design) of a project: every value is carried over
 * to the field with the same id, converted to the new field type; enum values
 * are matched by value, label or meaning (fixed → solved, …); collections are
 * mapped by id or as chosen by the user. Values the new type does not use are
 * kept in the files (hidden) unless `dropUnused` is set, so switching back
 * loses nothing.
 */

export type ConversionMode = 'copy' | 'inplace';

export interface ConversionOptions {
  mode: ConversionMode;
  /** source collection → target collection; null = not converted (copy: not copied) */
  map: Record<string, string | null>;
  /** remove values of fields the new type does not define */
  dropUnused?: boolean;
  /** today, for report dates of a new report */
  now?: Date;
}

export interface FieldChanges {
  /** new fields filled with their default */
  defaults: string[];
  /** values converted to another type or option */
  converted: string[];
  /** values the new type has no field for (kept hidden, or removed with dropUnused) */
  unused: string[];
  /** values cleared because the field is not carried over to a new report */
  reset: string[];
  /** values that could not be converted (kept as they are) */
  problems: string[];
}

export interface CollectionPlan {
  from: string;
  label: string;
  count: number;
  /** suggested target, or the one chosen in options.map */
  to: string | null;
  changes: FieldChanges;
}

export interface ConversionPlan {
  from?: Design;
  to: Design;
  report: FieldChanges;
  collections: CollectionPlan[];
  /** target collections that receive no items */
  emptyTargets: string[];
}

export interface ConversionResult {
  plan: ConversionPlan;
  /** files to write, paths relative to the project */
  writes: { path: string; content: string }[];
  /** files to delete (relative), e.g. items moved to another collection folder */
  deletes: string[];
  /** collection folders not copied into a new report (relative) */
  skipDirs: string[];
}

const emptyChanges = (): FieldChanges => ({ defaults: [], converted: [], unused: [], reset: [], problems: [] });

/** Suggested collection mapping: same id, then same label, then findings ↔ the target collection with a severity. */
export function suggestMapping(project: Project, from: Design | undefined, to: Design): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  const taken = new Set<string>();
  const sources = Object.keys(project.items).filter((id) => project.items[id].length || from?.collections.some((c) => c.id === id));
  for (const id of sources) if (to.collections.some((c) => c.id === id)) (map[id] = id), taken.add(id);
  for (const id of sources) {
    if (id in map) continue;
    const src = from?.collections.find((c) => c.id === id);
    const byLabel = to.collections.find((c) => !taken.has(c.id) && src && c.label.toLowerCase() === src.label.toLowerCase());
    const bySeverity = src?.hasSeverity ? to.collections.find((c) => !taken.has(c.id) && c.hasSeverity) : undefined;
    const target = byLabel ?? bySeverity;
    map[id] = target?.id ?? null;
    if (target) taken.add(target.id);
  }
  return map;
}

/* ------------------------------------------------------------ enum matching */

const MEANINGS: string[][] = [
  ['solved', 'fixed', 'resolved', 'closed', 'remediated', 'done', 'compliant', 'mitigated', 'contained', 'complete', 'completed', 'true', 'yes', 'pass', 'passed'],
  ['partial', 'partially_fixed', 'partially_solved', 'partially_compliant', 'partially_remediated', 'in_progress', 'ongoing'],
  ['not_solved', 'not_fixed', 'open', 'unresolved', 'non_compliant', 'not_compliant', 'not_remediated', 'todo', 'planned', 'false', 'no', 'fail', 'failed'],
  ['not_tested', 'not_retested', 'untested', 'n_a', 'na', 'not_applicable', 'unknown'],
];

const norm = (s: unknown) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Option of `options` that corresponds to `value` (a value or label of another field), if any. */
export function matchOption(value: unknown, options: FieldOption[], sourceLabel?: string): string | undefined {
  const v = String(value);
  const exact = options.find((o) => o.value === v);
  if (exact) return exact.value;
  const n = norm(v);
  const candidates = [n, ...(sourceLabel ? [norm(sourceLabel)] : [])];
  for (const c of candidates) {
    const o = options.find((x) => norm(x.value) === c || norm(x.label) === c);
    if (o) return o.value;
  }
  for (const group of MEANINGS) {
    if (!candidates.some((c) => group.includes(c))) continue;
    const o = options.find((x) => group.includes(norm(x.value)) || group.includes(norm(x.label)));
    if (o) return o.value;
  }
  return undefined;
}

function meaningOf(value: unknown): number {
  const n = norm(value);
  return MEANINGS.findIndex((g) => g.includes(n));
}

/* ------------------------------------------------------------ value conversion */

type Converted = { ok: true; value: unknown; changed: boolean } | { ok: false };

const toText = (v: unknown): string => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x ? Object.values(x).join(' · ') : String(x))).join('\n') : typeof v === 'object' && v ? JSON.stringify(v) : String(v));

/** Converts a value of field `src` (may be unknown) to the type of field `dst`. */
export function convertValue(value: unknown, src: FieldDef | undefined, dst: FieldDef): Converted {
  const same = (v: unknown): Converted => ({ ok: true, value: v, changed: false });
  const changed = (v: unknown): Converted => ({ ok: true, value: v, changed: true });
  const srcType = src?.type;
  switch (dst.type) {
    case 'enum': {
      const options = dst.options ?? [];
      if (typeof value === 'boolean') {
        const group = MEANINGS[value ? 0 : 2];
        const o = options.find((x) => group.includes(norm(x.value)));
        return o ? changed(o.value) : { ok: false };
      }
      const label = src?.options?.find((o) => o.value === String(value))?.label;
      const m = matchOption(value, options, label);
      if (m === undefined) return { ok: false };
      return m === String(value) ? same(value) : changed(m);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return same(value);
      const meaning = meaningOf(value);
      if (meaning === 0) return changed(true);
      if (meaning === 2 || meaning === 1) return changed(false);
      return { ok: false };
    }
    case 'number':
    case 'range': {
      if (typeof value === 'number') return same(value);
      const n = Number(String(value).replace(',', '.'));
      return Number.isFinite(n) ? changed(n) : { ok: false };
    }
    case 'list': {
      if (Array.isArray(value)) return value.every((x) => typeof x !== 'object' || x === null) ? same(value) : changed(value.map(toText));
      const items = String(value)
        .split(/\r?\n|;\s*/)
        .map((s) => s.replace(/^\s*[-*]\s+/, '').trim())
        .filter(Boolean);
      return changed(items);
    }
    case 'markdown': {
      if (typeof value === 'string') return same(value);
      if (Array.isArray(value) && srcType !== 'table' && srcType !== 'screenshots') return changed(value.map((x) => `- ${toText(x)}`).join('\n'));
      if (Array.isArray(value) && srcType === 'screenshots')
        return changed(value.map((x) => (typeof x === 'object' && x ? `![${(x as { caption?: string }).caption ?? ''}](${(x as { image?: string }).image ?? ''})` : `![](${x})`)).join('\n\n'));
      return changed(toText(value));
    }
    case 'code': {
      if (typeof value === 'string') return same(value);
      return changed(toText(value));
    }
    case 'string':
    case 'text':
    case 'user': {
      if (typeof value === 'string') return dst.type === 'string' && value.includes('\n') && srcType !== 'string' ? changed(value) : same(value);
      if (typeof value === 'number' || typeof value === 'boolean') return changed(String(value));
      return changed(toText(value));
    }
    case 'screenshots': {
      if (Array.isArray(value)) return same(value);
      if (typeof value === 'string' && /\.(png|jpe?g|gif|webp|svg)$/i.test(value)) return changed([{ image: value }]);
      return { ok: false };
    }
    case 'image': {
      if (typeof value === 'string') return same(value);
      if (Array.isArray(value) && value.length) {
        const first = value[0];
        return changed(typeof first === 'object' && first ? (first as { image?: string }).image : first);
      }
      return { ok: false };
    }
    case 'table': {
      if (Array.isArray(value) && value.every((r) => typeof r === 'object' && r !== null)) return same(value);
      const col = dst.columns?.[0];
      if (!col) return { ok: false };
      const rows = (Array.isArray(value) ? value.map(String) : String(value).split(/\r?\n/)).map((s) => s.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
      return changed(rows.map((r) => ({ [col.id]: r })));
    }
    default:
      // date, datetime, cvss, color, font: kept as they are when the type matches or is unknown.
      return srcType === undefined || srcType === dst.type || typeof value === 'string' || value instanceof Date ? same(value) : { ok: false };
  }
}

/* ------------------------------------------------------------ item conversion */

interface Target {
  fields: FieldDef[];
  /** source field definitions (undefined when the source design cannot be loaded) */
  srcFields?: FieldDef[];
  srcTitle?: string;
  dstTitle?: string;
}

function convertParsed(p: ParsedFinding, t: Target, opts: ConversionOptions, changes: FieldChanges, isReport: boolean) {
  const values = findingValues(p);
  const dstIds = new Set(t.fields.map((f) => f.id));
  const order = isReport ? undefined : markdownFieldIds(t.fields);
  const set = (f: FieldDef, v: unknown) => {
    if (isReport) setYamlValue(p.front, f.id, v);
    else {
      // The value may move between the front matter and the Markdown sections.
      p.sections = p.sections.filter((s) => s.id !== f.id);
      setYamlValue(p.front, f.id, undefined);
      setFindingValue(p, f.id, v, SECTION_TYPES.includes(f.type), order);
    }
  };
  const remove = (id: string) => {
    p.sections = p.sections.filter((s) => s.id !== id);
    setYamlValue(p.front, id, undefined);
  };
  const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

  // Title field renamed between the two collections (title → name).
  if (t.srcTitle && t.dstTitle && t.srcTitle !== t.dstTitle && empty(values[t.dstTitle]) && !empty(values[t.srcTitle])) {
    values[t.dstTitle] = values[t.srcTitle];
    const titleField = t.fields.find((f) => f.id === t.dstTitle);
    if (titleField) set(titleField, values[t.srcTitle]);
    if (!dstIds.has(t.srcTitle)) {
      remove(t.srcTitle);
      delete values[t.srcTitle];
    }
  }

  for (const f of t.fields) {
    const src = t.srcFields?.find((x) => x.id === f.id);
    let v = values[f.id];
    let wasReset = false;
    if (opts.mode === 'copy' && f.copy === false && !empty(v)) {
      changes.reset.push(f.label);
      remove(f.id);
      v = undefined;
      wasReset = true;
    }
    // Remediation status stored with a different field (fixed ↔ retest_status).
    if (empty(v) && opts.mode === 'inplace') {
      if (f.id === 'retest_status' && typeof values.fixed === 'boolean') v = values.fixed;
      if (f.id === 'fixed' && !empty(values.retest_status)) v = values.retest_status;
    }
    if (empty(v)) {
      // Fields the old type already had use their default anyway: only new or reset fields get it written.
      if (f.default !== undefined && (!src || wasReset || !t.srcFields)) {
        set(f, f.default);
        if (!wasReset) changes.defaults.push(f.label);
      }
      continue;
    }
    const c = convertValue(v, src, f);
    if (!c.ok) {
      changes.problems.push(`${f.label}: "${String(toText(v)).slice(0, 40)}"`);
      continue;
    }
    const wasSection = !isReport && p.sections.some((s) => s.id === f.id);
    const isSection = SECTION_TYPES.includes(f.type);
    if (c.changed || (!isReport && wasSection !== isSection)) {
      set(f, c.value);
      if (c.changed) changes.converted.push(f.label);
    }
  }

  // The legacy field that was converted is not needed any more.
  if (opts.mode === 'inplace' && dstIds.has('retest_status') && !dstIds.has('fixed') && typeof values.fixed === 'boolean') remove('fixed');

  const reserved = isReport ? ['design', 'theme'] : ['id', 'order'];
  for (const [k, v] of Object.entries(values)) {
    if (dstIds.has(k) || reserved.includes(k) || empty(v)) continue;
    if (k === 'fixed' && dstIds.has('retest_status') && opts.mode === 'inplace') continue;
    const label = t.srcFields?.find((x) => x.id === k)?.label ?? k;
    if (opts.mode === 'copy' && t.srcFields?.find((x) => x.id === k)?.copy === false) {
      remove(k);
      changes.reset.push(label);
      continue;
    }
    if (opts.dropUnused) remove(k);
    changes.unused.push(label);
  }
}

const unique = (c: FieldChanges): FieldChanges => ({
  defaults: [...new Set(c.defaults)],
  converted: [...new Set(c.converted)],
  unused: [...new Set(c.unused)],
  reset: [...new Set(c.reset)],
  problems: [...new Set(c.problems)],
});

function reportAsParsed(text: string): ParsedFinding {
  return { front: reportYamlDocument(text), sections: [], preamble: '' };
}

/**
 * Computes the converted files. Nothing is written: the caller applies
 * `writes`/`deletes` (inside a copy of the project for mode "copy").
 */
export function convertProject(project: Project, from: Design | undefined, to: Design, opts: ConversionOptions, read: ReadFile): ConversionResult {
  const writes: ConversionResult['writes'] = [];
  const deletes: string[] = [];
  const skipDirs: string[] = [];

  // report.yaml
  const reportText = read(project.reportFile);
  const rp = reportAsParsed(reportText);
  const reportChanges = emptyChanges();
  const previous = { title: project.report.title, version: project.report.version, date: project.report.report_date };
  setYamlValue(rp.front, 'design', to.id);
  convertParsed(rp, { fields: to.reportFields, srcFields: from?.reportFields }, opts, reportChanges, true);
  if (opts.mode === 'copy') {
    const now = opts.now ?? new Date();
    if (to.reportFields.some((f) => f.id === 'report_date')) setYamlValue(rp.front, 'report_date', now.toISOString().slice(0, 10));
    const original = to.reportFields.find((f) => f.id === 'original_report');
    if (original && !rp.front.get('original_report')) {
      const date = previous.date instanceof Date ? previous.date.toISOString().slice(0, 10) : previous.date;
      const text = [previous.title, previous.version ? `v${previous.version}` : '', date ? `(${String(date)})` : ''].filter(Boolean).join(' ');
      if (text) setYamlValue(rp.front, 'original_report', text);
    }
  }
  writes.push({ path: REPORT_FILE, content: rp.front.toString({ lineWidth: 0 }) });

  // Collections
  const plans: CollectionPlan[] = [];
  const sources = Object.keys({ ...project.items, ...opts.map });
  const used = new Set<string>();
  for (const sid of sources) {
    const items = project.items[sid] ?? [];
    const target = sid in opts.map ? opts.map[sid] : (to.collections.some((c) => c.id === sid) ? sid : null);
    const srcCol = from?.collections.find((c) => c.id === sid);
    const changes = emptyChanges();
    const plan: CollectionPlan = { from: sid, label: srcCol?.label ?? sid, count: items.length, to: target, changes };
    plans.push(plan);
    if (!target) {
      if (opts.mode === 'copy' && items.length) skipDirs.push(sid);
      continue;
    }
    used.add(target);
    const dst = to.collections.find((c) => c.id === target) as CollectionDef;
    for (const item of items) {
      const p = parseFinding(read(item.file));
      convertParsed(p, { fields: dst.fields, srcFields: srcCol?.fields, srcTitle: srcCol?.titleField ?? 'title', dstTitle: dst.titleField }, opts, changes, false);
      const rel = relative(project.dir, item.file).split('\\').join('/');
      let path = rel;
      if (target !== sid) {
        path = `${target}/${basename(item.file)}`;
        let i = 2;
        while (writes.some((w) => w.path === path) || project.items[target]?.some((x) => relative(project.dir, x.file).split('\\').join('/') === path))
          path = `${target}/${basename(item.file, '.md')}-${i++}.md`;
        deletes.push(rel);
      }
      writes.push({ path, content: serializeFinding(p) });
    }
    Object.assign(changes, unique(changes));
  }

  return {
    plan: { from, to, report: unique(reportChanges), collections: plans, emptyTargets: to.collections.filter((c) => !used.has(c.id)).map((c) => c.id) },
    writes,
    deletes,
    skipDirs,
  };
}

/** Human readable summary of a conversion, for the confirmation dialog. */
export function describePlan(r: ConversionResult): string {
  const lines: string[] = [];
  const list = (xs: string[], max = 6) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));
  const block = (title: string, c: FieldChanges) => {
    const parts: string[] = [];
    if (c.converted.length) parts.push(`converted: ${list(c.converted)}`);
    if (c.defaults.length) parts.push(`new with default: ${list(c.defaults)}`);
    if (c.reset.length) parts.push(`reset for the new round: ${list(c.reset)}`);
    if (c.unused.length) parts.push(`not used by the new type: ${list(c.unused)}`);
    if (c.problems.length) parts.push(`kept unchanged (cannot convert): ${list(c.problems, 3)}`);
    lines.push(`${title}${parts.length ? '\n  · ' + parts.join('\n  · ') : ' — no changes needed'}`);
  };
  block('Report details', r.plan.report);
  for (const c of r.plan.collections) {
    if (!c.count) continue;
    const to = r.plan.to.collections.find((x) => x.id === c.to);
    block(to ? `${c.count} ${c.label.toLowerCase()} → ${to.label}` : `${c.count} ${c.label.toLowerCase()} → not converted`, c.changes);
  }
  return lines.join('\n');
}

export const PROJECT_COPY_EXCLUDES = ['out', 'node_modules', '.git'];

/** Paths (relative) of a project that are not copied into a new report. */
export function isExcludedFromCopy(projectDir: string, path: string, skipDirs: string[]): boolean {
  const rel = relative(projectDir, path).split('\\').join('/');
  const top = rel.split('/')[0];
  return PROJECT_COPY_EXCLUDES.includes(top) || skipDirs.includes(top);
}
