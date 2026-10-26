import { Document, isMap, parseDocument, Scalar } from 'yaml';

/**
 * A finding file is Markdown with YAML front matter for scalar fields and
 * `<!-- field:<id> -->` markers that start each Markdown field:
 *
 *   ---
 *   title: SQL Injection
 *   ---
 *   <!-- field:description -->
 *   ...
 *
 * Parsing keeps the YAML document so that edits preserve comments and order.
 */
export interface ParsedFinding {
  front: Document;
  sections: { id: string; content: string }[];
  /** text between the front matter and the first marker */
  preamble: string;
}

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;
const MARKER_RE = /^<!--\s*field:([\w.-]+)\s*-->[ \t]*$/gm;

export function parseFinding(text: string): ParsedFinding {
  let yamlText = '';
  let body = text;
  const m = FRONT_RE.exec(text);
  if (m) {
    yamlText = m[1];
    body = text.slice(m[0].length);
  }
  const front = parseDocument(yamlText);
  const sections: { id: string; content: string }[] = [];
  const markers = [...body.matchAll(MARKER_RE)];
  const preamble = markers.length ? body.slice(0, markers[0].index) : body;
  markers.forEach((mk, i) => {
    const start = mk.index! + mk[0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index! : body.length;
    sections.push({ id: mk[1], content: trimSection(body.slice(start, end)) });
  });
  return { front, sections, preamble };
}

function trimSection(s: string): string {
  return s.replace(/^\r?\n/, '').replace(/\s+$/, '');
}

export function findingValues(p: ParsedFinding): Record<string, unknown> {
  const data = (p.front.toJS() ?? {}) as Record<string, unknown>;
  const values: Record<string, unknown> = typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  for (const s of p.sections) values[s.id] = s.content;
  return values;
}

export function serializeFinding(p: ParsedFinding): string {
  let out = '';
  const yamlText = p.front.contents ? p.front.toString({ lineWidth: 0 }) : '';
  out += `---\n${yamlText.trim() ? yamlText.replace(/\s+$/, '') + '\n' : ''}---\n`;
  const pre = p.preamble.trim();
  if (pre) out += `${pre}\n\n`;
  for (const s of p.sections) {
    out += `<!-- field:${s.id} -->\n`;
    out += s.content ? `${s.content}\n\n` : '\n';
  }
  return out.replace(/\n+$/, '\n');
}

/**
 * Sets a value. Markdown fields (listed in `markdownFields`) go into body sections,
 * everything else into the front matter.
 */
export function setFindingValue(p: ParsedFinding, key: string, value: unknown, isMarkdown: boolean, order?: string[]): void {
  if (isMarkdown) {
    const content = value == null ? '' : String(value);
    const existing = p.sections.find((s) => s.id === key);
    if (existing) existing.content = content.replace(/\s+$/, '');
    else {
      p.sections.push({ id: key, content: content.replace(/\s+$/, '') });
      if (order) p.sections.sort((a, b) => rank(order, a.id) - rank(order, b.id));
    }
    return;
  }
  setYamlValue(p.front, key, value);
}

function rank(order: string[], id: string): number {
  const i = order.indexOf(id);
  return i < 0 ? order.length : i;
}

/** Updates a top-level key of a YAML document, keeping comments elsewhere. */
export function setYamlValue(doc: Document, key: string, value: unknown): void {
  if (!doc.contents || !isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
    doc.delete(key);
    return;
  }
  if (typeof value === 'string' && value.includes('\n')) {
    const node = new Scalar(value.replace(/\s+$/, '') + '\n');
    node.type = Scalar.BLOCK_LITERAL;
    doc.set(key, node);
    return;
  }
  const current = doc.get(key, true);
  if (current instanceof Scalar && typeof value !== 'object') {
    current.value = value;
    if (current.type === Scalar.BLOCK_LITERAL || current.type === Scalar.BLOCK_FOLDED) current.type = Scalar.PLAIN;
    return;
  }
  doc.set(key, doc.createNode(value));
}

export function newFindingText(values: Record<string, unknown>, markdownFields: string[], order: string[]): string {
  const p: ParsedFinding = { front: new Document({}), sections: [], preamble: '' };
  for (const key of order) {
    if (markdownFields.includes(key)) p.sections.push({ id: key, content: values[key] == null ? '' : String(values[key]) });
    else if (values[key] !== undefined) setYamlValue(p.front, key, values[key]);
  }
  for (const [key, v] of Object.entries(values)) {
    if (order.includes(key)) continue;
    setFindingValue(p, key, v, markdownFields.includes(key));
  }
  return serializeFinding(p);
}
