import { useEffect, useRef, useState } from 'preact/hooks';
import { vscode } from '../shared/vscode';
import { TextInput, Toggle } from './controls';

/** Mirrors src/core/layout.ts (LayoutBlock) and DesignEditorProvider.layoutState. */
export interface Block {
  type: string;
  title?: string;
  level?: number;
  field?: string;
  fields?: string[];
  exclude?: string[];
  collection?: string;
  by?: string;
  kind?: string;
  body?: string;
  file?: string;
  depth?: number;
  always?: boolean;
}
interface PlaceholderField {
  id: string;
  label: string;
  type: string;
  snippet: string;
}
export interface LayoutState {
  supported: boolean;
  own: boolean;
  inheritedFrom?: string;
  blocks: Block[];
  defaults: Block[];
  kinds: { type: string; label: string; icon: string; text: string; level: number }[];
  partials: string[];
  report: PlaceholderField[];
  collections: { id: string; label: string; itemVar: string; chartFields: { id: string; label: string }[]; fields: PlaceholderField[] }[];
  ownTemplate?: string;
}

const op = (o: Record<string, unknown>) => vscode.postMessage({ type: 'op', op: o });
const cmd = (command: string, ...args: unknown[]) => vscode.postMessage({ type: 'command', command, args });

const TYPE_ICONS: Record<string, string> = {
  string: 'symbol-string',
  text: 'note',
  markdown: 'markdown',
  number: 'symbol-numeric',
  boolean: 'symbol-boolean',
  enum: 'symbol-enum',
  date: 'calendar',
  datetime: 'clock',
  list: 'list-unordered',
  table: 'table',
  cvss: 'shield',
  code: 'terminal',
  image: 'file-media',
  screenshots: 'device-camera',
  user: 'person',
};
const BODY_TYPES = ['markdown', 'code', 'screenshots', 'table', 'image'];
const LEVELS = [
  { value: 1, label: 'Chapter (H1, new page)' },
  { value: 2, label: 'Section (H2)' },
  { value: 0, label: 'No heading' },
];
const STATS = ['stats.total', 'stats.open', 'stats.fixed', 'stats.counts.critical', 'stats.counts.high'];

export function LayoutPanel(props: { layout: LayoutState; readOnly: boolean; designId: string; designName: string; onEditFields: () => void }) {
  const L = props.layout;
  if (!L.supported) return <Placeholders layout={L} readOnly={props.readOnly} designId={props.designId} />;
  return <LayoutEditor {...props} />;
}

/* ----------------------------------------------------------- the editor */

function LayoutEditor(props: { layout: LayoutState; readOnly: boolean; designId: string; designName: string; onEditFields: () => void }) {
  const L = props.layout;
  const ro = props.readOnly;
  const [blocks, setBlocks] = useState<Block[]>(L.blocks);
  const [open, setOpen] = useState<number | undefined>();
  const [drag, setDrag] = useState<{ from: number; over?: number } | undefined>();
  const pending = useRef<number | undefined>(undefined);
  const lastSent = useRef<string>(JSON.stringify(L.blocks));

  // Take changes made elsewhere (YAML, undo) unless an edit of ours is still on its way.
  useEffect(() => {
    const incoming = JSON.stringify(L.blocks);
    if (pending.current === undefined && incoming !== lastSent.current) setBlocks(L.blocks);
    lastSent.current = incoming;
  }, [L.blocks]);

  const save = (next: Block[], immediate = true) => {
    if (ro) return;
    setBlocks(next);
    clearTimeout(pending.current);
    const send = () => {
      pending.current = undefined;
      lastSent.current = JSON.stringify(next);
      op({ op: 'setLayout', blocks: next });
    };
    if (immediate) send();
    else pending.current = window.setTimeout(send, 400);
  };
  const update = (i: number, patch: Partial<Block>, immediate = true) => save(blocks.map((b, j) => (j === i ? clean({ ...b, ...patch }) : b)), immediate);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length || from === to) return;
    const next = [...blocks];
    const [b] = next.splice(from, 1);
    next.splice(to, 0, b);
    save(next);
    if (open === from) setOpen(to);
  };
  const insert = (b: Block) => {
    const at = open !== undefined ? open + 1 : blocks.length;
    const next = [...blocks];
    next.splice(at, 0, b);
    save(next);
    setOpen(at);
    setTimeout(() => document.getElementById(`block-${at}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };
  const remove = (i: number) => {
    save(blocks.filter((_, j) => j !== i));
    setOpen(undefined);
  };

  const placedFields = new Set(blocks.filter((b) => b.type === 'field').map((b) => b.field));
  const tabled = new Set(blocks.filter((b) => b.type === 'fields_table').flatMap((b) => b.fields ?? []));
  const placedCollections = new Set(blocks.filter((b) => b.type === 'collection').map((b) => b.collection));
  const unplacedFields = L.report.filter((f) => !placedFields.has(f.id) && !tabled.has(f.id) && BODY_TYPES.includes(f.type));
  const unplacedCollections = L.collections.filter((c) => !placedCollections.has(c.id));
  const info = (t: string) => L.kinds.find((k) => k.type === t);
  const at = open !== undefined ? `after block ${open + 1}` : 'at the end';

  return (
    <div class={`layout-editor ${ro ? 'readonly' : ''}`}>
      <div class="theme-bar">
        <span>
          <i class="codicon codicon-info" />{' '}
          {L.own ? (
            <>
              Your layout, saved in <code>design.yaml → layout</code>. Drag the blocks to change the order of the report.
            </>
          ) : L.inheritedFrom ? (
            <>Layout inherited from "{L.inheritedFrom}". Any change creates this template's own layout.</>
          ) : (
            <>This is the order of the template's HTML. Drag, add or remove blocks: the first change saves it as this template's layout.</>
          )}
        </span>
        <span class="spacer" />
        <button class="btn" onClick={() => cmd('reportStudio.openPreview', { template: props.designId })}>
          <i class="codicon codicon-open-preview" /> Preview
        </button>
        <button class="btn ghost" disabled={!L.own || ro} onClick={() => op({ op: 'setLayout' })} title="Remove the layout and use the order of the HTML again">
          <i class="codicon codicon-discard" /> Reset
        </button>
      </div>

      <div class="layout-grid">
        <ol class="block-list">
          {blocks.map((b, i) => {
            const k = info(b.type);
            const isOpen = open === i;
            return (
              <li
                id={`block-${i}`}
                class={`block-card ${isOpen ? 'open' : ''} ${drag?.over === i && drag.from !== i ? (drag.from < i ? 'drop-after' : 'drop-before') : ''} ${drag?.from === i ? 'dragging' : ''} level-${b.level ?? 0}`}
                draggable={!ro}
                onDragStart={(e) => {
                  e.dataTransfer?.setData('text/plain', String(i));
                  setDrag({ from: i });
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (drag && drag.over !== i) setDrag({ ...drag, over: i });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag) move(drag.from, i);
                  setDrag(undefined);
                }}
                onDragEnd={() => setDrag(undefined)}
              >
                <div class="block-head" onClick={() => setOpen(isOpen ? undefined : i)}>
                  <i class="codicon codicon-gripper grip" />
                  <span class="block-pos">{i + 1}</span>
                  <i class={`codicon codicon-${blockIcon(b, L)}`} />
                  <span class="block-title">{blockTitle(b, L)}</span>
                  <span class="fc-type">{k?.label ?? b.type}</span>
                  {(b.level ?? 0) > 0 && <span class="tag">{b.level === 1 ? 'H1' : 'H2'}</span>}
                  <span class="spacer" />
                  <span class="fc-actions" onClick={(e) => e.stopPropagation()}>
                    <button class="icon-btn" title="Move up" disabled={ro || i === 0} onClick={() => move(i, i - 1)}>
                      <i class="codicon codicon-arrow-up" />
                    </button>
                    <button class="icon-btn" title="Move down" disabled={ro || i === blocks.length - 1} onClick={() => move(i, i + 1)}>
                      <i class="codicon codicon-arrow-down" />
                    </button>
                    <button class="icon-btn" title="Duplicate" disabled={ro} onClick={() => (save([...blocks.slice(0, i + 1), { ...b }, ...blocks.slice(i + 1)]), setOpen(i + 1))}>
                      <i class="codicon codicon-copy" />
                    </button>
                    <button class="icon-btn" title="Remove from the report" disabled={ro} onClick={() => remove(i)}>
                      <i class="codicon codicon-trash" />
                    </button>
                  </span>
                </div>
                {isOpen && <BlockSettings block={b} layout={L} readOnly={ro} onChange={(patch, immediate) => update(i, patch, immediate)} />}
              </li>
            );
          })}
          {!blocks.length && <li class="block-empty muted">The report is empty: add blocks from the right.</li>}
        </ol>

        <aside class="block-palette">
          <div class="palette-title">
            Add <span class="muted">{at}</span>
          </div>
          {unplacedFields.length > 0 && (
            <>
              <div class="nav-title">Report fields not in the report</div>
              {unplacedFields.map((f) => (
                <button class="palette-item highlight" disabled={ro} onClick={() => insert({ type: 'field', field: f.id, title: f.label, level: 1 })}>
                  <i class={`codicon codicon-${TYPE_ICONS[f.type] ?? 'symbol-field'}`} /> {f.label}
                  <span class="muted">{f.type}</span>
                </button>
              ))}
            </>
          )}
          {unplacedCollections.length > 0 && (
            <>
              <div class="nav-title">Collections not in the report</div>
              {unplacedCollections.map((c) => (
                <button class="palette-item highlight" disabled={ro} onClick={() => insert({ type: 'collection', collection: c.id, title: c.label, level: 1 })}>
                  <i class="codicon codicon-symbol-namespace" /> {c.label}
                </button>
              ))}
            </>
          )}
          <div class="nav-title">Blocks</div>
          {L.kinds
            .filter((k) => k.type !== 'collection' || L.collections.length)
            .map((k) => (
              <button class="palette-item" disabled={ro} title={k.text} onClick={() => insert(newBlock(k.type, L))}>
                <i class={`codicon codicon-${k.icon}`} /> {k.label}
                <span class="muted">{k.text}</span>
              </button>
            ))}
          <div class="nav-title">Fields</div>
          <button class="palette-item" onClick={props.onEditFields}>
            <i class="codicon codicon-add" /> New report field…
            <span class="muted">Add it in Report fields, then place it here</span>
          </button>
        </aside>
      </div>
    </div>
  );
}

function clean(b: Block): Block {
  return Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as Block;
}

function newBlock(type: string, L: LayoutState): Block {
  const k = L.kinds.find((x) => x.type === type)!;
  const level = k.level;
  switch (type) {
    case 'field': {
      const f = L.report.find((x) => BODY_TYPES.includes(x.type)) ?? L.report[0];
      return { type, field: f?.id, title: f?.label, level };
    }
    case 'collection':
      return { type, collection: L.collections[0]?.id, title: L.collections[0]?.label, level };
    case 'chart': {
      const c = L.collections[0];
      return { type, collection: c?.id, by: c?.chartFields[0]?.id, kind: 'donut', level };
    }
    case 'heading':
      return { type, title: 'New chapter', level };
    case 'text':
      return { type, title: 'Notes', level, body: 'This report was prepared for **{{ report.client }}**.' };
    case 'fields_table':
      return { type, title: 'Details', level };
    case 'findings_table':
      return { type, title: 'Findings Overview', level };
    case 'severity_scale':
      return { type, title: 'Severity Rating', level };
    case 'html':
      return { type, file: L.partials[0] ?? 'custom.html', level };
    default:
      return { type, level };
  }
}

function blockIcon(b: Block, L: LayoutState): string {
  if (b.type === 'field') return TYPE_ICONS[L.report.find((f) => f.id === b.field)?.type ?? ''] ?? 'symbol-field';
  return L.kinds.find((k) => k.type === b.type)?.icon ?? 'symbol-misc';
}

function blockTitle(b: Block, L: LayoutState) {
  const fallback = {
    cover: 'Cover page',
    toc: 'Table of contents',
    page_break: '— page break —',
    severity_summary: 'Severity chart and counters',
    html: b.file,
    chart: `${L.collections.find((c) => c.id === b.collection)?.label ?? b.collection} by ${L.collections.find((c) => c.id === b.collection)?.chartFields.find((f) => f.id === b.by)?.label ?? b.by}`,
    field: L.report.find((f) => f.id === b.field)?.label ?? b.field,
    collection: L.collections.find((c) => c.id === b.collection)?.label ?? b.collection,
  }[b.type];
  const missing = (b.type === 'field' && !L.report.some((f) => f.id === b.field)) || ((b.type === 'collection' || b.type === 'chart') && !L.collections.some((c) => c.id === b.collection));
  return (
    <>
      {b.title || fallback || <span class="muted">untitled</span>}
      {missing && (
        <span class="tag override" title="Not in this template any more: the block prints nothing">
          missing
        </span>
      )}
    </>
  );
}

/* ------------------------------------------------------- block settings */

function BlockSettings(props: { block: Block; layout: LayoutState; readOnly: boolean; onChange: (patch: Partial<Block>, immediate?: boolean) => void }) {
  const { block: b, layout: L, onChange } = props;
  const ro = props.readOnly;
  const headed = !['cover', 'toc', 'page_break', 'html'].includes(b.type);
  const collection = L.collections.find((c) => c.id === b.collection);
  return (
    <div class="block-body">
      {headed && (
        <div class="prop">
          <label>Heading</label>
          <div class="row">
            <TextInput value={b.title ?? ''} disabled={ro} placeholder="No heading text" onCommit={(v) => onChange({ title: v })} />
            <select class="input level-select" value={String(b.level ?? 0)} disabled={ro} onChange={(e) => onChange({ level: Number((e.target as HTMLSelectElement).value) })}>
              {LEVELS.map((l) => (
                <option value={String(l.value)}>{l.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      {b.type === 'toc' && (
        <div class="prop">
          <label>Title and depth</label>
          <div class="row">
            <TextInput value={b.title ?? ''} placeholder="Table of Contents" disabled={ro} onCommit={(v) => onChange({ title: v })} />
            <select class="input level-select" value={String(b.depth ?? 2)} disabled={ro} onChange={(e) => onChange({ depth: Number((e.target as HTMLSelectElement).value) })}>
              <option value="1">Chapters only</option>
              <option value="2">Chapters and sections</option>
              <option value="3">Down to sub-sections</option>
            </select>
          </div>
        </div>
      )}
      {b.type === 'field' && (
        <>
          <div class="prop">
            <label>Field</label>
            <select
              class="input"
              value={b.field}
              disabled={ro}
              onChange={(e) => {
                const f = L.report.find((x) => x.id === (e.target as HTMLSelectElement).value);
                onChange({ field: f?.id, title: !b.title || L.report.some((x) => x.label === b.title) ? f?.label : b.title });
              }}
            >
              {L.report.map((f) => (
                <option value={f.id}>
                  {f.label} ({f.type})
                </option>
              ))}
            </select>
          </div>
          <div class="prop">
            <label>When the field is empty</label>
            <Toggle on={!!b.always} disabled={ro} label={b.always ? 'Print the heading anyway' : 'Leave the block out'} onChange={(v) => onChange({ always: v || undefined })} />
          </div>
        </>
      )}
      {b.type === 'fields_table' && (
        <div class="prop wide">
          <label>Rows</label>
          <div class="checks">
            <label class="check">
              <input type="checkbox" checked={!b.fields?.length} disabled={ro} onChange={(e) => onChange({ fields: (e.target as HTMLInputElement).checked ? undefined : L.report.filter((f) => !BODY_TYPES.includes(f.type)).slice(0, 4).map((f) => f.id) })} />
              Every short field (automatic)
            </label>
          </div>
          <div class="checks">
            {L.report
              .filter((f) => !BODY_TYPES.includes(f.type))
              .map((f) => {
                const auto = !b.fields?.length;
                const on = auto ? !(b.exclude ?? []).includes(f.id) : b.fields!.includes(f.id);
                return (
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={ro}
                      onChange={() =>
                        auto
                          ? onChange({ exclude: on ? [...(b.exclude ?? []), f.id] : (b.exclude ?? []).filter((x) => x !== f.id) })
                          : onChange({ fields: on ? b.fields!.filter((x) => x !== f.id) : [...b.fields!, f.id] })
                      }
                    />
                    {f.label}
                  </label>
                );
              })}
          </div>
        </div>
      )}
      {(b.type === 'collection' || b.type === 'chart') && (
        <div class="prop">
          <label>Collection</label>
          <select
            class="input"
            value={b.collection}
            disabled={ro}
            onChange={(e) => {
              const c = L.collections.find((x) => x.id === (e.target as HTMLSelectElement).value);
              onChange(b.type === 'chart' ? { collection: c?.id, by: c?.chartFields[0]?.id } : { collection: c?.id, title: !b.title || L.collections.some((x) => x.label === b.title) ? c?.label : b.title });
            }}
          >
            {L.collections.map((c) => (
              <option value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
      )}
      {b.type === 'chart' && (
        <>
          <div class="prop">
            <label>Count by</label>
            <select class="input" value={b.by} disabled={ro} onChange={(e) => onChange({ by: (e.target as HTMLSelectElement).value })}>
              {(collection?.chartFields ?? []).map((f) => (
                <option value={f.id}>{f.label}</option>
              ))}
            </select>
          </div>
          <div class="prop">
            <label>Chart</label>
            <div class="segmented">
              {['donut', 'bar'].map((k) => (
                <button class={(b.kind ?? 'donut') === k ? 'on' : ''} disabled={ro} onClick={() => onChange({ kind: k })}>
                  <i class={`codicon codicon-${k === 'donut' ? 'pie-chart' : 'graph'}`} /> {k === 'donut' ? 'Donut' : 'Bars'}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {b.type === 'text' && <TextBlock block={b} layout={L} readOnly={ro} onChange={onChange} />}
      {b.type === 'html' && (
        <div class="prop wide">
          <label>File of the template</label>
          <div class="row">
            <TextInput value={b.file ?? ''} mono disabled={ro} placeholder="custom.html" onCommit={(v) => onChange({ file: v })} />
            {L.partials
              .filter((p) => p !== b.file)
              .map((p) => (
                <button class="btn ghost" disabled={ro} onClick={() => onChange({ file: p })}>
                  {p}
                </button>
              ))}
          </div>
          <span class="muted">An HTML/Nunjucks file in the template folder, with the same placeholders as template.html. If it does not exist yet, create it next to design.yaml.</span>
        </div>
      )}
      {b.type === 'cover' && <span class="muted">Colors, layout, logo and texts of the cover are in the Theme tab.</span>}
      {b.type === 'severity_summary' && <span class="muted">Severity colors are in the Theme tab → Severities.</span>}
    </div>
  );
}

function TextBlock(props: { block: Block; layout: LayoutState; readOnly: boolean; onChange: (patch: Partial<Block>, immediate?: boolean) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(props.block.body ?? '');
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(props.block.body ?? '');
  }, [props.block.body]);
  const change = (v: string, immediate = false) => {
    setText(v);
    props.onChange({ body: v }, immediate);
  };
  const insert = (s: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    change(text.slice(0, start) + s + text.slice(end), true);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(start + s.length, start + s.length);
    });
  };
  const chips = [...props.layout.report.filter((f) => !['markdown', 'table', 'screenshots', 'image', 'code'].includes(f.type)).map((f) => ({ label: f.label, snippet: f.snippet })), ...STATS.map((s) => ({ label: s, snippet: `{{ ${s} }}` }))];
  return (
    <div class="prop wide">
      <label>Text (Markdown)</label>
      <textarea ref={ref} class="input mono" rows={6} value={text} disabled={props.readOnly} onInput={(e) => change((e.target as HTMLTextAreaElement).value)} onBlur={() => props.onChange({ body: text }, true)} />
      <div class="chips-row">
        <span class="muted">Insert:</span>
        {chips.map((c) => (
          <button class="chip-btn" disabled={props.readOnly} title={c.snippet} onClick={() => insert(c.snippet)}>
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------- template.html written by hand */

function Placeholders(props: { layout: LayoutState; readOnly: boolean; designId: string }) {
  const L = props.layout;
  const [copied, setCopied] = useState<string | undefined>();
  const insert = (text: string) => vscode.postMessage({ type: 'insertPlaceholder', text });
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(undefined), 1200);
  };
  const Row = (p: { icon: string; label: string; detail?: string; snippet: string }) => (
    <div class="ph-row">
      <i class={`codicon codicon-${p.icon}`} />
      <span class="ph-label">
        {p.label}
        {p.detail && <span class="muted"> {p.detail}</span>}
      </span>
      <code class="ph-code">{p.snippet}</code>
      <span class="fc-actions">
        <button class="btn" disabled={props.readOnly || !L.ownTemplate} title="Insert at the cursor in template.html" onClick={() => insert(p.snippet)}>
          <i class="codicon codicon-insert" /> Insert
        </button>
        <button class="icon-btn" title="Copy" onClick={() => copy(p.snippet)}>
          <i class={`codicon codicon-${copied === p.snippet ? 'check' : 'copy'}`} />
        </button>
      </span>
    </div>
  );
  return (
    <div class="placeholders">
      <div class="theme-bar">
        <span>
          <i class="codicon codicon-info" /> This template has its own <code>{L.ownTemplate ?? 'template.html'}</code> written by hand, so the order of the report is decided by that file. Put the cursor where you want a value in
          template.html and click <b>Insert</b>: each field gets the right placeholder for its type. Colors and fonts in the Theme tab still apply.
        </span>
        <span class="spacer" />
        <button class="btn" onClick={() => vscode.postMessage({ type: 'command', command: 'openTemplate' })}>
          <i class="codicon codicon-file-code" /> Open template.html
        </button>
        <button class="btn" onClick={() => cmd('reportStudio.openPreview', { template: props.designId })}>
          <i class="codicon codicon-open-preview" /> Preview
        </button>
      </div>
      <section class="group">
        <h2 class="group-title">
          <i class="codicon codicon-book" /> Report fields
        </h2>
        <div class="group-pad">
          {L.report.map((f) => (
            <Row icon={TYPE_ICONS[f.type] ?? 'symbol-field'} label={f.label} detail={f.type} snippet={f.snippet} />
          ))}
        </div>
      </section>
      {L.collections.map((c) => (
        <section class="group">
          <h2 class="group-title">
            <i class="codicon codicon-symbol-namespace" /> {c.label}
          </h2>
          <div class="group-pad">
            <Row icon="list-ordered" label={`Loop over ${c.label.toLowerCase()}`} detail={`one ${c.itemVar} at a time`} snippet={`{% for ${c.itemVar} in collections.${c.id} %}\n<h2>{{ ${c.itemVar}.number }} {{ ${c.itemVar}.title }}</h2>\n\n{% endfor %}`} />
            <Row icon="table" label="Table of the entries" snippet={`{{ item_table(collections.${c.id}) }}`} />
            {c.chartFields.slice(0, 1).map((f) => (
              <Row icon="pie-chart" label={`Chart by ${f.label.toLowerCase()}`} snippet={`{{ chart(collections.${c.id}, '${f.id}', 'donut') }}`} />
            ))}
            <div class="ph-sub muted">Inside the loop</div>
            {c.fields.map((f) => (
              <Row icon={TYPE_ICONS[f.type] ?? 'symbol-field'} label={f.label} detail={f.type} snippet={f.snippet} />
            ))}
          </div>
        </section>
      ))}
      <section class="group">
        <h2 class="group-title">
          <i class="codicon codicon-symbol-method" /> Building blocks
        </h2>
        <div class="group-pad">
          <Row icon="list-tree" label="Table of contents" snippet="{{ toc(2) }}" />
          <Row icon="whitespace" label="Page break" snippet="{{ pagebreak() }}" />
          <Row icon="pie-chart" label="Severity chart" snippet="{{ severity_chart('donut', 'Findings by severity') }}" />
          <Row icon="checklist" label="Findings table" snippet="{{ finding_table() }}" />
          <Row icon="symbol-numeric" label="Number of findings" snippet="{{ stats.total }}" />
          <Row icon="pass" label="Fixed / open" snippet="{{ stats.fixed }} / {{ stats.open }}" />
          <Row icon="paintcan" label="Logo from the Theme" snippet={`<img class="cover-logo" src="{{ theme.logo_url or asset('logo.svg') }}" alt="">`} />
        </div>
      </section>
    </div>
  );
}
