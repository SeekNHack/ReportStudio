import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { FieldDef, FieldOption } from '../../src/core/types';
import { vscode } from '../shared/vscode';
import '../form/form.css';
import './design.css';

type Origin = 'own' | 'inherited' | 'override';
interface FieldRow extends FieldDef {
  origin: Origin;
}
interface CollectionRow {
  id: string;
  label: string;
  itemLabel: string;
  itemVar: string;
  prefix: string;
  sort: string;
  titleField: string;
  layout: 'sections' | 'table' | 'timeline';
  columns?: string[];
  pageBreak: boolean;
  chart?: string;
  icon: string;
  description?: string;
  hasSeverity: boolean;
  origin: Origin;
  fields: FieldRow[];
  removedFields: FieldDef[];
}
interface State {
  file: string;
  id: string;
  readOnly: boolean;
  error?: string;
  name: string;
  description: string;
  extends: string;
  designs: string[];
  types: string[];
  report: FieldRow[];
  removedReport: FieldDef[];
  collections: CollectionRow[];
  removedCollections: { id: string; label: string }[];
  templateFile?: string;
}

const TYPE_INFO: Record<string, { icon: string; text: string }> = {
  string: { icon: 'symbol-string', text: 'Single line of text' },
  text: { icon: 'note', text: 'Plain multi-line text' },
  markdown: { icon: 'markdown', text: 'Rich text: headings, code, images, diagrams, placeholders' },
  number: { icon: 'symbol-numeric', text: 'Number' },
  boolean: { icon: 'symbol-boolean', text: 'Yes / no switch' },
  enum: { icon: 'symbol-enum', text: 'One choice from a list, with optional colors' },
  date: { icon: 'calendar', text: 'Date' },
  datetime: { icon: 'clock', text: 'Date and time' },
  list: { icon: 'list-unordered', text: 'List of short entries' },
  table: { icon: 'table', text: 'Rows with typed columns (hosts, IOCs, …)' },
  cvss: { icon: 'shield', text: 'CVSS 3.1/4.0 vector with calculator' },
  code: { icon: 'terminal', text: 'Code listing: language, file name, caption, line numbers' },
  image: { icon: 'file-media', text: 'Single image (logo, diagram)' },
  screenshots: { icon: 'device-camera', text: 'Screenshots with captions, numbered as figures' },
  user: { icon: 'person', text: 'Person or team' },
};
const CODE_LANGUAGES = ['bash', 'powershell', 'http', 'json', 'yaml', 'xml', 'html', 'javascript', 'typescript', 'python', 'java', 'csharp', 'php', 'go', 'rust', 'c', 'cpp', 'sql', 'plaintext'];
const COLUMN_TYPES = ['string', 'number', 'enum', 'boolean', 'date', 'datetime', 'markdown'];
const LAYOUTS = [
  { value: 'sections', label: 'Sections', icon: 'list-flat', text: 'One block per entry' },
  { value: 'table', label: 'Table', icon: 'table', text: 'All entries in one table' },
  { value: 'timeline', label: 'Timeline', icon: 'history', text: 'Chronological timeline' },
];

const op = (o: Record<string, unknown>) => vscode.postMessage({ type: 'op', op: o });
const cmd = (command: string, ...args: unknown[]) => vscode.postMessage({ type: 'command', command, args });
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Text input that keeps what the user types while focused and commits after a pause or on blur. */
function TextInput(props: { value: string; onCommit: (v: string) => void; placeholder?: string; class?: string; mono?: boolean; commitOnBlurOnly?: boolean; disabled?: boolean; multiline?: boolean }) {
  const [local, setLocal] = useState(props.value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!focused.current) setLocal(props.value);
  }, [props.value]);
  const commit = (v: string) => {
    clearTimeout(timer.current);
    if (v !== props.value) props.onCommit(v);
  };
  const common = {
    class: `input ${props.mono ? 'mono' : ''} ${props.class ?? ''}`,
    value: local,
    placeholder: props.placeholder,
    disabled: props.disabled,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      commit(local);
    },
    onInput: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      setLocal(v);
      if (!props.commitOnBlurOnly) {
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => commit(v), 450);
      }
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !props.multiline) (e.target as HTMLInputElement).blur();
    },
  };
  return props.multiline ? <textarea rows={3} {...common} /> : <input {...common} />;
}

function Toggle(props: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button class={`toggle ${props.on ? 'on' : ''}`} disabled={props.disabled} onClick={() => props.onChange(!props.on)}>
      <span class="toggle-knob" />
      <span class="toggle-text">{props.label ?? (props.on ? 'Yes' : 'No')}</span>
    </button>
  );
}

function Prop(props: { label: string; help?: string; children: preact.ComponentChildren; wide?: boolean }) {
  return (
    <div class={`prop ${props.wide ? 'wide' : ''}`}>
      <label>{props.label}</label>
      {props.children}
      {props.help && <div class="field-help">{props.help}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ options */

function OptionsEditor(props: { options: FieldOption[]; onChange: (o: FieldOption[]) => void; disabled?: boolean }) {
  const opts = props.options;
  const set = (i: number, patch: Partial<FieldOption>) => props.onChange(opts.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  return (
    <div class="options">
      {opts.map((o, i) => (
        <div class="option-row">
          <label class="swatch small" style={{ background: o.color ?? 'transparent' }} title="Color (optional)">
            <input type="color" value={o.color ?? '#888888'} disabled={props.disabled} onChange={(e) => set(i, { color: (e.target as HTMLInputElement).value })} />
          </label>
          <TextInput value={o.label} placeholder="Label" disabled={props.disabled} onCommit={(v) => set(i, { label: v, value: o.value || slug(v) })} />
          <TextInput value={o.value} placeholder="value" mono disabled={props.disabled} onCommit={(v) => set(i, { value: slug(v) || v })} />
          {o.color && (
            <button class="icon-btn" title="Remove color" disabled={props.disabled} onClick={() => set(i, { color: undefined })}>
              <i class="codicon codicon-circle-slash" />
            </button>
          )}
          <button class="icon-btn" title="Move up" disabled={props.disabled || i === 0} onClick={() => props.onChange(swap(opts, i, i - 1))}>
            <i class="codicon codicon-arrow-up" />
          </button>
          <button class="icon-btn" title="Remove" disabled={props.disabled} onClick={() => props.onChange(opts.filter((_, j) => j !== i))}>
            <i class="codicon codicon-trash" />
          </button>
        </div>
      ))}
      <button class="btn ghost" disabled={props.disabled} onClick={() => props.onChange([...opts, { value: `option_${opts.length + 1}`, label: `Option ${opts.length + 1}` }])}>
        <i class="codicon codicon-add" /> Add option
      </button>
    </div>
  );
}

function swap<T>(list: T[], i: number, j: number): T[] {
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/* ------------------------------------------------------------ columns */

function ColumnsEditor(props: { columns: FieldDef[]; onChange: (c: Record<string, Record<string, unknown>>) => void; disabled?: boolean }) {
  const cols = props.columns;
  const emit = (list: FieldDef[]) => props.onChange(Object.fromEntries(list.map((c) => [c.id, { type: c.type, label: c.label, required: c.required || undefined, options: c.type === 'enum' ? (c.options ?? []) : undefined, placeholder: c.placeholder }])));
  const set = (i: number, patch: Partial<FieldDef>) => emit(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const [openEnum, setOpenEnum] = useState<number | null>(null);
  return (
    <div class="columns-editor">
      {cols.map((c, i) => (
        <div class="column-block">
          <div class="option-row">
            <i class={`codicon codicon-${TYPE_INFO[c.type]?.icon ?? 'symbol-field'}`} />
            <TextInput value={c.label} placeholder="Label" disabled={props.disabled} onCommit={(v) => set(i, { label: v })} />
            <TextInput value={c.id} mono placeholder="id" commitOnBlurOnly disabled={props.disabled} onCommit={(v) => set(i, { id: slug(v) || c.id })} />
            <select class="input" value={c.type} disabled={props.disabled} onChange={(e) => set(i, { type: (e.target as HTMLSelectElement).value as FieldDef['type'], options: (e.target as HTMLSelectElement).value === 'enum' ? (c.options?.length ? c.options : [{ value: 'a', label: 'A' }]) : c.options })}>
              {COLUMN_TYPES.map((t) => (
                <option value={t}>{t}</option>
              ))}
            </select>
            <label class="check">
              <input type="checkbox" checked={!!c.required} disabled={props.disabled} onChange={(e) => set(i, { required: (e.target as HTMLInputElement).checked })} /> required
            </label>
            {c.type === 'enum' && (
              <button class={`icon-btn ${openEnum === i ? 'active' : ''}`} title="Options" onClick={() => setOpenEnum(openEnum === i ? null : i)}>
                <i class="codicon codicon-symbol-enum" />
              </button>
            )}
            <button class="icon-btn" title="Move up" disabled={props.disabled || i === 0} onClick={() => emit(swap(cols, i, i - 1))}>
              <i class="codicon codicon-arrow-up" />
            </button>
            <button class="icon-btn" title="Remove column" disabled={props.disabled || cols.length === 1} onClick={() => emit(cols.filter((_, j) => j !== i))}>
              <i class="codicon codicon-trash" />
            </button>
          </div>
          {c.type === 'enum' && openEnum === i && (
            <div class="nested">
              <OptionsEditor options={c.options ?? []} disabled={props.disabled} onChange={(o) => set(i, { options: o })} />
            </div>
          )}
        </div>
      ))}
      <button class="btn ghost" disabled={props.disabled} onClick={() => emit([...cols, { id: `column_${cols.length + 1}`, label: `Column ${cols.length + 1}`, type: 'string' }])}>
        <i class="codicon codicon-add" /> Add column
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- fields */

function FieldCard(props: { scope: string; field: FieldRow; index: number; count: number; open: boolean; onToggle: () => void; groups: string[]; readOnly: boolean; isTitle?: boolean }) {
  const { field: f, scope } = props;
  const ro = props.readOnly;
  const set = (prop: string, value: unknown) => op({ op: 'setField', scope, id: f.id, prop, value });
  const info = TYPE_INFO[f.type] ?? { icon: 'symbol-field', text: f.type };
  return (
    <div class={`field-card ${props.open ? 'open' : ''} origin-${f.origin}`}>
      <div class="field-card-head" onClick={props.onToggle}>
        <i class={`codicon codicon-chevron-${props.open ? 'down' : 'right'}`} />
        <i class={`codicon codicon-${info.icon} type-icon`} title={f.type} />
        <span class="fc-label">{f.label}</span>
        {f.required && <span class="req">*</span>}
        <span class="fc-id mono">{f.id}</span>
        <span class="fc-type">{f.type}</span>
        {f.group && <span class="tag">{f.group}</span>}
        {props.isTitle && <span class="tag accent">title</span>}
        {f.origin !== 'own' && <span class={`tag ${f.origin}`}>{f.origin === 'inherited' ? 'inherited' : 'modified'}</span>}
        <span class="spacer" />
        <span class="fc-actions" onClick={(e) => e.stopPropagation()}>
          {f.origin === 'own' && (
            <>
              <button class="icon-btn" title="Move up" disabled={ro || props.index === 0} onClick={() => op({ op: 'moveField', scope, id: f.id, delta: -1 })}>
                <i class="codicon codicon-arrow-up" />
              </button>
              <button class="icon-btn" title="Move down" disabled={ro || props.index === props.count - 1} onClick={() => op({ op: 'moveField', scope, id: f.id, delta: 1 })}>
                <i class="codicon codicon-arrow-down" />
              </button>
            </>
          )}
          {f.origin === 'override' && (
            <button class="icon-btn" title="Reset to inherited definition" disabled={ro} onClick={() => op({ op: 'restoreField', scope, id: f.id })}>
              <i class="codicon codicon-discard" />
            </button>
          )}
          <button class="icon-btn" title={f.origin === 'own' ? 'Delete field' : 'Hide inherited field'} disabled={ro || props.isTitle} onClick={() => op({ op: 'removeField', scope, id: f.id, inherited: f.origin !== 'own' })}>
            <i class="codicon codicon-trash" />
          </button>
        </span>
      </div>
      {props.open && (
        <div class="field-card-body">
          <Prop label="Label">
            <TextInput value={f.label} disabled={ro} onCommit={(v) => set('label', v)} />
          </Prop>
          <Prop label="ID" help={f.origin === 'own' ? 'Key in the files and in placeholders. Renaming does not update existing files.' : 'Inherited fields keep their id.'}>
            <TextInput value={f.id} mono commitOnBlurOnly disabled={ro || f.origin !== 'own'} onCommit={(v) => slug(v) && op({ op: 'renameField', scope, id: f.id, to: slug(v) })} />
          </Prop>
          <Prop label="Type" help={info.text}>
            <select class="input" value={f.type} disabled={ro} onChange={(e) => set('type', (e.target as HTMLSelectElement).value)}>
              {Object.keys(TYPE_INFO).map((t) => (
                <option value={t}>{t}</option>
              ))}
            </select>
          </Prop>
          <Prop label="Required">
            <Toggle on={!!f.required} disabled={ro} onChange={(v) => set('required', v || undefined)} />
          </Prop>
          <Prop label="Carry over" help="Copied when a new report is created from this one (Change Report Type → new report). Turn off for per-round values such as retest results.">
            <Toggle on={f.copy !== false} disabled={ro} onChange={(v) => set('copy', v ? undefined : false)} />
          </Prop>
          <Prop label="Group" help="Section of the form">
            <input class="input" list={`groups-${scope}`} value={f.group ?? ''} disabled={ro} onChange={(e) => set('group', (e.target as HTMLInputElement).value || undefined)} />
            <datalist id={`groups-${scope}`}>
              {props.groups.map((g) => (
                <option value={g} />
              ))}
            </datalist>
          </Prop>
          <Prop label="Placeholder">
            <TextInput value={f.placeholder ?? ''} disabled={ro} onCommit={(v) => set('placeholder', v || undefined)} />
          </Prop>
          <Prop label="Help text" wide>
            <TextInput value={f.help ?? ''} disabled={ro} onCommit={(v) => set('help', v || undefined)} />
          </Prop>
          {scope === '_report' && (
            <Prop label="Position in generic templates" wide>
              <div class="segmented">
                {[
                  ['', 'Auto'],
                  ['before', 'Chapter before'],
                  ['after', 'Chapter after'],
                  ['details', 'Info table'],
                  ['none', 'Hidden'],
                ].map(([v, l]) => (
                  <button class={(f.section ?? '') === v ? 'on' : ''} disabled={ro} onClick={() => set('section', v || undefined)}>
                    {l}
                  </button>
                ))}
              </div>
            </Prop>
          )}
          {f.type === 'code' && (
            <>
              <Prop label="Default language">
                <select class="input" value={f.language ?? ''} disabled={ro} onChange={(e) => set('language', (e.target as HTMLSelectElement).value || undefined)}>
                  <option value="">auto-detect</option>
                  {CODE_LANGUAGES.map((l) => (
                    <option value={l}>{l}</option>
                  ))}
                </select>
              </Prop>
              <Prop label="Line numbers by default">
                <Toggle on={f.lines === true} disabled={ro} onChange={(b) => set('lines', b || undefined)} />
              </Prop>
            </>
          )}
          {(f.type === 'markdown' || f.type === 'text' || f.type === 'code') && (
            <Prop label="Editor height (lines)">
              <input class="input tiny" type="number" min={2} max={40} value={f.rows ?? ''} disabled={ro} onChange={(e) => set('rows', Number((e.target as HTMLInputElement).value) || undefined)} />
            </Prop>
          )}
          {f.type === 'list' && (
            <Prop label="Entries">
              <div class="segmented">
                {['string', 'markdown'].map((t) => (
                  <button class={(f.items ?? 'string') === t ? 'on' : ''} disabled={ro} onClick={() => set('items', t === 'string' ? undefined : t)}>
                    {t === 'string' ? 'Plain text' : 'Inline markdown'}
                  </button>
                ))}
              </div>
            </Prop>
          )}
          <Prop label="Default value" wide={f.type === 'markdown' || f.type === 'text'}>
            <DefaultInput field={f} disabled={ro} onChange={(v) => set('default', v)} />
          </Prop>
          {f.type === 'enum' && (
            <Prop label="Options" wide>
              <OptionsEditor options={f.options ?? []} disabled={ro} onChange={(o) => set('options', o)} />
            </Prop>
          )}
          {f.type === 'table' && (
            <Prop label="Columns" wide>
              <ColumnsEditor columns={f.columns ?? []} disabled={ro} onChange={(c) => set('columns', c)} />
            </Prop>
          )}
          <Prop label="Use in templates and placeholders" wide>
            <code class="snippet">{scope === '_report' ? `{{ report.${f.id} }}` : `{{ item.${f.id} }}`}</code>
            <code class="snippet">{scope === '_report' ? `{{ render_field(report, '${f.id}') }}` : `{{ render_field(item, '${f.id}') }}`}</code>
          </Prop>
        </div>
      )}
    </div>
  );
}

function DefaultInput(props: { field: FieldDef; onChange: (v: unknown) => void; disabled?: boolean }) {
  const f = props.field;
  const v = f.default;
  if (f.type === 'boolean') return <Toggle on={v === true} disabled={props.disabled} onChange={(b) => props.onChange(b || undefined)} />;
  if (f.type === 'enum')
    return (
      <select class="input" value={v === undefined ? '' : String(v)} disabled={props.disabled} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value || undefined)}>
        <option value="">— none —</option>
        {f.options?.map((o) => (
          <option value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  if (f.type === 'number') return <input class="input tiny" type="number" value={v === undefined ? '' : String(v)} disabled={props.disabled} onChange={(e) => props.onChange((e.target as HTMLInputElement).value === '' ? undefined : Number((e.target as HTMLInputElement).value))} />;
  if (['table', 'list', 'image', 'cvss', 'screenshots', 'code'].includes(f.type)) return <span class="muted">Set it in design.yaml if needed.</span>;
  return <TextInput value={v === undefined ? '' : String(v)} multiline={f.type === 'markdown' || f.type === 'text'} disabled={props.disabled} onCommit={(s) => props.onChange(s || undefined)} />;
}

function AddField(props: { scope: string; existing: string[]; onAdded: (id: string) => void; disabled?: boolean; types: string[] }) {
  const [open, setOpen] = useState(false);
  const add = (type: string) => {
    let n = 1;
    let id = `${type}_field`;
    while (props.existing.includes(id)) id = `${type}_field_${++n}`;
    op({ op: 'addField', scope: props.scope, id, type, label: `New ${type} field` });
    setOpen(false);
    props.onAdded(id);
  };
  return (
    <div class="add-field">
      <button class="btn" disabled={props.disabled} onClick={() => setOpen(!open)}>
        <i class="codicon codicon-add" /> Add field
      </button>
      {open && (
        <div class="type-palette">
          {props.types.map((t) => (
            <button class="type-card" onClick={() => add(t)}>
              <i class={`codicon codicon-${TYPE_INFO[t]?.icon ?? 'symbol-field'}`} />
              <b>{t}</b>
              <span>{TYPE_INFO[t]?.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldList(props: { scope: string; fields: FieldRow[]; removed: FieldDef[]; readOnly: boolean; types: string[]; titleField?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = [...new Set(props.fields.map((f) => f.group).filter(Boolean))] as string[];
  const ownIds = props.fields.filter((f) => f.origin === 'own').map((f) => f.id);
  return (
    <div class="field-list">
      {props.fields.map((f) => (
        <FieldCard
          scope={props.scope}
          field={f}
          index={ownIds.indexOf(f.id)}
          count={ownIds.length}
          open={open === f.id}
          onToggle={() => setOpen(open === f.id ? null : f.id)}
          groups={groups}
          readOnly={props.readOnly}
          isTitle={props.titleField === f.id}
        />
      ))}
      {props.removed.map((f) => (
        <div class="field-card removed">
          <div class="field-card-head">
            <i class="codicon codicon-eye-closed" />
            <span class="fc-label">{f.label}</span>
            <span class="fc-id mono">{f.id}</span>
            <span class="tag">hidden</span>
            <span class="spacer" />
            <button class="btn ghost" disabled={props.readOnly} onClick={() => op({ op: 'restoreField', scope: props.scope, id: f.id })}>
              <i class="codicon codicon-eye" /> Restore
            </button>
          </div>
        </div>
      ))}
      <AddField scope={props.scope} existing={props.fields.map((f) => f.id)} onAdded={(id) => setOpen(id)} disabled={props.readOnly} types={props.types} />
    </div>
  );
}

/* --------------------------------------------------------- collections */

function CollectionPanel(props: { c: CollectionRow; readOnly: boolean; types: string[]; onRenamed: (id: string) => void }) {
  const { c, readOnly: ro } = props;
  const set = (prop: string, value: unknown) => op({ op: 'setCollection', id: c.id, prop, value });
  const scalarFields = c.fields.filter((f) => !['markdown', 'table', 'image'].includes(f.type));
  const sortOptions = [
    ...(c.hasSeverity ? [{ value: 'severity', label: 'Severity (then CVSS)' }] : []),
    { value: 'manual', label: 'Manual (order field, then title)' },
    ...scalarFields.flatMap((f) => [
      { value: f.id, label: `${f.label} ↑` },
      { value: `-${f.id}`, label: `${f.label} ↓` },
    ]),
  ];
  return (
    <>
      <section class="group">
        <h2 class="group-title">
          <i class={`codicon codicon-${c.icon}`} /> {c.label} — settings
          {c.origin !== 'own' && <span class={`tag ${c.origin}`}>{c.origin === 'inherited' ? 'inherited' : 'modified'}</span>}
        </h2>
        <div class="props">
          <Prop label="Name (plural)">
            <TextInput value={c.label} disabled={ro} onCommit={(v) => set('label', v)} />
          </Prop>
          <Prop label="One entry is called">
            <TextInput value={c.itemLabel} disabled={ro} onCommit={(v) => set('item_label', v)} />
          </Prop>
          <Prop label="Folder / ID" help={`Entries are files in ${c.id}/. Renaming does not move existing files.`}>
            <TextInput value={c.id} mono commitOnBlurOnly disabled={ro || c.origin !== 'own'} onCommit={(v) => slug(v) && (op({ op: 'renameCollection', id: c.id, to: slug(v) }), props.onRenamed(slug(v)))} />
          </Prop>
          <Prop label="Numbering prefix" help="e.g. F- gives F-01, F-02… Empty: no numbers">
            <TextInput value={c.prefix} mono disabled={ro} onCommit={(v) => set('prefix', v)} />
          </Prop>
          <Prop label="Variable in placeholders" help={`{{ ${c.itemVar}.title }} inside text fields`}>
            <TextInput value={c.itemVar} mono disabled={ro} onCommit={(v) => set('item_var', slug(v) || undefined)} />
          </Prop>
          <Prop label="Icon" help="Any codicon name (bug, history, search, tasklist, server…)">
            <div class="row">
              <i class={`codicon codicon-${c.icon} icon-preview`} />
              <TextInput value={c.icon} mono disabled={ro} onCommit={(v) => set('icon', v || undefined)} />
            </div>
          </Prop>
          <Prop label="Sort by">
            <select class="input" value={c.sort} disabled={ro} onChange={(e) => set('sort', (e.target as HTMLSelectElement).value)}>
              {sortOptions.map((o) => (
                <option value={o.value}>{o.label}</option>
              ))}
            </select>
          </Prop>
          <Prop label="Title field">
            <select class="input" value={c.titleField} disabled={ro} onChange={(e) => set('title_field', (e.target as HTMLSelectElement).value)}>
              {c.fields
                .filter((f) => f.type === 'string')
                .map((f) => (
                  <option value={f.id}>{f.label}</option>
                ))}
            </select>
          </Prop>
          <Prop label="Layout in generic templates" wide>
            <div class="cards">
              {LAYOUTS.map((l) => (
                <button class={`card layout-card ${c.layout === l.value ? 'on' : ''}`} disabled={ro} onClick={() => set('layout', l.value)}>
                  <i class={`codicon codicon-${l.icon}`} />
                  <b>{l.label}</b>
                  <span>{l.text}</span>
                </button>
              ))}
            </div>
          </Prop>
          {c.layout === 'table' && (
            <Prop label="Table columns" wide help="Leave all unchecked for automatic columns">
              <div class="checks">
                {['number', ...scalarFields.map((f) => f.id)].map((id) => (
                  <label class="check">
                    <input
                      type="checkbox"
                      disabled={ro}
                      checked={c.columns?.includes(id) ?? false}
                      onChange={(e) => {
                        const on = (e.target as HTMLInputElement).checked;
                        const next = on ? [...(c.columns ?? []), id] : (c.columns ?? []).filter((x) => x !== id);
                        set('columns', next.length ? next : undefined);
                      }}
                    />
                    {id === 'number' ? '#' : (c.fields.find((f) => f.id === id)?.label ?? id)}
                  </label>
                ))}
              </div>
            </Prop>
          )}
          {c.layout === 'sections' && (
            <Prop label="New page for every entry">
              <Toggle on={c.pageBreak} disabled={ro} onChange={(v) => set('page_break', v)} />
            </Prop>
          )}
          <Prop label="Summary chart" help="Donut chart above the entries, counting them by a field">
            <select class="input" value={c.chart ?? ''} disabled={ro} onChange={(e) => set('chart', (e.target as HTMLSelectElement).value || undefined)}>
              <option value="">— none —</option>
              {c.fields
                .filter((f) => f.type === 'enum' || f.type === 'boolean')
                .map((f) => (
                  <option value={f.id}>{f.label}</option>
                ))}
            </select>
          </Prop>
          <Prop label="Description" wide help="Printed under the chapter title">
            <TextInput value={c.description ?? ''} disabled={ro} onCommit={(v) => set('description', v || undefined)} />
          </Prop>
        </div>
        <div class="danger-row">
          <button class="btn ghost danger" disabled={ro} onClick={() => op({ op: 'removeCollection', id: c.id, inherited: c.origin !== 'own' })}>
            <i class="codicon codicon-trash" /> {c.origin === 'own' ? 'Delete collection' : 'Hide inherited collection'}
          </button>
        </div>
      </section>
      <section class="group">
        <h2 class="group-title">
          <i class="codicon codicon-symbol-field" /> Fields of each {c.itemLabel.toLowerCase()}
        </h2>
        <div class="group-pad">
          <FieldList scope={c.id} fields={c.fields} removed={c.removedFields} readOnly={ro} types={props.types} titleField={c.titleField} />
        </div>
      </section>
    </>
  );
}

function AddCollection(props: { existing: string[]; onAdded: (id: string) => void; disabled?: boolean }) {
  const [label, setLabel] = useState('');
  const id = slug(label);
  const ok = !!id && !props.existing.includes(id) && !['assets', 'designs', 'out', 'library'].includes(id);
  return (
    <section class="group">
      <h2 class="group-title">
        <i class="codicon codicon-add" /> New collection
      </h2>
      <div class="group-pad">
        <p class="muted">A collection is a repeatable kind of entry — findings, timeline events, IOCs, interviews, assets… Each entry is a Markdown file in a folder of the report.</p>
        <div class="row">
          <input class="input" placeholder="e.g. Interviews" value={label} disabled={props.disabled} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
          <button
            class="btn primary"
            disabled={!ok || props.disabled}
            onClick={() => {
              op({ op: 'addCollection', id, label });
              props.onAdded(id);
              setLabel('');
            }}
          >
            Create
          </button>
        </div>
        {label && <div class="field-help">Folder: {id}/</div>}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- app */

function App() {
  const [s, setS] = useState<State | null>(null);
  const [view, setView] = useState<string>(() => vscode.getState<{ view?: string }>()?.view ?? 'general');
  useEffect(() => {
    const on = (e: MessageEvent) => e.data?.type === 'state' && setS(e.data);
    window.addEventListener('message', on);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', on);
  }, []);
  useEffect(() => vscode.setState({ view }), [view]);
  if (!s) return <div class="loading">Loading…</div>;
  const ro = s.readOnly;
  const current = s.collections.find((c) => `c:${c.id}` === view);
  const active = view === 'general' || view === 'report' || view === 'new' || current ? view : 'general';

  return (
    <div class="design-app">
      <header class="header">
        <div class="header-main">
          <div class="chips">
            <span class="chip number">Design</span>
            <span class="chip ghost">{s.file}</span>
          </div>
          <div class="title-static">{s.name || s.id}</div>
        </div>
        <div class="header-actions">
          <button class="btn" onClick={() => cmd('openTemplate')} title={s.templateFile}>
            <i class="codicon codicon-file-code" /> Template
          </button>
          <button class="btn" onClick={() => cmd('reportStudio.openPreview')}>
            <i class="codicon codicon-open-preview" /> Preview
          </button>
          <button class="icon-btn" onClick={() => cmd('openAsText')} title="Open as YAML">
            <i class="codicon codicon-go-to-file" />
          </button>
        </div>
      </header>
      {ro && (
        <div class="banner warning">
          <i class="codicon codicon-lock" /> Built-in design: read only. <a onClick={() => cmd('reportStudio.copyDesign', s.id)}>Copy it to the workspace</a> or <a onClick={() => cmd('reportStudio.newDesign', s.id)}>create a design that extends it</a>.
        </div>
      )}
      {s.error && (
        <div class="banner error">
          <i class="codicon codicon-error" /> {s.error}
        </div>
      )}
      <div class="design-layout">
        <nav class="side-nav">
          <a class={active === 'general' ? 'on' : ''} onClick={() => setView('general')}>
            <i class="codicon codicon-settings" /> General
          </a>
          <a class={active === 'report' ? 'on' : ''} onClick={() => setView('report')}>
            <i class="codicon codicon-book" /> Report fields <span class="count">{s.report.length}</span>
          </a>
          <div class="nav-title">Collections</div>
          {s.collections.map((c) => (
            <a class={active === `c:${c.id}` ? 'on' : ''} onClick={() => setView(`c:${c.id}`)}>
              <i class={`codicon codicon-${c.icon}`} /> {c.label} <span class="count">{c.fields.length}</span>
            </a>
          ))}
          {s.removedCollections.map((c) => (
            <a class="removed" title="Hidden inherited collection" onClick={() => op({ op: 'restoreCollection', id: c.id })}>
              <i class="codicon codicon-eye-closed" /> {c.label} <span class="count">restore</span>
            </a>
          ))}
          <a class={active === 'new' ? 'on' : ''} onClick={() => setView('new')}>
            <i class="codicon codicon-add" /> New collection
          </a>
        </nav>
        <main class="design-main">
          {active === 'general' && (
            <section class="group">
              <h2 class="group-title">
                <i class="codicon codicon-settings" /> General
              </h2>
              <div class="props">
                <Prop label="Name">
                  <TextInput value={s.name} disabled={ro} onCommit={(v) => op({ op: 'setDesign', prop: 'name', value: v })} />
                </Prop>
                <Prop label="Extends" help="Inherit fields, collections, template and styles from another design. 'base' gives a generic layout with no HTML to write.">
                  <select class="input" value={s.extends} disabled={ro} onChange={(e) => op({ op: 'setDesign', prop: 'extends', value: (e.target as HTMLSelectElement).value })}>
                    <option value="">— none (own template.html) —</option>
                    {s.designs.map((d) => (
                      <option value={d}>{d}</option>
                    ))}
                  </select>
                </Prop>
                <Prop label="Description" wide>
                  <TextInput value={s.description} disabled={ro} onCommit={(v) => op({ op: 'setDesign', prop: 'description', value: v })} />
                </Prop>
              </div>
              <div class="group-pad">
                <div class="overview">
                  <div class="ov-card" onClick={() => setView('report')}>
                    <i class="codicon codicon-book" />
                    <b>{s.report.length}</b>
                    <span>report fields</span>
                  </div>
                  {s.collections.map((c) => (
                    <div class="ov-card" onClick={() => setView(`c:${c.id}`)}>
                      <i class={`codicon codicon-${c.icon}`} />
                      <b>{c.fields.length}</b>
                      <span>{c.label.toLowerCase()} fields</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
          {active === 'report' && (
            <section class="group">
              <h2 class="group-title">
                <i class="codicon codicon-book" /> Report fields
              </h2>
              <div class="group-pad">
                <p class="muted">Asked once per report (in the Report form). Use them anywhere as <code>{'{{ report.<id> }}'}</code>.</p>
                <FieldList scope="_report" fields={s.report} removed={s.removedReport} readOnly={ro} types={s.types} />
              </div>
            </section>
          )}
          {current && <CollectionPanel c={current} readOnly={ro} types={s.types} onRenamed={(id) => setView(`c:${id}`)} />}
          {active === 'new' && <AddCollection existing={s.collections.map((c) => c.id)} disabled={ro} onAdded={(id) => setView(`c:${id}`)} />}
        </main>
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
