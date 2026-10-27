export type FieldType =
  | 'string'
  | 'text'
  | 'markdown'
  | 'code'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'datetime'
  | 'list'
  | 'table'
  | 'cvss'
  | 'image'
  | 'screenshots'
  | 'user'
  | 'color'
  | 'font'
  | 'range';

export const FIELD_TYPES: FieldType[] = ['string', 'text', 'markdown', 'code', 'number', 'boolean', 'enum', 'date', 'datetime', 'list', 'table', 'cvss', 'image', 'screenshots', 'user', 'color', 'font', 'range'];

export interface FieldOption {
  value: string;
  label: string;
  color?: string;
}

export interface FieldDef {
  id: string;
  type: FieldType;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  group?: string;
  /** false: not copied when a new report is created from an existing one (e.g. retest results) */
  copy?: boolean;
  /** enum only */
  options?: FieldOption[];
  /** list only: type of each item */
  items?: 'string' | 'markdown';
  /** table only: columns of each row */
  columns?: FieldDef[];
  /** code only: highlight.js language (empty = auto-detect) */
  language?: string;
  /** code only: print line numbers */
  lines?: boolean;
  /** markdown/text/code only: editor height in lines */
  rows?: number;
  /** range only */
  min?: number;
  max?: number;
  step?: number;
  /** enum only: 'cards' shows visual choices */
  display?: 'cards' | 'segmented' | 'select';
  /**
   * Report fields only, used by generic templates: where the field is printed.
   * `before` (default for markdown) = a chapter before the collections, `after` = after
   * them, `details` (default for other types) = the document information table, `none` = hidden.
   */
  section?: 'before' | 'after' | 'details' | 'none';
}

export type CollectionLayout = 'sections' | 'table' | 'timeline';

/** A repeatable kind of entry (findings, timeline events, IOCs, actions…), one file each. */
export interface CollectionDef {
  id: string;
  /** plural label, e.g. "Findings" */
  label: string;
  /** singular label, e.g. "Finding" */
  itemLabel: string;
  /** variable name of one item inside placeholders and templates, e.g. "finding" */
  itemVar: string;
  /** numbering prefix, e.g. "F-" (empty = no numbering) */
  prefix: string;
  /** "severity", "manual" (order field), a field id, or "-<field>" for descending */
  sort: string;
  /** field used as the title of each item */
  titleField: string;
  /** how generic templates print the collection */
  layout: CollectionLayout;
  /** columns for layout "table" (field ids) */
  columns?: string[];
  /** generic templates start every item on a new page */
  pageBreak: boolean;
  /** enum/boolean field summarised with a donut chart above the entries */
  chart?: string;
  /** codicon shown in the tree */
  icon: string;
  description?: string;
  fields: FieldDef[];
  /** true when items have a severity (severity enum or cvss field) */
  hasSeverity: boolean;
}

export interface SeverityDef {
  id: string;
  label: string;
  color: string;
  /** minimum CVSS score that maps to this severity */
  min: number;
}

export interface Design {
  id: string;
  name: string;
  description?: string;
  /** directory of this design */
  dir: string;
  /** chain of ancestor directories, closest first (excluding `dir`) */
  parents: { id: string; dir: string }[];
  reportFields: FieldDef[];
  collections: CollectionDef[];
  /** fields of the "findings" collection (empty when the design has none) */
  findingFields: FieldDef[];
  severities: SeverityDef[];
  /** absolute path of the template file that will be rendered */
  templatePath: string;
  /** absolute paths of stylesheets, parents first */
  stylesheets: string[];
  /** numbering prefix of the "findings" collection */
  findingPrefix: string;
  /** theme defaults of the design chain (see core/theme.ts) */
  theme: Record<string, unknown>;
  /** ordered blocks from `layout:` (nearest design in the chain that sets one), see core/layout.ts */
  layout?: import('./layout').LayoutBlock[];
}

/** One entry of a collection (a Markdown file with front matter). */
export interface Finding {
  id: string;
  /** absolute path of the .md file */
  file: string;
  /** collection id (= folder name) */
  collection: string;
  values: Record<string, unknown>;
}
export type Item = Finding;

export interface Project {
  /** directory containing report.yaml */
  dir: string;
  reportFile: string;
  designId: string;
  report: Record<string, unknown>;
  /** items by collection id (folder name) */
  items: Record<string, Item[]>;
  /** shortcut for items.findings */
  findings: Item[];
}

export interface Issue {
  file: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  line?: number;
  column?: number;
  field?: string;
}

/** Reads a file; lets the extension serve unsaved editor buffers. */
export type ReadFile = (path: string) => string;

/** One entry of a `screenshots` field. */
export interface Screenshot {
  image: string;
  caption?: string;
  /** printed width, e.g. "60%" or "120mm" (default: full width) */
  width?: string;
}
