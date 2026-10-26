import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { scoreCvss } from './cvss';
import { screenshotPath } from './design';
import { findingSeverity, numberFor } from './project';
import { displayValue, isResolved, parseDate, placeholderExpander } from './render';
import type { CollectionDef, Design, FieldDef, Project } from './types';
import { zip } from './zip';

/**
 * Data exports of a project (JSON, CSV, Excel, SARIF) for ticketing systems,
 * spreadsheets and vulnerability management tools. Placeholders are resolved,
 * Markdown is kept as Markdown.
 */

export type ExportFormat = 'json' | 'csv' | 'xlsx' | 'sarif';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string; detail: string }[] = [
  { id: 'xlsx', label: 'Excel workbook', ext: 'xlsx', detail: 'One sheet per collection plus the report details, with severity colours and filters.' },
  { id: 'csv', label: 'CSV', ext: 'csv', detail: 'One collection as comma separated values (Jira, DefectDojo, spreadsheets).' },
  { id: 'json', label: 'JSON', ext: 'json', detail: 'Report, every collection and computed values (number, severity, score).' },
  { id: 'sarif', label: 'SARIF 2.1.0', ext: 'sarif', detail: 'Findings for code scanning / vulnerability management tools (GitHub, DefectDojo, Azure DevOps).' },
];

export interface ExportItem {
  number: string;
  id: string;
  /** path relative to the project */
  file: string;
  title: string;
  severity?: string;
  severity_label?: string;
  severity_color?: string;
  score?: number;
  cvss_vector?: string;
  resolved: boolean;
  values: Record<string, unknown>;
  /** one line (or a few) of text per field, for spreadsheets */
  text: Record<string, string>;
}

export interface ExportCollection {
  id: string;
  label: string;
  itemLabel: string;
  hasSeverity: boolean;
  fields: { id: string; label: string; type: string }[];
  items: ExportItem[];
}

export interface ExportData {
  generator: string;
  exported_at: string;
  design: { id: string; name: string };
  report: Record<string, unknown>;
  report_text: Record<string, string>;
  report_fields: { id: string; label: string; type: string }[];
  collections: ExportCollection[];
}

export function exportData(project: Project, design: Design, now = new Date()): ExportData {
  const { expand, sortedItems, locale } = placeholderExpander(project, design);
  const conv = (f: FieldDef, raw: unknown, extra: Record<string, unknown>, file: string) => convertValue(f, raw, (t) => expand(t, extra, file, f.id), locale);

  const report: Record<string, unknown> = {};
  const reportText: Record<string, string> = {};
  for (const f of design.reportFields) {
    const raw = project.report[f.id] ?? f.default;
    if (raw === undefined || raw === null || raw === '') continue;
    const c = conv(f, raw, {}, project.reportFile);
    report[f.id] = c.value;
    reportText[f.id] = c.text;
  }

  const collections = design.collections.map((c): ExportCollection => {
    const list = sortedItems[c.id] ?? [];
    return {
      id: c.id,
      label: c.label,
      itemLabel: c.itemLabel,
      hasSeverity: c.hasSeverity,
      fields: c.fields.map(fieldInfo),
      items: list.map((item, i) => {
        const number = numberFor(c, i, list.length);
        const out: ExportItem = {
          number,
          id: item.id,
          file: relative(project.dir, item.file).split('\\').join('/'),
          title: String(item.values[c.titleField] ?? item.values.title ?? item.id),
          resolved: isResolved(item.values),
          values: {},
          text: {},
        };
        let extraItem: Record<string, unknown> = { ...item.values, number };
        if (c.hasSeverity) {
          const sev = findingSeverity(item.values, design);
          const def = design.severities.find((s) => s.id === sev.id)!;
          Object.assign(out, { severity: sev.id, severity_label: def.label, severity_color: def.color, score: sev.score, cvss_vector: scoreCvss(item.values.cvss)?.vector });
          extraItem = { ...extraItem, severity: sev.id, score: sev.score };
        }
        const extra = { [c.itemVar]: extraItem, item: extraItem };
        for (const f of c.fields) {
          const raw = item.values[f.id] ?? f.default;
          if (raw === undefined || raw === null || raw === '') continue;
          const v = conv(f, raw, extra, item.file);
          out.values[f.id] = v.value;
          out.text[f.id] = v.text;
        }
        if (c.hasSeverity && out.severity_label) out.text.severity = out.severity_label;
        return out;
      }),
    };
  });

  return {
    generator: 'Report Studio',
    exported_at: now.toISOString(),
    design: { id: design.id, name: design.name },
    report,
    report_text: reportText,
    report_fields: design.reportFields.map(fieldInfo),
    collections,
  };
}

function fieldInfo(f: FieldDef) {
  return { id: f.id, label: f.label, type: f.type };
}

function isoDate(v: unknown, withTime: boolean): string {
  const d = parseDate(v);
  if (!d) return String(v);
  const iso = d.toISOString();
  return withTime ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
}

/** Value for JSON plus a text form for spreadsheets. */
function convertValue(f: FieldDef, raw: unknown, expand: (t: string) => string, locale: string): { value: unknown; text: string } {
  switch (f.type) {
    case 'markdown':
    case 'text':
    case 'string': {
      const s = expand(String(raw));
      return { value: s, text: s };
    }
    case 'code': {
      const m = /^\s*(```+|~~~+)([^\n]*)\n([\s\S]*?)\n?\1\s*$/.exec(String(raw));
      const code = m ? m[3] : String(raw);
      return { value: code, text: code };
    }
    case 'list': {
      const list = (Array.isArray(raw) ? raw : [raw]).map((x) => expand(String(x)));
      return { value: list, text: list.join('\n') };
    }
    case 'date':
    case 'datetime': {
      const s = isoDate(raw, f.type === 'datetime');
      return { value: s, text: s };
    }
    case 'table': {
      const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
      const cols = f.columns ?? [];
      const value = rows.map((r) => Object.fromEntries(cols.map((c) => [c.id, c.type === 'markdown' || c.type === 'string' ? expand(String(r?.[c.id] ?? '')) : r?.[c.id]])));
      const text = rows.map((r) => cols.map((c) => displayValue(c, r?.[c.id], locale)).filter(Boolean).join(' · ')).join('\n');
      return { value, text };
    }
    case 'screenshots': {
      const shots = (Array.isArray(raw) ? raw : [raw])
        .map((x) => ({ image: screenshotPath(x), caption: typeof x === 'object' && x ? expand(String((x as { caption?: unknown }).caption ?? '')) : '' }))
        .filter((x) => x.image);
      return { value: shots, text: shots.map((s) => (s.caption ? `${s.image} — ${s.caption}` : s.image!)).join('\n') };
    }
    case 'cvss': {
      const s = scoreCvss(raw);
      return { value: s?.vector ?? String(raw), text: s?.vector ?? String(raw) };
    }
    case 'enum':
      return { value: raw, text: displayValue(f, raw, locale) };
    case 'boolean':
      return { value: raw === true, text: raw === true ? 'Yes' : 'No' };
    case 'number':
    case 'range':
      return { value: typeof raw === 'number' ? raw : Number(raw), text: String(raw) };
    default:
      return { value: raw, text: displayValue(f, raw, locale) };
  }
}

/* ------------------------------------------------------------------ JSON */

export function toJson(data: ExportData): string {
  return JSON.stringify(data, null, 2) + '\n';
}

/* ------------------------------------------------------------------- CSV */

interface Column {
  label: string;
  get: (i: ExportItem) => string | number | undefined;
  /** field type, for spreadsheet formatting */
  kind?: 'severity' | 'number' | 'enum' | 'long' | 'short';
  field?: string;
}

const LONG_TYPES = ['markdown', 'text', 'code', 'table', 'screenshots', 'list'];

function columns(c: ExportCollection, design: Design): Column[] {
  const col = design.collections.find((x) => x.id === c.id) as CollectionDef;
  const cols: Column[] = [];
  if (col.prefix) cols.push({ label: '#', get: (i) => i.number, kind: 'short' });
  cols.push({ label: 'ID', get: (i) => i.id, kind: 'short' });
  cols.push({ label: col.fields.find((f) => f.id === col.titleField)?.label ?? 'Title', get: (i) => i.title });
  if (c.hasSeverity) {
    cols.push({ label: 'Severity', get: (i) => i.severity_label, kind: 'severity' });
    cols.push({ label: 'Score', get: (i) => i.score, kind: 'number' });
  }
  for (const f of col.fields) {
    if (f.id === col.titleField || (c.hasSeverity && f.id === 'severity')) continue;
    const kind = f.type === 'number' || f.type === 'range' ? 'number' : f.type === 'enum' ? 'enum' : LONG_TYPES.includes(f.type) ? 'long' : 'short';
    cols.push({ label: f.type === 'cvss' ? 'CVSS vector' : f.label, get: (i) => (kind === 'number' ? (i.values[f.id] as number | undefined) : i.text[f.id]), kind, field: f.id });
  }
  cols.push({ label: 'File', get: (i) => i.file, kind: 'short' });
  return cols;
}

function csvCell(v: string | number | undefined): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of one collection. Starts with a BOM so that Excel reads it as UTF-8. */
export function toCsv(data: ExportData, design: Design, collectionId: string): string {
  const c = data.collections.find((x) => x.id === collectionId);
  if (!c) throw new Error(`Unknown collection "${collectionId}"`);
  const cols = columns(c, design);
  const lines = [cols.map((x) => csvCell(x.label)).join(','), ...c.items.map((i) => cols.map((x) => csvCell(x.get(i))).join(','))];
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ XLSX */

function xml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // characters that are invalid in XML 1.0
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function colName(n: number): string {
  let s = '';
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetName(label: string, used: Set<string>): string {
  const base = label.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

/** Text colour that stays readable on a fill colour. */
function contrast(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'FFFFFF';
  const n = parseInt(m[1], 16);
  const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.6 ? '1F2328' : 'FFFFFF';
}

/**
 * Excel workbook: a "Report" sheet with the report details and one sheet per
 * collection with frozen header, filters, wrapped long text and coloured
 * severity / status cells.
 */
export function toXlsx(data: ExportData, design: Design, accent = '#3b3fd8'): Buffer {
  // Styles: 0 default, 1 header, 2 wrap, 3 number, 4 key column, then one per colour.
  const fills: string[] = [];
  const colorStyle = new Map<string, number>();
  const styleFor = (hex: string | undefined): number | undefined => {
    if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return undefined;
    const key = hex.replace('#', '').toUpperCase();
    if (!colorStyle.has(key)) {
      fills.push(key);
      colorStyle.set(key, 5 + fills.length - 1);
    }
    return colorStyle.get(key);
  };
  const accentHex = /^#?[0-9a-f]{6}$/i.test(accent) ? accent.replace('#', '').toUpperCase() : '3B3FD8';

  type Cell = { v: string | number | undefined; s?: number };
  const sheets: { name: string; rows: Cell[][]; widths: number[]; filter: boolean }[] = [];
  const used = new Set<string>();

  // Report details.
  const reportRows: Cell[][] = [[{ v: 'Field', s: 1 }, { v: 'Value', s: 1 }]];
  reportRows.push([{ v: 'Report type', s: 4 }, { v: data.design.name, s: 2 }]);
  for (const f of data.report_fields) if (data.report_text[f.id] !== undefined) reportRows.push([{ v: f.label, s: 4 }, { v: data.report_text[f.id], s: 2 }]);
  for (const c of data.collections) {
    if (!c.hasSeverity || !c.items.length) continue;
    reportRows.push([{ v: '' }, { v: '' }], [{ v: `${c.label} by severity`, s: 1 }, { v: 'Count', s: 1 }]);
    for (const s of design.severities) reportRows.push([{ v: s.label, s: styleFor(s.color) }, { v: c.items.filter((i) => i.severity === s.id).length, s: 3 }]);
    reportRows.push([{ v: 'Resolved', s: 4 }, { v: c.items.filter((i) => i.resolved).length, s: 3 }]);
  }
  sheets.push({ name: sheetName('Report', used), rows: reportRows, widths: [28, 90], filter: false });

  for (const c of data.collections) {
    const def = design.collections.find((x) => x.id === c.id)!;
    const cols = columns(c, design);
    const rows: Cell[][] = [cols.map((x) => ({ v: x.label, s: 1 }))];
    for (const item of c.items) {
      rows.push(
        cols.map((x) => {
          const v = x.get(item);
          if (x.kind === 'severity') return { v, s: styleFor(item.severity_color) };
          if (x.kind === 'number') return { v: typeof v === 'number' && !Number.isNaN(v) ? v : undefined, s: 3 };
          if (x.kind === 'enum' && x.field) {
            const opt = def.fields.find((f) => f.id === x.field)?.options?.find((o) => o.value === String(item.values[x.field!]));
            return { v, s: styleFor(opt?.color) };
          }
          return { v, s: x.kind === 'long' ? 2 : undefined };
        }),
      );
    }
    const widths = cols.map((x, i) => {
      if (x.kind === 'long') return 60;
      const longest = Math.max(x.label.length, ...rows.slice(1).map((r) => String(r[i].v ?? '').length));
      return Math.min(50, Math.max(8, longest + 2));
    });
    sheets.push({ name: sheetName(c.label, used), rows, widths, filter: true });
  }

  const sheetXml = (s: (typeof sheets)[number]) => {
    const last = `${colName(Math.max(0, s.rows[0].length - 1))}${s.rows.length}`;
    const body = s.rows
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r
            .map((cell, ci) => {
              const ref = `${colName(ci)}${ri + 1}`;
              const st = cell.s !== undefined ? ` s="${cell.s}"` : '';
              if (cell.v === undefined || cell.v === '') return `<c r="${ref}"${st}/>`;
              if (typeof cell.v === 'number') return `<c r="${ref}"${st}><v>${cell.v}</v></c>`;
              // Excel cells hold at most 32767 characters.
              return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xml(cell.v.slice(0, 32000))}</t></is></c>`;
            })
            .join('')}</row>`,
      )
      .join('');
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>` +
      `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
      `<sheetData>${body}</sheetData>` +
      (s.filter && s.rows.length > 1 ? `<autoFilter ref="A1:${last}"/>` : '') +
      `</worksheet>`
    );
  };

  const font = (bold: boolean, color: string) => `<font>${bold ? '<b/>' : ''}<sz val="11"/><color rgb="FF${color}"/><name val="Calibri"/></font>`;
  const fillXml = (hex: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`;
  // Fonts: 0 normal, 1 bold white (header), 2 bold dark, then bold + contrast colour per fill.
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>` +
    `<fonts count="${3 + fills.length}">${font(false, '1F2328')}${font(true, contrast(accentHex))}${font(true, '1F2328')}${fills.map((f) => font(true, contrast(f))).join('')}</fonts>` +
    `<fills count="${3 + fills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fillXml(accentHex)}${fills.map(fillXml).join('')}</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${5 + fills.length}">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>` +
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>` +
    fills.map((_, i) => `<xf numFmtId="0" fontId="${3 + i}" fillId="${3 + i}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>`).join('') +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const files = [
    {
      name: '[Content_Types].xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        `</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'docProps/core.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>${xml(data.report_text.title ?? data.design.name)}</dc:title><dc:creator>Report Studio</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${data.exported_at.replace(/\.\d+Z$/, 'Z')}</dcterms:created>` +
        `</cp:coreProperties>`,
    },
    {
      name: 'xl/workbook.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        `<definedNames>${sheets
          .map((s, i) => (s.filter && s.rows.length > 1 ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(s.name.replace(/'/g, "''"))}'!$A$1:$${colName(s.rows[0].length - 1)}$${s.rows.length}</definedName>` : ''))
          .join('')}</definedNames>` +
        `</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    { name: 'xl/styles.xml', data: styles },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return zip(files);
}

/* ----------------------------------------------------------------- SARIF */

const SARIF_LEVEL: Record<string, string> = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'none' };

function firstParagraph(md: string): string {
  return (
    md
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('```') && !p.startsWith('!['))
      ?.replace(/\s*\n\s*/g, ' ') ?? ''
  );
}

/** Splits "42-57" / "42" into a SARIF region. */
function region(line: unknown): { startLine: number; endLine?: number } | undefined {
  const m = /^\s*(\d+)(?:\s*[-–]\s*(\d+))?/.exec(String(line ?? ''));
  if (!m) return undefined;
  return m[2] ? { startLine: Number(m[1]), endLine: Number(m[2]) } : { startLine: Number(m[1]) };
}

/**
 * SARIF 2.1.0 log of the collections that have a severity (findings). Every
 * finding is a rule and a result; resolved findings are reported as `pass`.
 * Locations come from `file`/`line` fields (code review) and from `affected`
 * or `hosts` entries.
 */
export function toSarif(data: ExportData): string {
  const rules: unknown[] = [];
  const results: unknown[] = [];
  for (const c of data.collections.filter((x) => x.hasSeverity)) {
    for (const item of c.items) {
      const v = item.values;
      const ruleId = item.number && item.number !== String(c.items.indexOf(item) + 1) ? item.number : item.id;
      const description = String(v.description ?? '');
      const recommendation = String(v.recommendation ?? '');
      const tags = ['security', ...(v.category ? [String(v.category)] : []), ...((Array.isArray(v.cwe) ? v.cwe : v.cwe ? [v.cwe] : []) as unknown[]).map(String)];
      rules.push({
        id: ruleId,
        name: item.title.replace(/[^\w]+/g, ' ').trim().replace(/\s+(\w)/g, (_, ch: string) => ch.toUpperCase()) || ruleId,
        shortDescription: { text: item.title },
        fullDescription: { text: firstParagraph(description) || item.title, markdown: description || undefined },
        help: recommendation ? { text: firstParagraph(recommendation), markdown: recommendation } : undefined,
        defaultConfiguration: { level: SARIF_LEVEL[item.severity ?? ''] ?? 'warning' },
        properties: { tags, 'security-severity': item.score !== undefined ? item.score.toFixed(1) : undefined, precision: 'high' },
      });

      const locations: unknown[] = [];
      if (v.file) locations.push({ physicalLocation: { artifactLocation: { uri: String(v.file) }, region: region(v.line) } });
      const targets = [
        ...(Array.isArray(v.affected) ? v.affected.map(String) : []),
        ...(Array.isArray(v.hosts) ? (v.hosts as Record<string, unknown>[]).map((h) => [h?.host, h?.port].filter(Boolean).join(':')) : []),
      ].filter(Boolean);
      for (const t of targets) {
        // "POST /api/login" or "/admin" are resolved against the report target URL.
        const path = /^(?:[A-Z]+\s+)?(\/[^\s]*)$/.exec(t)?.[1];
        const base = /^https?:\/\//i.test(String(data.report.target ?? '')) ? String(data.report.target) : undefined;
        if (/^[a-z][\w+.-]*:\/\//i.test(t)) locations.push({ physicalLocation: { artifactLocation: { uri: t } } });
        else if (path && base) locations.push({ physicalLocation: { artifactLocation: { uri: new URL(path, base).href } }, message: { text: t } });
        else if (v.file && locations.length === 1 && t === v.file) continue;
        else locations.push({ logicalLocations: [{ name: t, kind: 'resource' }] });
      }

      results.push({
        ruleId,
        kind: item.resolved ? 'pass' : 'fail',
        level: item.resolved ? 'none' : (SARIF_LEVEL[item.severity ?? ''] ?? 'warning'),
        message: { text: firstParagraph(description) || item.title },
        locations: locations.length ? locations : undefined,
        partialFingerprints: { reportStudioId: createHash('sha256').update(`${c.id}/${item.id}`).digest('hex').slice(0, 32) },
        properties: {
          severity: item.severity,
          cvss: item.cvss_vector,
          status: v.retest_status ?? (v.fixed === true ? 'fixed' : undefined),
          collection: c.id,
          file: item.file,
        },
      });
    }
  }
  const log = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'Report Studio', rules } },
        automationDetails: { id: `${data.design.id}/${String(data.report.title ?? 'report')}` },
        properties: { report: data.report.title, client: data.report.client, design: data.design.name },
        results,
      },
    ],
  };
  return JSON.stringify(log, (_, val) => (val === undefined ? undefined : val), 2) + '\n';
}

/** Writes an export: returns the file content for the chosen format. */
export function exportProject(project: Project, design: Design, format: ExportFormat, opts: { collection?: string; accent?: string } = {}): string | Buffer {
  const data = exportData(project, design);
  switch (format) {
    case 'json':
      return toJson(data);
    case 'csv':
      return toCsv(data, design, opts.collection ?? data.collections.find((c) => c.hasSeverity)?.id ?? data.collections[0]?.id ?? '');
    case 'xlsx':
      return toXlsx(data, design, opts.accent);
    case 'sarif':
      return toSarif(data);
  }
}
