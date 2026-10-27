import { basename, extname, isAbsolute, join } from 'node:path';
import type { FieldDef, SeverityDef } from './types';

/**
 * Visual theme: colors, fonts, cover and page settings edited with the graphical
 * Theme editor. Values come from (lowest to highest priority) the defaults below,
 * the `theme:` map of each design in the `extends` chain, and `theme:` in report.yaml.
 * They are exposed to stylesheets as CSS variables and to templates as `theme`.
 */
export const FONT_STACKS: { value: string; label: string }[] = [
  { value: "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif", label: 'Inter / System sans' },
  { value: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif", label: 'Segoe UI / Roboto' },
  { value: "'Helvetica Neue', Helvetica, Arial, sans-serif", label: 'Helvetica' },
  { value: "'Source Sans 3', 'Source Sans Pro', Arial, sans-serif", label: 'Source Sans' },
  { value: "'IBM Plex Sans', 'Segoe UI', Arial, sans-serif", label: 'IBM Plex Sans' },
  { value: "Georgia, 'Times New Roman', serif", label: 'Georgia (serif)' },
  { value: "'Merriweather', Georgia, serif", label: 'Merriweather (serif)' },
  { value: "'Palatino Linotype', Palatino, 'Book Antiqua', serif", label: 'Palatino (serif)' },
];

export const MONO_STACKS: { value: string; label: string }[] = [
  { value: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace", label: 'JetBrains Mono / Consolas' },
  { value: "'Fira Code', 'Fira Mono', Consolas, monospace", label: 'Fira Code' },
  { value: "'Source Code Pro', Consolas, monospace", label: 'Source Code Pro' },
  { value: "'Courier New', Courier, monospace", label: 'Courier New' },
];

export const COVER_LAYOUTS = [
  { value: 'gradient', label: 'Gradient' },
  { value: 'solid', label: 'Solid color' },
  { value: 'image', label: 'Background image' },
  { value: 'split', label: 'Split' },
  { value: 'minimal', label: 'Minimal' },
];

const INHERIT = 'Empty = as in the template.';

export const THEME_FIELDS: FieldDef[] = [
  { id: 'accent', type: 'color', label: 'Accent', group: 'Colors', default: '#3b3fd8', help: 'Headings, links, numbers and table headers.' },
  { id: 'ink', type: 'color', label: 'Text', group: 'Colors', default: '#1d2433' },
  { id: 'muted', type: 'color', label: 'Secondary text', group: 'Colors', default: '#6b7280' },
  { id: 'link_color', type: 'color', label: 'Links', group: 'Colors', help: INHERIT },
  { id: 'code_bg', type: 'color', label: 'Code background', group: 'Colors', default: '#f6f8fa' },

  { id: 'h1_color', type: 'color', label: 'Chapter titles (H1)', group: 'Headings', help: INHERIT },
  { id: 'h1_size', type: 'range', label: 'H1 size (pt)', group: 'Headings', min: 12, max: 32, step: 0.5, help: 'Empty = 20 pt.' },
  { id: 'h1_rule', type: 'boolean', label: 'Line under chapter titles', group: 'Headings', default: true },
  { id: 'h1_rule_color', type: 'color', label: 'Line color', group: 'Headings', help: 'Empty = accent.' },
  { id: 'h2_color', type: 'color', label: 'Section titles (H2, finding titles)', group: 'Headings', help: INHERIT },
  { id: 'h2_size', type: 'range', label: 'H2 size (pt)', group: 'Headings', min: 9, max: 24, step: 0.5, help: 'Empty = 13.5 pt.' },
  { id: 'h3_color', type: 'color', label: 'Sub-section titles (H3)', group: 'Headings', help: 'Empty = accent.' },
  { id: 'heading_case', type: 'enum', label: 'Chapter title case', group: 'Headings', default: 'none', options: [{ value: 'none', label: 'As written' }, { value: 'uppercase', label: 'UPPERCASE' }] },

  { id: 'accent_soft', type: 'color', label: 'Header background', group: 'Tables', default: '#eef0ff', help: 'Header row of tables (findings overview, Markdown tables…).' },
  { id: 'table_header_text', type: 'color', label: 'Header text', group: 'Tables', help: INHERIT },
  { id: 'table_label_color', type: 'color', label: 'Row labels', group: 'Tables', help: 'First column of label / value tables (finding details, document information). ' + INHERIT },
  { id: 'table_border', type: 'color', label: 'Borders', group: 'Tables', help: INHERIT },
  { id: 'table_stripes', type: 'boolean', label: 'Striped rows', group: 'Tables', default: false },
  { id: 'caption_color', type: 'color', label: 'Table and figure captions', group: 'Tables', help: INHERIT },

  { id: 'font_body', type: 'font', label: 'Body font', group: 'Typography', default: FONT_STACKS[0].value, options: FONT_STACKS },
  { id: 'font_headings', type: 'font', label: 'Headings font', group: 'Typography', default: FONT_STACKS[0].value, options: FONT_STACKS },
  { id: 'font_mono', type: 'font', label: 'Code font', group: 'Typography', default: MONO_STACKS[0].value, options: MONO_STACKS },
  { id: 'font_size', type: 'range', label: 'Base size (pt)', group: 'Typography', default: 10, min: 8, max: 13, step: 0.5 },
  { id: 'line_height', type: 'range', label: 'Line height', group: 'Typography', default: 1.55, min: 1.2, max: 2, step: 0.05 },
  { id: 'heading_numbers', type: 'boolean', label: 'Number headings (1, 1.1 …)', group: 'Typography', default: true },

  { id: 'cover_layout', type: 'enum', display: 'cards', label: 'Cover layout', group: 'Cover', default: 'gradient', options: COVER_LAYOUTS },
  { id: 'cover_start', type: 'color', label: 'Cover color', group: 'Cover', default: '#14183a' },
  { id: 'cover_end', type: 'color', label: 'Cover gradient end', group: 'Cover', default: '#3b3fd8', help: 'Second color of "Gradient", right side of "Split".' },
  { id: 'cover_angle', type: 'range', label: 'Gradient direction (°)', group: 'Cover', min: 0, max: 360, step: 5, help: 'Empty = 160°.' },
  { id: 'cover_text', type: 'color', label: 'Cover text', group: 'Cover', default: '#ffffff' },
  { id: 'cover_title_size', type: 'range', label: 'Cover title size (pt)', group: 'Cover', min: 18, max: 56, step: 1, help: INHERIT },
  { id: 'cover_image', type: 'image', label: 'Cover image', group: 'Cover', help: 'Used by the "Background image" and "Split" layouts.' },
  { id: 'logo', type: 'image', label: 'Logo', group: 'Cover', help: 'Leave empty to use the logo of the design.' },
  { id: 'logo_width', type: 'range', label: 'Logo width (mm)', group: 'Cover', default: 44, min: 15, max: 120, step: 1 },
  { id: 'cover_kicker', type: 'string', label: 'Text above the title', group: 'Cover', placeholder: 'Defaults to the design name' },
  { id: 'cover_meta', type: 'boolean', label: 'Show date, version and authors', group: 'Cover', default: true },

  { id: 'page_size', type: 'enum', label: 'Page size', group: 'Page', default: 'A4', options: [{ value: 'A4', label: 'A4' }, { value: 'letter', label: 'US Letter' }, { value: 'A5', label: 'A5' }] },
  { id: 'margin', type: 'range', label: 'Side margins (mm)', group: 'Page', default: 18, min: 8, max: 35, step: 1 },
  { id: 'header', type: 'boolean', label: 'Running header', group: 'Page', default: true },
  { id: 'footer', type: 'boolean', label: 'Footer with page numbers', group: 'Page', default: true },
];

/** Values shown (not applied) for optional settings that are empty: what the base styles use. */
export const THEME_HINTS: Record<string, unknown> = { h1_size: 20, h2_size: 13.5, cover_angle: 160, cover_title_size: 32 };

/** Shown defaults of a theme editor: hints, the design's severity colors, then the inherited theme. */
export function themeDefaultsFor(design: { severities: SeverityDef[] } | undefined, inherited: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...THEME_HINTS, ...Object.fromEntries((design?.severities ?? []).map((s) => [`severity_${s.id}`, s.color])), ...resolveTheme(inherited) };
}

/** Theme fields for a design: the fixed ones plus one color per severity of the design. */
export function themeFieldsFor(design?: { severities: SeverityDef[] }): FieldDef[] {
  const sev: FieldDef[] = (design?.severities ?? []).map((s) => ({ id: `severity_${s.id}`, type: 'color', label: s.label, group: 'Severities', default: s.color }));
  const i = THEME_FIELDS.findIndex((f) => f.group === 'Page');
  return [...THEME_FIELDS.slice(0, i), ...sev, ...THEME_FIELDS.slice(i)];
}

/** Severities with the colors chosen in the theme (`severity_<id>`). */
export function themedSeverities(severities: SeverityDef[], theme: Record<string, unknown>): SeverityDef[] {
  return severities.map((s) => {
    const c = theme[`severity_${s.id}`];
    return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? { ...s, color: c } : s;
  });
}

export type Theme = Record<string, unknown>;

export function resolveTheme(...layers: (Record<string, unknown> | undefined)[]): Theme {
  const theme: Theme = {};
  for (const f of THEME_FIELDS) if (f.default !== undefined) theme[f.id] = f.default;
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const [k, v] of Object.entries(layer)) if (v !== undefined && v !== null && v !== '') theme[k] = v;
  }
  return theme;
}

const FONT_FILE = /\.(woff2?|ttf|otf)$/i;

function cssString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** CSS variables and page rules generated from the theme; appended after the design stylesheets. */
export function themeCss(theme: Theme, baseDir: string, assetUrl: (abs: string) => string): string {
  const faces: string[] = [];
  const font = (v: unknown, fallback: string) => {
    const s = String(v ?? '');
    if (!FONT_FILE.test(s)) return s || fallback;
    const family = `theme-${basename(s, extname(s)).replace(/[^\w-]/g, '')}`;
    const fmt = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' }[extname(s).toLowerCase()];
    faces.push(`@font-face { font-family: ${cssString(family)}; src: url(${cssString(assetUrl(isAbsolute(s) ? s : join(baseDir, s)))}) format('${fmt}'); }`);
    return `${cssString(family)}, ${fallback}`;
  };
  const color = (v: unknown, d: string) => (/^#[0-9a-f]{3,8}$|^rgb|^hsl|^[a-z]+$/i.test(String(v ?? '')) ? String(v) : d);
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const body = font(theme.font_body, FONT_STACKS[0].value);
  const margin = num(theme.margin, 18);
  const lines = [
    ...faces,
    `:root {`,
    `  --accent: ${color(theme.accent, '#3b3fd8')};`,
    `  --ink: ${color(theme.ink, '#1d2433')};`,
    `  --muted: ${color(theme.muted, '#6b7280')};`,
    `  --accent-soft: ${color(theme.accent_soft, '#eef0ff')};`,
    `  --code-bg: ${color(theme.code_bg, '#f6f8fa')};`,
    `  --cover-start: ${color(theme.cover_start, '#14183a')};`,
    `  --cover-end: ${color(theme.cover_end, '#3b3fd8')};`,
    `  --cover-text: ${color(theme.cover_text, '#ffffff')};`,
    `  --logo-width: ${num(theme.logo_width, 44)}mm;`,
    `  --font: ${body};`,
    `  --font-headings: ${font(theme.font_headings, body)};`,
    `  --mono: ${font(theme.font_mono, MONO_STACKS[0].value)};`,
    `  --base-size: ${num(theme.font_size, 10)}pt;`,
    `  --line-height: ${num(theme.line_height, 1.55)};`,
    `  --margin: ${margin}mm;`,
    `}`,
    `@page { size: ${String(theme.page_size ?? 'A4').replace(/[^\w ]/g, '')}; margin-left: ${margin}mm; margin-right: ${margin}mm; }`,
  ];
  if (theme.header === false) lines.push('@page { @top-left { content: none; } @top-center { content: none; } @top-right { content: none; } }');
  if (theme.footer === false) lines.push('@page { @bottom-left { content: none; } @bottom-center { content: none; } @bottom-right { content: none; } }');
  if (theme.heading_numbers === false) lines.push('.heading-number, .toc-number { display: none !important; }');
  // Optional overrides: only emitted when set, so each template keeps its own look otherwise.
  const set = (v: unknown) => v !== undefined && v !== null && v !== '';
  const c = (v: unknown) => color(v, 'inherit');
  if (set(theme.link_color)) lines.push(`a:not(.toc a) { color: ${c(theme.link_color)} !important; }`);
  if (set(theme.h1_color)) lines.push(`h1 { color: ${c(theme.h1_color)} !important; }`);
  if (set(theme.h1_size)) lines.push(`h1 { font-size: ${num(theme.h1_size, 20)}pt !important; }`);
  if (theme.h1_rule === false) lines.push('h1 { border-bottom: none !important; padding-bottom: 0 !important; }');
  else if (set(theme.h1_rule_color)) lines.push(`h1 { border-bottom-color: ${c(theme.h1_rule_color)} !important; }`);
  if (set(theme.h2_color)) lines.push(`h2 { color: ${c(theme.h2_color)} !important; }`);
  if (set(theme.h2_size)) lines.push(`h2 { font-size: ${num(theme.h2_size, 13.5)}pt !important; }`);
  if (set(theme.h3_color)) lines.push(`h3 { color: ${c(theme.h3_color)} !important; }`);
  if (theme.heading_case === 'uppercase') lines.push('h1 { text-transform: uppercase; letter-spacing: .03em; }');
  if (set(theme.table_header_text)) lines.push(`thead th { color: ${c(theme.table_header_text)} !important; }`);
  if (set(theme.table_label_color)) lines.push(`.finding-meta th, .info-table th, .field-table th, tbody th { color: ${c(theme.table_label_color)} !important; }`);
  if (set(theme.table_border)) lines.push(`:root { --line: ${c(theme.table_border)}; } table th, table td { border-color: ${c(theme.table_border)} !important; }`);
  if (theme.table_stripes === true) lines.push('tbody tr:nth-child(even) > td { background: color-mix(in srgb, var(--accent-soft) 55%, transparent); }');
  if (set(theme.caption_color)) lines.push(`figcaption, caption, .chart-caption { color: ${c(theme.caption_color)} !important; }`);
  if (set(theme.cover_angle)) lines.push(`.cover--gradient { background: linear-gradient(${num(theme.cover_angle, 160)}deg, var(--cover-start) 0%, var(--cover-end) 100%) !important; }`);
  if (set(theme.cover_title_size)) lines.push(`.cover-title { font-size: ${num(theme.cover_title_size, 28)}pt !important; }`);
  return `/* theme */\n${lines.join('\n')}\n`;
}
