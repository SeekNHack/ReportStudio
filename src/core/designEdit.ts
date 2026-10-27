import { Document, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { humanize } from './design';
import type { FieldOption } from './types';

/**
 * Edits a design.yaml document in place (keeping comments and order).
 * Used by the graphical design editor.
 */
export type DesignOp =
  | { op: 'setDesign'; prop: 'name' | 'description' | 'extends'; value?: string }
  | { op: 'addField'; scope: string; id: string; type: string; label?: string }
  | { op: 'setField'; scope: string; id: string; prop: string; value?: unknown }
  | { op: 'removeField'; scope: string; id: string; inherited: boolean }
  | { op: 'restoreField'; scope: string; id: string }
  | { op: 'renameField'; scope: string; id: string; to: string }
  | { op: 'moveField'; scope: string; id: string; delta: number }
  | { op: 'addCollection'; id: string; label: string }
  | { op: 'setCollection'; id: string; prop: string; value?: unknown }
  | { op: 'removeCollection'; id: string; inherited: boolean }
  | { op: 'restoreCollection'; id: string }
  | { op: 'renameCollection'; id: string; to: string }
  | { op: 'setTheme'; key?: string; value?: unknown }
  | { op: 'setLayout'; blocks?: Record<string, unknown>[] };

const REPORT = '_report';

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Path of the fields map of a scope ("_report" or a collection id). */
export function fieldsPath(doc: Document, scope: string): (string | number)[] {
  if (scope === REPORT) return ['report_fields'];
  if (scope === 'findings' && doc.has('finding_fields') && !doc.hasIn(['collections', 'findings', 'fields'])) return ['finding_fields'];
  return ['collections', scope, 'fields'];
}

function ensureMap(doc: Document, path: (string | number)[]): YAMLMap {
  let node = doc.getIn(path, true);
  if (!isMap(node)) {
    node = new YAMLMap();
    doc.setIn(path, node);
  }
  return node as YAMLMap;
}

function fieldNode(doc: Document, scope: string, id: string): YAMLMap {
  const path = [...fieldsPath(doc, scope), id];
  const node = doc.getIn(path, true);
  if (isMap(node)) return node;
  // Shorthand `field: markdown` → { type: markdown }; null (removed) or missing → {}
  const map = new YAMLMap();
  map.flow = true;
  if (isScalar(node) && typeof node.value === 'string') map.set('type', node.value);
  ensureMap(doc, fieldsPath(doc, scope));
  doc.setIn(path, map);
  return map;
}

function optionsNode(doc: Document, options: FieldOption[]) {
  const simple = options.every((o) => !o.color && (!o.label || o.label === humanize(o.value)));
  if (simple) {
    const seq = doc.createNode(options.map((o) => o.value)) as YAMLSeq;
    seq.flow = true;
    return seq;
  }
  const seq = new YAMLSeq();
  for (const o of options) {
    const m = doc.createNode(Object.fromEntries(Object.entries({ value: o.value, label: o.label, color: o.color }).filter(([, v]) => !isEmpty(v)))) as YAMLMap;
    m.flow = true;
    seq.add(m);
  }
  return seq;
}

function columnsNode(doc: Document, columns: Record<string, Record<string, unknown>>) {
  const map = new YAMLMap();
  for (const [id, spec] of Object.entries(columns)) {
    const clean = Object.fromEntries(Object.entries(spec).filter(([k, v]) => !isEmpty(v) && k !== 'id' && !(k === 'label' && v === humanize(id))));
    if (Array.isArray(clean.options)) clean.options = optionsNode(doc, clean.options as FieldOption[]);
    const node = doc.createNode(clean) as YAMLMap;
    node.flow = !clean.options;
    map.set(id, node);
  }
  return map;
}

function setProp(doc: Document, map: YAMLMap, id: string, prop: string, value: unknown): void {
  if (isEmpty(value) && value !== false) {
    map.delete(prop);
    return;
  }
  if (prop === 'label' && value === humanize(id) && !map.has('label')) return;
  if (prop === 'options') {
    map.flow = false;
    map.set(prop, optionsNode(doc, value as FieldOption[]));
    return;
  }
  if (prop === 'columns') {
    map.flow = false;
    map.set(prop, columnsNode(doc, value as Record<string, Record<string, unknown>>));
    return;
  }
  if (typeof value === 'string' && value.includes('\n')) {
    map.flow = false;
    const s = new Scalar(value.replace(/\s+$/, '') + '\n');
    s.type = Scalar.BLOCK_LITERAL;
    map.set(prop, s);
    return;
  }
  map.set(prop, value);
}

function moveKey(map: YAMLMap, key: string, delta: number): void {
  const i = map.items.findIndex((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= map.items.length) return;
  const [item] = map.items.splice(i, 1);
  map.items.splice(j, 0, item);
}

function renameKey(map: YAMLMap, key: string, to: string): void {
  const pair = map.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
  if (!pair || map.has(to)) return;
  if (isScalar(pair.key)) pair.key.value = to;
  else pair.key = new Scalar(to);
}

export function applyDesignOp(text: string, op: DesignOp): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  if (!isMap(doc.contents)) doc.contents = new YAMLMap() as never;
  switch (op.op) {
    case 'setDesign':
      if (isEmpty(op.value)) doc.delete(op.prop);
      else doc.set(op.prop, op.value);
      break;
    case 'setLayout': {
      // Without blocks the template goes back to the order of its HTML (or of its parent's layout).
      if (!op.blocks) {
        doc.delete('layout');
        break;
      }
      const seq = new YAMLSeq();
      for (const b of op.blocks) {
        const clean = Object.fromEntries(Object.entries(b).filter(([, v]) => !isEmpty(v)));
        const node = doc.createNode(clean) as YAMLMap;
        // One line per block, except text blocks with several lines.
        node.flow = !String(clean.body ?? '').includes('\n');
        seq.add(node);
      }
      doc.set('layout', seq);
      break;
    }
    case 'setTheme': {
      // Without a key the whole theme map is reset to the inherited values.
      if (!op.key) {
        doc.delete('theme');
        break;
      }
      if (isEmpty(op.value)) doc.deleteIn(['theme', op.key]);
      else ensureMap(doc, ['theme']).set(op.key, op.value);
      const theme = doc.get('theme', true);
      if (isMap(theme) && !theme.items.length) doc.delete('theme');
      break;
    }
    case 'addField': {
      const fields = ensureMap(doc, fieldsPath(doc, op.scope));
      const node = doc.createNode({ type: op.type, ...(op.label && op.label !== humanize(op.id) ? { label: op.label } : {}), ...(op.type === 'enum' ? { options: [] } : {}) }) as YAMLMap;
      node.flow = op.type !== 'enum' && op.type !== 'table';
      if (op.type === 'enum') node.set('options', optionsNode(doc, [{ value: 'option_a', label: 'Option A' }, { value: 'option_b', label: 'Option B' }]));
      if (op.type === 'table') node.set('columns', columnsNode(doc, { name: { type: 'string' }, value: { type: 'string' } }));
      fields.set(op.id, node);
      break;
    }
    case 'setField': {
      const map = fieldNode(doc, op.scope, op.id);
      setProp(doc, map, op.id, op.prop, op.value);
      break;
    }
    case 'removeField': {
      const path = fieldsPath(doc, op.scope);
      if (op.inherited) doc.setIn([...path, op.id], null);
      else doc.deleteIn([...path, op.id]);
      break;
    }
    case 'restoreField':
      doc.deleteIn([...fieldsPath(doc, op.scope), op.id]);
      break;
    case 'renameField':
      renameKey(ensureMap(doc, fieldsPath(doc, op.scope)), op.id, op.to);
      break;
    case 'moveField':
      moveKey(ensureMap(doc, fieldsPath(doc, op.scope)), op.id, op.delta);
      break;
    case 'addCollection': {
      const cols = ensureMap(doc, ['collections']);
      const node = doc.createNode({ label: op.label, fields: {} }) as YAMLMap;
      const title = doc.createNode({ type: 'string', required: true }) as YAMLMap;
      title.flow = true;
      (node.get('fields', true) as unknown as YAMLMap).set('title', title);
      cols.set(op.id, node);
      break;
    }
    case 'setCollection': {
      const path = ['collections', op.id];
      if (!isMap(doc.getIn(path, true))) doc.setIn(path, new YAMLMap());
      const map = doc.getIn(path, true) as YAMLMap;
      if (isEmpty(op.value) && op.value !== false) map.delete(op.prop);
      else if (Array.isArray(op.value)) {
        const seq = doc.createNode(op.value) as YAMLSeq;
        seq.flow = true;
        map.set(op.prop, seq);
      } else map.set(op.prop, op.value);
      break;
    }
    case 'removeCollection':
      if (op.inherited) doc.setIn(['collections', op.id], null);
      else doc.deleteIn(['collections', op.id]);
      if (op.id === 'findings' && !op.inherited) {
        doc.delete('finding_fields');
        doc.delete('finding_prefix');
      }
      break;
    case 'restoreCollection':
      doc.deleteIn(['collections', op.id]);
      break;
    case 'renameCollection':
      renameKey(ensureMap(doc, ['collections']), op.id, op.to);
      break;
  }
  // Drop empty containers left behind.
  const cols = doc.get('collections', true);
  if (isMap(cols) && !cols.items.length) doc.delete('collections');
  const rf = doc.get('report_fields', true);
  if (isMap(rf) && !rf.items.length) doc.delete('report_fields');
  if (isSeq(doc.contents)) throw new Error('design.yaml must be a mapping');
  return doc.toString({ lineWidth: 0 });
}
