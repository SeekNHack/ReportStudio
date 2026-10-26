import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import nunjucks from 'nunjucks';
import { cvssMetrics, scoreCvss } from '../cvss';
import { screenshotPath } from '../design';
import { findingSeverity, numberFor, sortItems } from '../project';
import { resolveTheme, themeCss } from '../theme';
import type { CollectionDef, Design, FieldDef, Issue, Item, Project, ReadFile, Screenshot } from '../types';
import { barChart, donutChart, type Slice } from './charts';
import { createMarkdown, parseFenceInfo, protectCode, renderCode, type Markdown } from './markdown';

export interface RenderOptions {
  read: ReadFile;
  /** turns an absolute file path into a URL for <img src> / CSS url() */
  assetUrl: (absPath: string) => string;
}

export interface RenderResult {
  title: string;
  body: string;
  css: string;
  issues: Issue[];
  /** files the output depends on, for watchers */
  dependencies: string[];
}

const SafeString = nunjucks.runtime.SafeString;
type Ctx = Record<string, unknown>;

/** Names that cannot be used as top-level aliases of collections. */
const RESERVED_NAMES = ['report', 'theme', 'design', 'stats', 'now', 'collections', 'loop', 'item'];
const PALETTE = ['#3b3fd8', '#0f766e', '#e8590c', '#7c3aed', '#0369a1', '#be185d', '#a16207', '#15803d', '#6b7280'];

/* ------------------------------------------------------------------ loader */

class DesignLoader extends nunjucks.Loader {
  readonly used = new Set<string>();
  constructor(
    private design: Design,
    private read: ReadFile,
  ) {
    super();
  }
  private dirs() {
    return [{ id: this.design.id, dir: this.design.dir }, ...this.design.parents];
  }
  resolvePath(name: string): string | undefined {
    const at = /^@([\w.-]+)\/(.+)$/.exec(name);
    if (at) {
      const d = this.dirs().find((x) => x.id === at[1]);
      return d && existsSync(join(d.dir, at[2])) ? join(d.dir, at[2]) : undefined;
    }
    if (isAbsolute(name)) return existsSync(name) ? name : undefined;
    for (const { dir } of this.dirs()) if (existsSync(join(dir, name))) return join(dir, name);
    return undefined;
  }
  getSource(name: string) {
    const path = this.resolvePath(name);
    if (!path) return null as never;
    this.used.add(path);
    return { src: this.read(path), path, noCache: true };
  }
}

/* ------------------------------------------------------------- formatting */

/** Dates without a time zone are taken as written (no UTC shift). */
export function parseDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(s) ? `${s.length === 10 ? `${s}T00:00` : s}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function formatDate(value: unknown, fmt = 'D MMMM YYYY', locale = 'en'): string {
  if (!value) return '';
  const d = parseDate(value);
  if (!d) return String(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = (style: 'long' | 'short') => new Intl.DateTimeFormat(locale, { month: style, timeZone: 'UTC' }).format(d);
  return fmt.replace(/YYYY|MMMM|MMM|MM|DD|D|HH|mm|ss/g, (t) => {
    switch (t) {
      case 'YYYY':
        return String(d.getUTCFullYear());
      case 'MMMM':
        return month('long');
      case 'MMM':
        return month('short');
      case 'MM':
        return pad(d.getUTCMonth() + 1);
      case 'DD':
        return pad(d.getUTCDate());
      case 'HH':
        return pad(d.getUTCHours());
      case 'mm':
        return pad(d.getUTCMinutes());
      case 'ss':
        return pad(d.getUTCSeconds());
      default:
        return String(d.getUTCDate());
    }
  });
}

export function displayValue(field: FieldDef, value: unknown, locale: string): string {
  if (value === undefined || value === null || value === '') return '';
  switch (field.type) {
    case 'boolean':
      return value === true ? 'Yes' : 'No';
    case 'enum':
      return field.options?.find((o) => o.value === String(value))?.label ?? String(value);
    case 'date':
      return formatDate(value, 'D MMMM YYYY', locale);
    case 'datetime':
      return formatDate(value, 'D MMM YYYY HH:mm', locale);
    case 'list':
      return Array.isArray(value) ? value.join(', ') : String(value);
    case 'table':
      return Array.isArray(value) ? `${value.length} row(s)` : '';
    case 'cvss': {
      const s = scoreCvss(value);
      return s ? `${s.score.toFixed(1)} (${s.vector})` : String(value);
    }
    default:
      return String(value);
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').replace(/^(?=\d)/, 's-') || 'section';
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* --------------------------------------------------------------- filters */

function addFilters(env: nunjucks.Environment, design: Design, locale: string, md: Markdown) {
  const sev = (id: unknown) => design.severities.find((s) => s.id === id);
  env.addFilter('markdown', (s: unknown) => new SafeString(md.render(String(s ?? ''))));
  env.addFilter('markdown_inline', (s: unknown) => new SafeString(md.renderInline(String(s ?? ''))));
  env.addFilter('date', (v: unknown, fmt?: string) => formatDate(v, fmt, locale));
  env.addFilter('datetime', (v: unknown, fmt = 'D MMM YYYY HH:mm') => formatDate(v, fmt, locale));
  env.addFilter('severity_label', (id: unknown) => sev(id)?.label ?? String(id ?? ''));
  env.addFilter('severity_color', (id: unknown) => sev(id)?.color ?? '#888');
  env.addFilter('cvss_score', (v: unknown) => scoreCvss(v)?.score.toFixed(1) ?? '');
  env.addFilter('yesno', (v: unknown, labels = 'Yes,No') => (v ? labels.split(',')[0] : labels.split(',')[1]));
  env.addFilter('where', (list: Ctx[], attr: string, value: unknown = true) => (list ?? []).filter((x) => (x?.raw as Ctx)?.[attr] === value || x?.[attr] === value));
  env.addFilter('where_not', (list: Ctx[], attr: string, value: unknown = true) => (list ?? []).filter((x) => (x?.raw as Ctx)?.[attr] !== value && x?.[attr] !== value));
  env.addFilter('sort_by', (list: Ctx[], attr: string, reverse = false) =>
    [...(list ?? [])].sort((a, b) => {
      const x = ((a?.raw as Ctx)?.[attr] ?? a?.[attr]) as never;
      const y = ((b?.raw as Ctx)?.[attr] ?? b?.[attr]) as never;
      return (x > y ? 1 : x < y ? -1 : 0) * (reverse ? -1 : 1);
    }),
  );
  env.addFilter('pluck', (list: Ctx[], attr: string) => (list ?? []).map((x) => x?.[attr]));
  /** Drops fields (or values) whose id is in `ids`: `report_fields_in('before', report) | exclude(['scope'])`. */
  env.addFilter('exclude', (list: unknown, ids: unknown) => {
    const skip = new Set((Array.isArray(ids) ? ids : String(ids ?? '').split(',')).map((x) => String(x).trim()));
    return (Array.isArray(list) ? list : []).filter((x) => !skip.has(String((x as { id?: unknown })?.id ?? x)));
  });
  env.addFilter('pad', (v: unknown, n = 2) => String(v).padStart(n, '0'));
}

/* ------------------------------------------------------------- rendering */

/** Field types printed as blocks (own heading) instead of key/value rows. */
const BODY_TYPES: string[] = ['markdown', 'code', 'table', 'image', 'screenshots'];

interface Scope {
  /** "_report" or a collection id */
  id: string;
  fields: FieldDef[];
  collection?: CollectionDef;
}

/**
 * Pass 1 of rendering: SysReptor style placeholders ({{ report.customer }}) inside
 * Markdown/text fields. Also used by the data exports, which need the same text.
 */
export function placeholderExpander(project: Project, design: Design, issues: Issue[] = []) {
  const locale = String(project.report.language ?? 'en');
  const sortedItems: Record<string, Item[]> = {};
  for (const c of design.collections) sortedItems[c.id] = sortItems(project.items[c.id] ?? [], c, design);
  const statsCollection = design.collections.find((c) => c.id === 'findings') ?? design.collections.find((c) => c.hasSeverity);
  const placeholderEnv = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false });
  addFilters(placeholderEnv, design, locale, createMarkdown({ baseDir: project.dir, assetUrl: (p) => p }));
  const reportRaw = { ...project.report };
  const baseStats = computeStats(statsCollection ? sortedItems[statsCollection.id].map((f) => f.values) : [], design, isResolved);
  const rawCollections = Object.fromEntries(Object.entries(sortedItems).map(([k, v]) => [k, v.map((i) => i.values)]));
  const expand = (text: string, extra: Ctx, file: string, field: string): string => {
    if (!text.includes('{{') && !text.includes('{%')) return text;
    const { text: safe, restore } = protectCode(text);
    try {
      return restore(placeholderEnv.renderString(safe, { report: reportRaw, stats: baseStats, collections: rawCollections, now: new Date(), ...extra }));
    } catch (e) {
      issues.push({ file, field, severity: 'warning', message: `Placeholder error in "${field}": ${cleanNunjucksMessage((e as Error).message)}` });
      return text;
    }
  };
  return { expand, sortedItems, statsCollection, reportRaw, locale };
}

export function renderReport(project: Project, design: Design, opts: RenderOptions): RenderResult {
  const issues: Issue[] = [];
  const md = createMarkdown({ baseDir: project.dir, assetUrl: opts.assetUrl });
  md.renderer.rules.heading_open = (tokens, idx) => `<${tokens[idx].tag} class="md-heading">`;
  const fixedOf = isResolved;
  const { expand, sortedItems, statsCollection, reportRaw, locale } = placeholderExpander(project, design, issues);

  const richField = (f: FieldDef, raw: unknown, extra: Ctx, file: string): unknown => {
    if (raw === undefined || raw === null) return f.type === 'markdown' || f.type === 'code' ? new SafeString('') : raw;
    if (f.type === 'markdown') return new SafeString(md.render(expand(String(raw), extra, file, f.id)));
    if (f.type === 'code') {
      // Stored as a fenced block (```python title="x.py"), or as plain code.
      const m = /^\s*(```+|~~~+)([^\n]*)\n([\s\S]*?)\n?\1\s*$/.exec(String(raw));
      const info = m ? parseFenceInfo(m[2]) : {};
      return new SafeString(renderCode(m ? m[3] : String(raw), { lines: f.lines, ...info, lang: info.lang || f.language || 'auto' }));
    }
    if (f.type === 'screenshots')
      return (Array.isArray(raw) ? raw : [raw])
        .map((x): Screenshot | undefined => {
          const image = screenshotPath(x);
          if (!image) return undefined;
          const o = (typeof x === 'object' ? x : {}) as Partial<Screenshot>;
          const url = /^[a-z]+:/i.test(image) ? image : opts.assetUrl(isAbsolute(image) ? image : join(project.dir, decodeURI(image)));
          return { image: url, caption: o.caption ? md.renderInline(expand(String(o.caption), extra, file, f.id)) : undefined, width: o.width ? String(o.width) : undefined };
        })
        .filter(Boolean);
    if (f.type === 'list' && f.items === 'markdown' && Array.isArray(raw)) return raw.map((x) => new SafeString(md.renderInline(expand(String(x), extra, file, f.id))));
    if (f.type === 'string' || f.type === 'text') return expand(String(raw), extra, file, f.id);
    if (f.type === 'table' && Array.isArray(raw))
      return raw.map((row) => {
        const r: Ctx = { raw: row, display: {} };
        for (const col of f.columns ?? []) {
          const v = (row as Ctx)?.[col.id];
          r[col.id] = col.type === 'markdown' ? new SafeString(md.renderInline(expand(String(v ?? ''), extra, file, f.id))) : v;
          (r.display as Ctx)[col.id] = displayValue(col, v, locale);
        }
        return r;
      });
    return raw;
  };

  const report: Ctx = { raw: reportRaw, display: {}, _scope: '_report' };
  for (const [k, v] of Object.entries(project.report)) report[k] = v;
  for (const f of design.reportFields) {
    report[f.id] = richField(f, project.report[f.id] ?? f.default, {}, project.reportFile);
    (report.display as Ctx)[f.id] = displayValue(f, project.report[f.id] ?? f.default, locale);
  }

  const collections: Record<string, Ctx[]> = {};
  for (const c of design.collections) {
    const list = sortedItems[c.id];
    collections[c.id] = list.map((item, i) => {
      const values = item.values;
      const number = numberFor(c, i, list.length);
      const out: Ctx = {
        ...values,
        id: item.id,
        raw: values,
        display: {},
        index: i + 1,
        number,
        anchor: `${c.itemVar}-${item.id}`,
        file: item.file,
        collection: c.id,
        _scope: c.id,
        title: values[c.titleField] ?? values.title ?? item.id,
        is_fixed: fixedOf(values),
      };
      let extraItem: Ctx = { ...values, number };
      if (c.hasSeverity) {
        const severity = findingSeverity(values, design);
        const sevDef = design.severities.find((s) => s.id === severity.id)!;
        const cvss = scoreCvss(values.cvss);
        Object.assign(out, { severity: severity.id, severity_label: sevDef.label, severity_color: sevDef.color, score: severity.score, cvss_vector: cvss?.vector, cvss_version: cvss?.version });
        extraItem = { ...extraItem, severity: severity.id, score: severity.score };
      }
      const extra = { [c.itemVar]: extraItem, item: extraItem };
      for (const f of c.fields) {
        const raw = values[f.id] ?? f.default;
        if (!(c.hasSeverity && f.id === 'severity')) out[f.id] = richField(f, raw, extra, item.file);
        (out.display as Ctx)[f.id] = c.hasSeverity && f.id === 'severity' ? (out.severity_label as string) : displayValue(f, raw, locale);
      }
      return out;
    });
  }
  const findings = collections.findings ?? [];
  const stats = computeStats(statsCollection ? collections[statsCollection.id] : [], design, (f) => f.is_fixed === true);

  const scopes = new Map<string, Scope>([['_report', { id: '_report', fields: design.reportFields }], ...design.collections.map((c) => [c.id, { id: c.id, fields: c.fields, collection: c }] as [string, Scope])]);

  // Pass 2: the design template.
  const loader = new DesignLoader(design, opts.read);
  const env = new nunjucks.Environment(loader, { autoescape: true, throwOnUndefined: false, trimBlocks: true, lstripBlocks: true });
  addFilters(env, design, locale, md);
  addGlobals(env, { design, collections, findings, stats, opts, loader, scopes, locale, projectDir: project.dir });

  const theme = resolveTheme(design.theme, project.report.theme as Record<string, unknown> | undefined);
  const projectAsset = (v: unknown) => (typeof v === 'string' && v ? (/^([a-z]+:|\/\/)/i.test(v) ? v : opts.assetUrl(isAbsolute(v) ? v : join(project.dir, v))) : undefined);
  const aliases = Object.fromEntries(Object.entries(collections).filter(([k]) => !RESERVED_NAMES.includes(k) && /^[a-zA-Z_]\w*$/.test(k)));
  const context = {
    ...aliases,
    theme: { ...theme, logo_url: projectAsset(theme.logo), cover_image_url: projectAsset(theme.cover_image) },
    report,
    findings,
    collections,
    stats,
    design: {
      id: design.id,
      name: design.name,
      severities: design.severities,
      report_fields: design.reportFields,
      finding_fields: design.findingFields,
      collections: design.collections.map((c) => ({ ...c, item_label: c.itemLabel, item_var: c.itemVar, title_field: c.titleField, has_severity: c.hasSeverity, page_break: c.pageBreak })),
    },
    now: new Date(),
  };

  let body = '';
  try {
    body = env.render(design.templatePath, context);
  } catch (e) {
    const err = parseNunjucksError((e as Error).message, design.templatePath);
    issues.push({ ...err, severity: 'error' });
    body = `<div class="render-error"><h1 class="unnumbered">Template error</h1><pre>${esc(err.message)}</pre><p>${esc(relative(project.dir, err.file))}${err.line ? `:${err.line}` : ''}</p></div>`;
  }
  body = postProcess(body);

  const css = design.stylesheets.map((p) => `/* ${p} */\n${rewriteCssUrls(opts.read(p), dirname(p), opts.assetUrl)}`).join('\n\n') + '\n\n' + themeCss(theme, project.dir, opts.assetUrl);
  return {
    title: String(project.report.title ?? 'Report'),
    body,
    css,
    issues,
    dependencies: [design.templatePath, ...loader.used, ...design.stylesheets],
  };
}

const RESOLVED = ['fixed', 'solved', 'resolved', 'closed'];
const PARTIAL = ['partial', 'partially_fixed', 'partially_solved'];

/** Fixed/solved items: `fixed: true` or a retest/remediation status meaning solved. */
export function isResolved(v: Ctx): boolean {
  return v.fixed === true || RESOLVED.includes(String(v.retest_status ?? v.remediation_status ?? ''));
}

function isPartial(v: Ctx): boolean {
  return PARTIAL.includes(String((v.raw as Ctx | undefined)?.retest_status ?? v.retest_status ?? ''));
}

function computeStats(list: Ctx[], design: Design, isFixed: (f: Ctx) => boolean) {
  const sevOf = (f: Ctx) => (typeof f.severity === 'string' && design.severities.some((s) => s.id === f.severity) ? f.severity : findingSeverity(f, design).id);
  const by_severity = design.severities.map((s) => ({ ...s, count: list.filter((f) => sevOf(f) === s.id).length }));
  const counts: Record<string, number> = Object.fromEntries(by_severity.map((s) => [s.id, s.count]));
  const fixed = list.filter(isFixed).length;
  const partial = list.filter(isPartial).length;
  return { total: list.length, by_severity, counts, fixed, partial, open: list.length - fixed };
}

interface GlobalsCtx {
  design: Design;
  collections: Record<string, Ctx[]>;
  findings: Ctx[];
  stats: ReturnType<typeof computeStats>;
  opts: RenderOptions;
  loader: DesignLoader;
  scopes: Map<string, Scope>;
  locale: string;
  projectDir: string;
}

function addGlobals(env: nunjucks.Environment, g: GlobalsCtx) {
  const { design, collections, findings, stats, opts, loader, scopes, locale, projectDir } = g;
  const safe = (s: string) => new SafeString(s);
  const scopeOf = (obj: Ctx | undefined, explicit?: string): Scope | undefined => {
    if (explicit) return scopes.get(explicit === 'report' ? '_report' : explicit === 'finding' ? 'findings' : explicit);
    return scopes.get(String(obj?._scope ?? '_report'));
  };
  const listScope = (list: Ctx[], explicit?: string) => scopeOf(list?.[0], explicit);
  const fieldOf = (scope: Scope | undefined, id: string) => scope?.fields.find((f) => f.id === id);
  const badge = (label: string, color: string, cls = '') => `<span class="badge ${cls}" style="--badge:${esc(color)}">${esc(label)}</span>`;

  /** HTML for any field value, according to its type. */
  const renderValue = (f: FieldDef | undefined, obj: Ctx, id: string): string => {
    const v = obj[id];
    const raw = (obj.raw as Ctx | undefined)?.[id] ?? v;
    if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) return '';
    if (!f) return esc(v);
    switch (f.type) {
      case 'markdown':
        return String(v);
      case 'boolean':
        return raw === true ? '<span class="status status-fixed">Yes</span>' : '<span class="status status-open">No</span>';
      case 'enum': {
        if (id === 'severity' && obj.severity_color) return badge(String(obj.severity_label), String(obj.severity_color));
        const o = f.options?.find((x) => x.value === String(raw));
        return o?.color ? badge(o.label, o.color, `badge-${esc(o.value)}`) : esc(o?.label ?? raw);
      }
      case 'list':
        return `<ul class="field-list">${(Array.isArray(v) ? v : [v]).map((x) => `<li>${x instanceof SafeString ? String(x) : esc(x)}</li>`).join('')}</ul>`;
      case 'table':
        return tableHtml(f, v as Ctx[]);
      case 'code':
        return String(v);
      case 'screenshots':
        return screenshotsHtml(v as Screenshot[]);
      case 'image':
        return `<img class="field-image" src="${esc(/^[a-z]+:/i.test(String(raw)) ? raw : opts.assetUrl(isAbsolute(String(raw)) ? String(raw) : join(projectDir, String(raw))))}" alt="">`;
      case 'cvss': {
        const s = scoreCvss(raw);
        return s ? `<span class="score">${s.score.toFixed(1)}</span> <span class="mono">${esc(s.vector)}</span>` : esc(raw);
      }
      case 'color':
        return `<span class="swatch" style="background:${esc(raw)}"></span> ${esc(raw)}`;
      default:
        return esc((obj.display as Ctx)?.[id] ?? v);
    }
  };

  const screenshotsHtml = (list: Screenshot[] | undefined) =>
    (Array.isArray(list) ? list : [])
      .map(
        (s) =>
          `<figure class="figure screenshot"><img src="${esc(s.image)}" alt=""${s.width ? ` style="width:${esc(s.width)}"` : ''}>${s.caption ? `<figcaption>${s.caption}</figcaption>` : ''}</figure>`,
      )
      .join('');
  env.addGlobal('screenshots', (list: Screenshot[]) => safe(screenshotsHtml(list)));

  const tableHtml = (f: FieldDef, rows: Ctx[] | undefined) => {
    const cols = f.columns ?? [];
    const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join('');
    const body = (rows ?? [])
      .map((r) => `<tr>${cols.map((c) => `<td class="col-${esc(c.id)}">${renderValue(c, r, c.id)}</td>`).join('')}</tr>`)
      .join('');
    return `<table class="field-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  };

  const countBy = (list: Ctx[], fieldId: string, scopeId?: string) => {
    const scope = listScope(list, scopeId);
    const f = fieldOf(scope, fieldId);
    if (fieldId === 'severity' && scope?.collection?.hasSeverity) return design.severities.map((s) => ({ value: s.id, label: s.label, color: s.color, count: list.filter((x) => x.severity === s.id).length }));
    if (f?.type === 'boolean')
      return [
        { value: true, label: 'Yes', color: '#2e7d32', count: list.filter((x) => (x.raw as Ctx)?.[fieldId] === true).length },
        { value: false, label: 'No', color: '#c62828', count: list.filter((x) => (x.raw as Ctx)?.[fieldId] !== true).length },
      ];
    const options = f?.options ?? [...new Set(list.map((x) => String((x.raw as Ctx)?.[fieldId] ?? '')))].filter(Boolean).map((v) => ({ value: v, label: v, color: undefined }));
    return options.map((o, i) => ({ value: o.value, label: o.label, color: o.color ?? PALETTE[i % PALETTE.length], count: list.filter((x) => String((x.raw as Ctx)?.[fieldId]) === o.value).length }));
  };

  env.addGlobal('toc', (depth = 2, title = 'Table of Contents') => safe(`<nav class="toc" data-depth="${Number(depth)}" data-title="${esc(title)}"></nav>`));
  env.addGlobal('pagebreak', () => safe('<div class="pagebreak"></div>'));
  env.addGlobal('count_by', countBy);
  env.addGlobal('chart', (list: Ctx[], fieldId: string, kind = 'donut', caption = '', scopeId?: string) => {
    const slices: Slice[] = countBy(list ?? [], fieldId, scopeId).map((c) => ({ label: c.label, value: c.count, color: c.color }));
    return safe(kind === 'bar' ? barChart(slices, { caption }) : donutChart(slices, { caption, center: String((list ?? []).length) }));
  });
  env.addGlobal('severity_chart', (kind = 'donut', caption = '') => {
    const slices = stats.by_severity.map((s) => ({ label: s.label, value: s.count, color: s.color }));
    return safe(kind === 'bar' ? barChart(slices, { caption }) : donutChart(slices, { caption, center: String(stats.total) }));
  });
  env.addGlobal('status_chart', (caption = '', labels = 'Fixed,Open') => {
    // With a retest status enum every status gets its own slice (solved / partial / not solved …).
    const statusField = design.collections.find((c) => c.id === 'findings')?.fields.find((f) => f.id === 'retest_status' && f.type === 'enum');
    if (statusField && findings.length) {
      const slices = countBy(findings, 'retest_status', 'findings').map((c) => ({ label: c.label, value: c.count, color: c.color }));
      return safe(donutChart(slices, { caption, center: `${Math.round((stats.fixed / findings.length) * 100)}%` }));
    }
    const [fixedLabel, openLabel] = String(labels).split(',');
    return safe(
      donutChart(
        [
          { label: fixedLabel, value: stats.fixed, color: '#2e7d32' },
          { label: openLabel, value: stats.open, color: '#c62828' },
        ],
        { caption, center: stats.total ? `${Math.round((stats.fixed / stats.total) * 100)}%` : '–' },
      ),
    );
  });
  env.addGlobal('badge', (value: string, text?: string, color?: string) => {
    const s = design.severities.find((x) => x.id === value);
    return safe(badge(text ?? s?.label ?? value, color ?? s?.color ?? '#888', `badge-${esc(value)}`));
  });
  env.addGlobal('ref', (id: string, text?: string) => {
    const all = Object.values(collections).flat();
    const f = all.find((x) => x.id === id || x.anchor === id);
    if (!f) return safe(`<span class="ref ref-missing">[unknown item ${esc(id)}]</span>`);
    return safe(`<a class="ref" href="#${f.anchor}">${esc(text ?? `${f.number} ${f.title as string}`)}</a>`);
  });
  env.addGlobal('cvss_table', (vector: string) => {
    const s = scoreCvss(vector);
    if (!s) return '';
    return safe(`<table class="cvss-table"><tbody>${cvssMetrics(s.vector).map((m) => `<tr><th>${esc(m.name)}</th><td>${esc(m.value)}</td></tr>`).join('')}</tbody></table>`);
  });
  env.addGlobal('render_field', (obj: Ctx, fieldId: string, scopeId?: string) => safe(renderValue(fieldOf(scopeOf(obj, scopeId), fieldId), obj ?? {}, fieldId)));
  env.addGlobal('field_label', (scopeId: string, id: string) => fieldOf(scopeOf(undefined, scopeId), id)?.label ?? id);
  env.addGlobal('fields_of', (scopeId: string, types?: string) => {
    const list = scopeOf(undefined, scopeId)?.fields ?? [];
    return types ? list.filter((f) => String(types).split(',').includes(f.type)) : list;
  });
  const itemTable = (list: Ctx[], columns?: string, scopeId?: string) => {
    const scope = listScope(list ?? [], scopeId);
    const c = scope?.collection;
    const cols = columns
      ? String(columns).split(',').map((x) => x.trim())
      : (c?.columns ?? ['number', c?.titleField ?? 'title', ...(scope?.fields ?? []).filter((f) => !BODY_TYPES.includes(f.type) && f.type !== 'list' && f.id !== (c?.titleField ?? 'title') && f.id !== 'cvss').slice(0, 3).map((f) => f.id)]);
    const heads: Record<string, string> = { number: '#', score: 'CVSS', status: 'Status' };
    const cell = (f: Ctx, col: string) => {
      if (col === 'number') return esc(f.number);
      if (col === 'title' || col === c?.titleField) return `<a href="#${esc(f.anchor)}">${esc(f.title)}</a>`;
      if (col === 'score') return f.score === undefined ? '–' : Number(f.score).toFixed(1);
      if (col === 'status') {
        if ((f.raw as Ctx)?.retest_status && fieldOf(scope, 'retest_status')) return renderValue(fieldOf(scope, 'retest_status'), f, 'retest_status');
        return f.is_fixed ? '<span class="status status-fixed">Fixed</span>' : '<span class="status status-open">Open</span>';
      }
      return renderValue(fieldOf(scope, col), f, col);
    };
    const head = cols.map((col) => `<th class="col-${esc(col)}">${esc(heads[col] ?? fieldOf(scope, col)?.label ?? col)}</th>`).join('');
    const rows = (list ?? []).map((f) => `<tr id="${esc(f.anchor)}">${cols.map((col) => `<td class="col-${esc(col)}">${cell(f, col)}</td>`).join('')}</tr>`).join('');
    return safe(`<table class="finding-table item-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`);
  };
  env.addGlobal('item_table', itemTable);
  env.addGlobal('finding_table', (list: Ctx[] = findings, columns = 'number,title,severity,score') => {
    const html = String(itemTable(list, columns, 'findings'));
    // In overview tables the row must not steal the anchor of the finding section.
    return safe(html.replace(/<tr id="[^"]*">/g, '<tr>'));
  });
  env.addGlobal('timeline', (list: Ctx[], timeField = 'timestamp', scopeId?: string) => {
    const scope = listScope(list ?? [], scopeId);
    const c = scope?.collection;
    const enumField = scope?.fields.find((f) => f.type === 'enum' && f.id !== 'severity');
    const md = scope?.fields.find((f) => f.type === 'markdown');
    const extras = (scope?.fields ?? []).filter((f) => f.type === 'code' || f.type === 'screenshots');
    const items = (list ?? [])
      .map((e) => {
        const raw = e.raw as Ctx;
        const opt = enumField?.options?.find((o) => o.value === raw?.[enumField.id]);
        const when = raw?.[timeField];
        const f = fieldOf(scope, timeField);
        return `<li class="tl-item" id="${esc(e.anchor)}" style="--tl:${esc(opt?.color ?? 'var(--accent)')}">
<div class="tl-time">${esc(formatDate(when, f?.type === 'date' ? 'D MMM YYYY' : 'D MMM YYYY · HH:mm', locale))}</div>
<div class="tl-body"><div class="tl-title">${esc(e.title)}${opt ? ` <span class="tl-tag">${esc(opt.label)}</span>` : ''}</div>${md ? String(e[md.id] ?? '') : ''}${extras.map((f) => renderValue(f, e, f.id)).join('')}</div></li>`;
      })
      .join('');
    return safe(`<ol class="timeline${c ? ` timeline-${esc(c.id)}` : ''}">${items}</ol>`);
  });
  const hasValue = (obj: Ctx, id: string) => {
    const v = (obj?.raw as Ctx | undefined)?.[id];
    return !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length));
  };
  /** Report fields printed in a section of generic templates: before | after | details | none. */
  env.addGlobal('report_fields_in', (section: string, report: Ctx) =>
    design.reportFields.filter((f) => (f.section ?? (['markdown', 'code', 'screenshots'].includes(f.type) ? 'before' : 'details')) === section && hasValue(report, f.id)),
  );
  /** Fields of an item with a value: "meta" (short values) or "body" (markdown, tables, images). */
  env.addGlobal('item_fields', (item: Ctx, kind = 'meta') => {
    const scope = scopeOf(item);
    const c = scope?.collection;
    const body = BODY_TYPES;
    return (scope?.fields ?? []).filter((f) => f.id !== (c?.titleField ?? 'title') && (kind === 'body' ? body.includes(f.type) : !body.includes(f.type)) && hasValue(item, f.id));
  });
  env.addGlobal('template_exists', (name: string) => !!loader.resolvePath(name));
  env.addGlobal('asset', (name: string) => {
    const path = loader.resolvePath(join('assets', name)) ?? loader.resolvePath(name);
    return path ? opts.assetUrl(path) : name;
  });
}

/* ---------------------------------------------------------- post-process */

/**
 * Numbers h1–h3 (except `.unnumbered` and headings coming from Markdown fields),
 * gives them ids and fills every `<nav class="toc">` placeholder.
 */
export function postProcess(html: string): string {
  const counters = [0, 0, 0];
  const used = new Set<string>();
  const entries: { level: number; id: string; text: string; number: string }[] = [];
  const out = html.replace(/<h([1-3])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/g, (all, lvl: string, attrs: string, inner: string) => {
    if (/class="[^"]*\bmd-heading\b/.test(attrs)) return all;
    const level = Number(lvl);
    const unnumbered = /class="[^"]*\b(unnumbered|no-toc)\b/.test(attrs);
    let number = '';
    if (!unnumbered) {
      counters[level - 1]++;
      for (let i = level; i < 3; i++) counters[i] = 0;
      number = counters.slice(0, level).join('.');
    }
    let id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    if (!id) {
      const base = slug(inner);
      id = base;
      for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
      attrs += ` id="${id}"`;
    }
    used.add(id);
    if (!/class="[^"]*\bno-toc\b/.test(attrs)) entries.push({ level, id, text: inner.replace(/<[^>]+>/g, '').trim(), number });
    const num = number ? `<span class="heading-number">${number}</span> ` : '';
    return `<h${lvl}${attrs}>${num}${inner}</h${lvl}>`;
  });
  return out.replace(/<nav class="toc" data-depth="(\d)" data-title="([^"]*)"><\/nav>/g, (_, depth: string, title: string) => {
    const items = entries
      .filter((e) => e.level <= Number(depth))
      .map((e) => `<li class="toc-l${e.level}"><a href="#${e.id}"><span class="toc-number">${e.number}</span><span class="toc-text">${e.text}</span></a></li>`)
      .join('');
    return `<nav class="toc">${title ? `<div class="toc-title">${title}</div>` : ''}<ol>${items}</ol></nav>`;
  });
}

function rewriteCssUrls(css: string, dir: string, assetUrl: (p: string) => string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, q: string, url: string) =>
    /^([a-z]+:|#|\/\/|var\()/i.test(url) ? all : `url(${q}${assetUrl(isAbsolute(url) ? url : join(dir, url))}${q})`,
  );
}

export function cleanNunjucksMessage(msg: string): string {
  return msg
    .replace(/^\(.*?\)\s*/, '')
    .replace(/\[Line \d+, Column \d+\]\s*/, '')
    .replace(/^Template render error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseNunjucksError(msg: string, fallbackFile: string): { file: string; message: string; line?: number; column?: number } {
  const file = /\(([^)]+?\.(?:html|njk|htm))\)/.exec(msg)?.[1] ?? fallbackFile;
  const pos = /\[Line (\d+), Column (\d+)\]/.exec(msg);
  return { file, message: cleanNunjucksMessage(msg), line: pos ? Number(pos[1]) : undefined, column: pos ? Number(pos[2]) : undefined };
}
