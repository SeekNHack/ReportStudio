import { useRef, useState } from 'preact/hooks';
import { fileToBase64, request } from '../shared/vscode';
import { Annotator } from './Annotator';
import { CodeEditor } from './CodeEditor';
import { CvssField } from './CvssField';
import { MarkdownEditor, type MarkdownEditorApi } from './MarkdownEditor';
import type { FieldDef, FieldIssue, Meta } from './types';

export interface FieldProps {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown, immediate?: boolean) => void;
  meta: Meta;
  issues: FieldIssue[];
  /** placeholder value shown when empty (theme defaults) */
  fallback?: unknown;
  onReset?: () => void;
  context?: Record<string, unknown>;
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** Bumped when an image is re-saved by the annotator, so thumbnails reload. */
const imageVersions = new Map<string, number>();
const withVersion = (url: string, path: string) => (imageVersions.has(path) ? `${url}${url.includes('?') ? '&' : '?'}v=${imageVersions.get(path)}` : url);
const annotated = (path: string) => {
  imageVersions.set(path, Date.now());
  return path;
};

function toDateInput(v: unknown): string {
  if (!v) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

export function Field(p: FieldProps) {
  const { field } = p;
  const empty = p.value === undefined || p.value === null || p.value === '' || (Array.isArray(p.value) && !p.value.length);
  const missing = field.required && empty;
  const wide = ['markdown', 'code', 'screenshots', 'list', 'text', 'cvss', 'table'].includes(field.type) || (field.type === 'enum' && field.display === 'cards');
  return (
    <div class={`field field-${field.type} ${wide ? 'wide' : ''} ${missing ? 'missing' : ''}`} id={`field-${field.id}`}>
      <div class="field-label">
        <label>
          {field.label}
          {field.required && <span class="req" title="Required">*</span>}
        </label>
        {p.onReset && !empty && (
          <button class="icon-btn" title="Reset to default" onClick={p.onReset}>
            <i class="codicon codicon-discard" />
          </button>
        )}
      </div>
      <div class="field-control">
        <Control {...p} />
      </div>
      {field.help && <div class="field-help">{field.help}</div>}
      {p.issues.map((i) => (
        <div class={`field-issue ${i.severity}`}>
          <i class={`codicon codicon-${i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info'}`} /> {i.message}
        </div>
      ))}
    </div>
  );
}

function Control(p: FieldProps) {
  const { field, value, onChange } = p;
  const ph = field.placeholder ?? (p.fallback !== undefined ? str(p.fallback) : undefined);
  switch (field.type) {
    case 'markdown':
      return <MarkdownField {...p} />;
    case 'text':
      return <textarea class="input" rows={field.rows ?? 4} value={str(value)} placeholder={ph} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} />;
    case 'number':
      return (
        <input
          class="input narrow"
          type="number"
          value={str(value)}
          placeholder={ph}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            onChange(v === '' ? undefined : Number(v));
          }}
        />
      );
    case 'boolean': {
      const on = value === undefined ? p.fallback === true || field.default === true : value === true;
      return (
        <button class={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on, true)}>
          <span class="toggle-knob" />
          <span class="toggle-text">{on ? 'Yes' : 'No'}</span>
        </button>
      );
    }
    case 'enum':
      return <EnumField {...p} />;
    case 'date':
      return <input class="input narrow" type="date" value={toDateInput(value)} onInput={(e) => onChange((e.target as HTMLInputElement).value || undefined, true)} />;
    case 'datetime':
      return (
        <div class="row">
          <input class="input narrow" type="datetime-local" value={toDateTimeInput(value)} onInput={(e) => onChange((e.target as HTMLInputElement).value || undefined, true)} />
          <button class="btn ghost" title="Now" onClick={() => onChange(nowLocal(), true)}>
            <i class="codicon codicon-clock" /> Now
          </button>
        </div>
      );
    case 'table':
      return <TableField {...p} />;
    case 'list':
      return <ListField {...p} />;
    case 'cvss':
      return <CvssField value={str(value)} onChange={(v) => onChange(v || undefined)} severities={p.meta.severities} />;
    case 'image':
      return <ImageField {...p} />;
    case 'code':
      return <CodeField {...p} />;
    case 'screenshots':
      return <ScreenshotsField {...p} />;
    case 'color':
      return <ColorField {...p} />;
    case 'font':
      return <FontField {...p} />;
    case 'range': {
      const v = value === undefined ? Number(p.fallback ?? field.default ?? field.min ?? 0) : Number(value);
      return (
        <div class="range">
          <input type="range" min={field.min} max={field.max} step={field.step} value={v} onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
          <input class="input tiny" type="number" min={field.min} max={field.max} step={field.step} value={v} onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
        </div>
      );
    }
    default:
      return <input class="input" value={str(value)} placeholder={ph} onInput={(e) => onChange((e.target as HTMLInputElement).value)} spellcheck={field.type !== 'user'} />;
  }
}

function toDateTimeInput(v: unknown): string {
  if (!v) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00`;
  return '';
}

function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* --------------------------------------------------------------- table */

function Cell(props: { col: FieldDef; value: unknown; onChange: (v: unknown, immediate?: boolean) => void }) {
  const { col, value, onChange } = props;
  switch (col.type) {
    case 'enum':
      return (
        <select class="input" value={str(value)} onChange={(e) => onChange((e.target as HTMLSelectElement).value || undefined, true)}>
          <option value="">—</option>
          {col.options?.map((o) => (
            <option value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case 'boolean':
      return <input type="checkbox" checked={value === true} onChange={(e) => onChange((e.target as HTMLInputElement).checked, true)} />;
    case 'number':
      return <input class="input" type="number" value={str(value)} onInput={(e) => onChange((e.target as HTMLInputElement).value === '' ? undefined : Number((e.target as HTMLInputElement).value))} />;
    case 'date':
      return <input class="input" type="date" value={toDateInput(value)} onInput={(e) => onChange((e.target as HTMLInputElement).value || undefined, true)} />;
    case 'datetime':
      return <input class="input" type="datetime-local" value={toDateTimeInput(value)} onInput={(e) => onChange((e.target as HTMLInputElement).value || undefined, true)} />;
    default:
      return <input class="input" value={str(value)} placeholder={col.placeholder} onInput={(e) => onChange((e.target as HTMLInputElement).value || undefined)} />;
  }
}

function TableField(p: FieldProps) {
  const cols = p.field.columns ?? [];
  const rows = (Array.isArray(p.value) ? p.value : []) as Record<string, unknown>[];
  const update = (next: Record<string, unknown>[], immediate = false) => p.onChange(next.length ? next : undefined, immediate);
  const setCell = (i: number, id: string, v: unknown, immediate?: boolean) =>
    update(
      rows.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r };
        if (v === undefined) delete next[id];
        else next[id] = v;
        return next;
      }),
      immediate,
    );
  const move = (i: number, d: number) => {
    const next = [...rows];
    const [r] = next.splice(i, 1);
    next.splice(i + d, 0, r);
    update(next, true);
  };
  return (
    <div class="table-field">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th>
                {c.label}
                {c.required && <span class="req">*</span>}
              </th>
            ))}
            <th class="actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr>
              {cols.map((c) => (
                <td class={`cell-${c.type}`}>
                  <Cell col={c} value={r?.[c.id]} onChange={(v, im) => setCell(i, c.id, v, im)} />
                </td>
              ))}
              <td class="actions">
                <button class="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <i class="codicon codicon-arrow-up" />
                </button>
                <button class="icon-btn" title="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                  <i class="codicon codicon-arrow-down" />
                </button>
                <button class="icon-btn" title="Remove row" onClick={() => update(rows.filter((_, j) => j !== i), true)}>
                  <i class="codicon codicon-trash" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button class="btn ghost" onClick={() => update([...rows, {}], true)}>
        <i class="codicon codicon-add" /> Add row
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ markdown */

const TOOLBAR: { icon: string; title: string; run: (api: MarkdownEditorApi) => void }[] = [
  { icon: 'bold', title: 'Bold (Ctrl+B)', run: (a) => a.wrap('**', '**', 'bold') },
  { icon: 'italic', title: 'Italic (Ctrl+I)', run: (a) => a.wrap('_', '_', 'italic') },
  { icon: 'code', title: 'Inline code', run: (a) => a.wrap('`', '`', 'code') },
  { icon: 'link', title: 'Link', run: (a) => a.wrap('[', '](https://)', 'text') },
  { icon: 'list-unordered', title: 'Bullet list', run: (a) => a.insertBlock('- ') },
  { icon: 'list-ordered', title: 'Numbered list', run: (a) => a.insertBlock('1. ') },
  { icon: 'quote', title: 'Quote', run: (a) => a.insertBlock('> ') },
  { icon: 'table', title: 'Table', run: (a) => a.insertBlock('| Column | Column |\n|---|---|\n| | |') },
  { icon: 'type-hierarchy', title: 'Mermaid diagram', run: (a) => a.insertBlock('```mermaid\nflowchart LR\n  A[Attacker] --> B[Application]\n```') },
  { icon: 'symbol-variable', title: 'Placeholder {{ }}', run: (a) => a.wrap('{{ ', ' }}', 'report.client') },
];

function MarkdownField(p: FieldProps) {
  const api = useRef<MarkdownEditorApi | null>(null);
  const [preview, setPreview] = useState(false);
  const [panel, setPanel] = useState<'code' | 'image' | undefined>();
  return (
    <div class="md">
      <div class="md-toolbar">
        <button class={`icon-btn ${panel === 'code' ? 'active' : ''}`} title="Code block…" onClick={() => setPanel(panel === 'code' ? undefined : 'code')}>
          <i class="codicon codicon-terminal" />
        </button>
        {TOOLBAR.map((b) => (
          <button class="icon-btn" title={b.title} onClick={() => api.current && b.run(api.current)}>
            <i class={`codicon codicon-${b.icon}`} />
          </button>
        ))}
        <button class={`icon-btn ${panel === 'image' ? 'active' : ''}`} title="Screenshot with caption…" onClick={() => setPanel(panel === 'image' ? undefined : 'image')}>
          <i class="codicon codicon-file-media" />
        </button>
        <span class="spacer" />
        <span class="md-hint">Paste screenshots · {'{{'} for placeholders</span>
        <button class={`icon-btn ${preview ? 'active' : ''}`} title="Toggle preview" onClick={() => setPreview(!preview)}>
          <i class="codicon codicon-eye" />
        </button>
      </div>
      {panel === 'code' && <CodeBlockPanel onInsert={(t) => (api.current?.insertBlock(t), setPanel(undefined))} onClose={() => setPanel(undefined)} />}
      {panel === 'image' && <ImagePanel onInsert={(t) => (api.current?.insertBlock(t), setPanel(undefined))} onClose={() => setPanel(undefined)} />}
      <MarkdownEditor value={str(p.value)} onChange={(v) => p.onChange(v)} placeholders={p.meta.placeholders} rows={p.field.rows} apiRef={api} placeholder={p.field.placeholder} />
      {preview && <MiniPreview text={str(p.value)} base={p.meta.projectBase} />}
    </div>
  );
}

export const LANGUAGES = [
  'auto', 'bash', 'shell', 'powershell', 'http', 'json', 'yaml', 'xml', 'html', 'javascript', 'typescript', 'python', 'java', 'csharp', 'php', 'go',
  'rust', 'c', 'cpp', 'ruby', 'sql', 'kotlin', 'swift', 'dockerfile', 'nginx', 'ini', 'diff', 'plaintext',
];

/** Builds a fence info string: `python title="x.py" caption="…" lines highlight="2-3"`. */
function fenceInfo(o: { lang: string; title?: string; caption?: string; lines?: boolean; highlight?: string }): string {
  const q = (v: string) => `"${v.replace(/"/g, "'")}"`;
  return [o.lang === 'auto' ? '' : o.lang, o.title && `title=${q(o.title)}`, o.caption && `caption=${q(o.caption)}`, o.lines && 'lines', o.highlight && `highlight=${q(o.highlight)}`].filter(Boolean).join(' ');
}

function CodeBlockPanel(props: { onInsert: (text: string) => void; onClose: () => void }) {
  const [o, setO] = useState({ lang: 'http', title: '', caption: '', lines: false, highlight: '', code: '' });
  const set = (k: keyof typeof o) => (e: Event) => setO({ ...o, [k]: (e.target as HTMLInputElement).type === 'checkbox' ? (e.target as HTMLInputElement).checked : (e.target as HTMLInputElement).value });
  return (
    <div class="md-panel">
      <div class="md-panel-row">
        <label>
          Language
          <select class="input" value={o.lang} onChange={set('lang')}>
            {LANGUAGES.map((l) => (
              <option value={l}>{l}</option>
            ))}
          </select>
        </label>
        <label class="grow">
          File name / title
          <input class="input" value={o.title} placeholder="exploit.py" onInput={set('title')} />
        </label>
        <label class="grow">
          Caption
          <input class="input" value={o.caption} placeholder="Request used to dump the users table" onInput={set('caption')} />
        </label>
      </div>
      <textarea class="input mono" rows={5} value={o.code} placeholder="Paste the code here (or leave empty and type it in the editor)" onInput={set('code')} spellcheck={false} />
      <div class="md-panel-row">
        <label class="check">
          <input type="checkbox" checked={o.lines} onChange={set('lines')} /> Line numbers
        </label>
        <label>
          Highlight lines
          <input class="input tiny" value={o.highlight} placeholder="3,5-7" onInput={set('highlight')} />
        </label>
        <span class="spacer" />
        <button class="btn ghost" onClick={props.onClose}>Cancel</button>
        <button class="btn primary" onClick={() => props.onInsert(`\`\`\`${fenceInfo(o)}\n${o.code.replace(/\n$/, '')}\n\`\`\``)}>
          <i class="codicon codicon-add" /> Insert code block
        </button>
      </div>
    </div>
  );
}

const WIDTHS = ['', '75%', '50%', '33%'];

function ImagePanel(props: { onInsert: (text: string) => void; onClose: () => void }) {
  const [path, setPath] = useState('');
  const [caption, setCaption] = useState('');
  const [width, setWidth] = useState('');
  const [over, setOver] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const save = async (files: FileList | null | undefined) => {
    const f = [...(files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f) setPath((await request<{ path: string }>({ type: 'saveImage', name: f.name, data: await fileToBase64(f) })).path);
  };
  return (
    <div
      class={`md-panel ${over ? 'over' : ''}`}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => (e.preventDefault(), setOver(false), void save(e.dataTransfer?.files))}
      onPaste={(e) => void save(e.clipboardData?.files)}
    >
      <div class="md-panel-row">
        <button
          class="btn"
          onClick={async () => {
            const r = await request<{ path?: string }>({ type: 'pickImage' });
            if (r.path) setPath(r.path);
          }}
        >
          <i class="codicon codicon-folder-opened" /> Choose…
        </button>
        <span class="mono muted grow">{path || 'or paste / drop a screenshot here'}</span>
        {path && (
          <button class="btn" onClick={() => setAnnotating(true)} title="Boxes, arrows, redaction, text, crop">
            <i class="codicon codicon-edit" /> Annotate…
          </button>
        )}
      </div>
      {annotating && (
        <Annotator
          path={path}
          onClose={() => setAnnotating(false)}
          onSaved={(next) => {
            setPath(annotated(next));
            setAnnotating(false);
          }}
        />
      )}
      <div class="md-panel-row">
        <label class="grow">
          Caption
          <input class="input" value={caption} placeholder="Error message disclosing the SQL query" onInput={(e) => setCaption((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Width
          <select class="input" value={width} onChange={(e) => setWidth((e.target as HTMLSelectElement).value)}>
            {WIDTHS.map((w) => (
              <option value={w}>{w || 'Full'}</option>
            ))}
          </select>
        </label>
        <span class="spacer" />
        <button class="btn ghost" onClick={props.onClose}>Cancel</button>
        <button class="btn primary" disabled={!path} onClick={() => props.onInsert(`![${caption.replace(/[[\]]/g, '')}${width ? `|${width}` : ''}](${path})`)}>
          <i class="codicon codicon-add" /> Insert screenshot
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- code */

/** Value of a `code` field: a fenced block, so the file stays readable Markdown. */
export function parseCodeValue(v: string): { info: string; code: string } {
  const m = /^\s*(```+|~~~+)([^\n]*)\n([\s\S]*?)\n?\1\s*$/.exec(v);
  return m ? { info: m[2].trim(), code: m[3] } : { info: '', code: v };
}

function infoParts(info: string) {
  const lang = /^([^\s=]+)(?=\s|$)/.exec(info)?.[1] ?? '';
  const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(info)?.[1] ?? '';
  return { lang, title: attr('title'), caption: attr('caption'), lines: /(^|\s)lines(\s|$)/.test(info), highlight: attr('highlight') };
}

function CodeField(p: FieldProps) {
  const { info, code } = parseCodeValue(str(p.value));
  const parts = infoParts(info);
  const o = { ...parts, lang: parts.lang || p.field.language || 'auto', lines: parts.lines || (!info && !!p.field.lines) };
  const emit = (next: Partial<typeof o> & { code?: string }, immediate = false) => {
    const m = { ...o, code, ...next };
    p.onChange(m.code.trim() ? `\`\`\`${fenceInfo(m)}\n${m.code.replace(/\n$/, '')}\n\`\`\`` : undefined, immediate);
  };
  return (
    <div class="md code-field">
      <div class="md-toolbar code-toolbar">
        <select class="input slim" value={o.lang} title="Language" onChange={(e) => emit({ lang: (e.target as HTMLSelectElement).value }, true)}>
          {[...new Set([o.lang, ...LANGUAGES])].map((l) => (
            <option value={l}>{l === 'auto' ? 'auto-detect' : l}</option>
          ))}
        </select>
        <input class="input slim grow" value={o.title} placeholder="File name / title" onInput={(e) => emit({ title: (e.target as HTMLInputElement).value })} />
        <input class="input slim grow" value={o.caption} placeholder="Caption" onInput={(e) => emit({ caption: (e.target as HTMLInputElement).value })} />
        <input class="input slim tiny" value={o.highlight} placeholder="Mark 2-4" title="Lines to highlight, e.g. 3,5-7" onInput={(e) => emit({ highlight: (e.target as HTMLInputElement).value })} />
        <button class={`icon-btn ${o.lines ? 'active' : ''}`} title="Line numbers" onClick={() => emit({ lines: !o.lines }, true)}>
          <i class="codicon codicon-list-ordered" />
        </button>
      </div>
      <CodeEditor value={code} onChange={(c) => emit({ code: c })} rows={p.field.rows} placeholder={p.field.placeholder ?? 'Paste code, requests, logs or commands'} />
    </div>
  );
}

/* --------------------------------------------------------- screenshots */

interface Shot {
  image: string;
  caption?: string;
  width?: string;
}

function ScreenshotsField(p: FieldProps) {
  const shots: Shot[] = (Array.isArray(p.value) ? p.value : []).map((x) => (typeof x === 'string' ? { image: x } : (x as Shot))).filter((x) => x && x.image);
  const [over, setOver] = useState(false);
  const update = (next: Shot[], immediate = false) =>
    p.onChange(next.length ? next.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ''))) : undefined, immediate);
  const src = (path: string) => withVersion(/^[a-z]+:/i.test(path) || !p.meta.projectBase ? path : `${p.meta.projectBase}/${path}`, path);
  const [editing, setEditing] = useState<number>();
  const add = async (files: FileList | null | undefined) => {
    const images = [...(files ?? [])].filter((x) => x.type.startsWith('image/'));
    const added: Shot[] = [];
    for (const f of images) added.push({ image: (await request<{ path: string }>({ type: 'saveImage', name: f.name, data: await fileToBase64(f) })).path, caption: '' });
    if (added.length) update([...shots, ...added], true);
  };
  const move = (i: number, d: number) => {
    const next = [...shots];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    update(next, true);
  };
  return (
    <div
      class={`shots ${over ? 'over' : ''}`}
      tabIndex={0}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => (e.preventDefault(), setOver(false), void add(e.dataTransfer?.files))}
      onPaste={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        void add(e.clipboardData?.files);
      }}
    >
      {shots.map((s, i) => (
        <div class="shot">
          <button class="shot-thumb" title="Annotate: boxes, arrows, redaction, text, crop" onClick={() => setEditing(i)}>
            <img src={src(s.image)} />
            <span class="shot-n">Fig. {i + 1}</span>
            <span class="shot-edit">
              <i class="codicon codicon-edit" /> Annotate
            </span>
          </button>
          <div class="shot-body">
            <input class="input" value={s.caption ?? ''} placeholder="Caption, e.g. Admin panel reachable without authentication" onInput={(e) => update(shots.map((x, j) => (j === i ? { ...x, caption: (e.target as HTMLInputElement).value } : x)))} />
            <div class="row">
              <span class="mono muted shot-path">{s.image}</span>
              <span class="spacer" />
              <select class="input slim" value={s.width ?? ''} title="Printed width" onChange={(e) => update(shots.map((x, j) => (j === i ? { ...x, width: (e.target as HTMLSelectElement).value || undefined } : x)), true)}>
                {WIDTHS.map((w) => (
                  <option value={w}>{w || 'Full width'}</option>
                ))}
              </select>
              <button class="icon-btn" title="Annotate" onClick={() => setEditing(i)}>
                <i class="codicon codicon-edit" />
              </button>
              <button class="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <i class="codicon codicon-arrow-up" />
              </button>
              <button class="icon-btn" title="Move down" disabled={i === shots.length - 1} onClick={() => move(i, 1)}>
                <i class="codicon codicon-arrow-down" />
              </button>
              <button class="icon-btn" title="Remove" onClick={() => update(shots.filter((_, j) => j !== i), true)}>
                <i class="codicon codicon-trash" />
              </button>
            </div>
          </div>
        </div>
      ))}
      {editing !== undefined && shots[editing] && (
        <Annotator
          path={shots[editing].image}
          onClose={() => setEditing(undefined)}
          onSaved={(path) => {
            update(shots.map((x, j) => (j === editing ? { ...x, image: annotated(path) } : x)), true);
            setEditing(undefined);
          }}
        />
      )}
      <div class="shots-add">
        <i class="codicon codicon-device-camera" />
        <span>Paste or drop screenshots here</span>
        <button
          class="btn"
          onClick={async () => {
            const r = await request<{ path?: string }>({ type: 'pickImage' });
            if (r.path) update([...shots, { image: r.path, caption: '' }], true);
          }}
        >
          <i class="codicon codicon-folder-opened" /> Choose…
        </button>
      </div>
    </div>
  );
}

/** Small client-side Markdown preview (the paged preview is the real one). */
function MiniPreview(props: { text: string; base?: string }) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let html = esc(props.text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, c) => `<pre class="mini-code">${c}</pre>`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${/^[a-z]+:/i.test(src) || !props.base ? src : `${props.base}/${src}`}">`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a>$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/_([^_]+)_/g, '<i>$1</i>')
    .replace(/^### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^## (.*)$/gm, '<h4>$1</h4>')
    .replace(/^# (.*)$/gm, '<h3>$1</h3>')
    .replace(/^- (.*)$/gm, '<li>$1</li>');
  html = html
    .split(/\n{2,}/)
    .map((b) => (/^<(pre|h\d|li|img)/.test(b) ? b : `<p>${b}</p>`))
    .join('');
  return <div class="mini-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ---------------------------------------------------------------- enum */

function EnumField(p: FieldProps) {
  const { field, value, onChange } = p;
  const options = field.options ?? [];
  const explicit = value === undefined || value === '' ? undefined : String(value);
  const current = explicit ?? (field.default !== undefined && field.default !== null ? String(field.default) : undefined);
  const effective = current ?? (p.fallback !== undefined ? String(p.fallback) : undefined);
  if (field.display === 'cards')
    return (
      <div class="cards">
        {options.map((o) => (
          <button class={`card ${effective === o.value ? 'on' : ''}`} onClick={() => onChange(o.value, true)}>
            <CoverThumb layout={o.value} theme={p.context ?? {}} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    );
  if (options.length <= 6 && field.display !== 'select')
    return (
      <div class="segmented">
        {!field.required && (
          <button class={!current ? 'on' : ''} onClick={() => onChange(undefined, true)} title="Not set">
            {field.id === 'severity' ? 'Auto' : '—'}
          </button>
        )}
        {options.map((o) => (
          <button class={current === o.value ? 'on' : ''} onClick={() => onChange(o.value, true)} style={o.color ? { '--opt': o.color } : undefined}>
            {o.color && <span class="dot" />}
            {o.label}
          </button>
        ))}
      </div>
    );
  return (
    <select class="input narrow" value={current ?? ''} onChange={(e) => onChange((e.target as HTMLSelectElement).value || undefined, true)}>
      {!field.required && <option value="">—</option>}
      {options.map((o) => (
        <option value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** Mini mock-up of each cover layout, drawn with the current theme colors. */
function CoverThumb(props: { layout: string; theme: Record<string, unknown> }) {
  const t = props.theme;
  const a = String(t.cover_start ?? '#14183a');
  const b = String(t.cover_end ?? '#3b3fd8');
  const txt = String(t.cover_text ?? '#fff');
  const accent = String(t.accent ?? '#3b3fd8');
  const id = `g-${props.layout}`;
  const lines = (color: string, x = 10) => (
    <>
      <rect x={x} y="12" width="18" height="4" rx="1" fill={color} opacity=".9" />
      <rect x={x} y="58" width="40" height="6" rx="1" fill={color} />
      <rect x={x} y="68" width="28" height="3.5" rx="1" fill={color} opacity=".7" />
      <rect x={x} y="80" width="22" height="2.5" rx="1" fill={color} opacity=".5" />
      <rect x={x} y="85" width="22" height="2.5" rx="1" fill={color} opacity=".5" />
    </>
  );
  return (
    <svg class="thumb" viewBox="0 0 70 99" width="70" height="99">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color={a} />
          <stop offset="1" stop-color={b} />
        </linearGradient>
        <pattern id={`${id}-img`} width="14" height="14" patternUnits="userSpaceOnUse">
          <rect width="14" height="14" fill={b} />
          <path d="M0 14L7 5l7 9z" fill={a} opacity=".55" />
        </pattern>
      </defs>
      {props.layout === 'gradient' && (
        <>
          <rect width="70" height="99" fill={`url(#${id})`} />
          {lines(txt)}
        </>
      )}
      {props.layout === 'solid' && (
        <>
          <rect width="70" height="99" fill={a} />
          {lines(txt)}
        </>
      )}
      {props.layout === 'image' && (
        <>
          <rect width="70" height="99" fill={`url(#${id}-img)`} />
          <rect width="70" height="99" fill="#000" opacity=".35" />
          {lines(txt)}
        </>
      )}
      {props.layout === 'split' && (
        <>
          <rect width="70" height="99" fill={`url(#${id}-img)`} />
          <rect width="44" height="99" fill={a} />
          {lines(txt, 6)}
        </>
      )}
      {props.layout === 'minimal' && (
        <>
          <rect width="70" height="99" fill="#fff" />
          <rect width="6" height="99" fill={accent} />
          {lines(accent, 12)}
        </>
      )}
    </svg>
  );
}

/* ---------------------------------------------------------------- list */

function ListField(p: FieldProps) {
  const items = Array.isArray(p.value) ? p.value.map(str) : p.value ? [str(p.value)] : [];
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const update = (next: string[], immediate = false) => p.onChange(next.length ? next : undefined, immediate);
  return (
    <div class="list">
      {items.map((item, i) => (
        <div class="list-row">
          <i class="codicon codicon-circle-small-filled list-bullet" />
          <input
            class="input"
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={item}
            onInput={(e) => update(items.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                update([...items.slice(0, i + 1), '', ...items.slice(i + 1)], true);
                setTimeout(() => refs.current[i + 1]?.focus(), 30);
              }
              if (e.key === 'Backspace' && !item) {
                e.preventDefault();
                update(items.filter((_, j) => j !== i), true);
                setTimeout(() => refs.current[Math.max(0, i - 1)]?.focus(), 30);
              }
            }}
          />
          <button class="icon-btn" title="Remove" onClick={() => update(items.filter((_, j) => j !== i), true)}>
            <i class="codicon codicon-close" />
          </button>
        </div>
      ))}
      <button
        class="btn ghost"
        onClick={() => {
          update([...items, ''], true);
          setTimeout(() => refs.current[items.length]?.focus(), 30);
        }}
      >
        <i class="codicon codicon-add" /> Add
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- image */

function ImageField(p: FieldProps) {
  const path = str(p.value);
  const [over, setOver] = useState(false);
  const src = path ? withVersion(/^[a-z]+:/i.test(path) || !p.meta.projectBase ? path : `${p.meta.projectBase}/${path}`, path) : '';
  const [editing, setEditing] = useState(false);
  const save = async (files: FileList | null | undefined) => {
    const f = [...(files ?? [])].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    const r = await request<{ path: string }>({ type: 'saveImage', name: f.name, data: await fileToBase64(f) });
    p.onChange(r.path, true);
  };
  return (
    <div
      class={`image-field ${over ? 'over' : ''}`}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => (e.preventDefault(), setOver(false), void save(e.dataTransfer?.files))}
      onPaste={(e) => void save(e.clipboardData?.files)}
      tabIndex={0}
    >
      <div class="image-thumb">{src ? <img src={src} /> : <i class="codicon codicon-file-media" />}</div>
      <div class="image-info">
        <span class="mono">{path || 'Drop, paste or choose an image'}</span>
        <div class="row">
          <button
            class="btn"
            onClick={async () => {
              const r = await request<{ path?: string }>({ type: 'pickImage' });
              if (r.path) p.onChange(r.path, true);
            }}
          >
            <i class="codicon codicon-folder-opened" /> Choose…
          </button>
          {path && !/^[a-z]+:/i.test(path) && (
            <button class="btn" onClick={() => setEditing(true)}>
              <i class="codicon codicon-edit" /> Annotate
            </button>
          )}
          {path && (
            <button class="btn ghost" onClick={() => p.onChange(undefined, true)}>
              <i class="codicon codicon-trash" /> Remove
            </button>
          )}
        </div>
      </div>
      {editing && (
        <Annotator
          path={path}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            p.onChange(annotated(next), true);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- theme */

const PRESETS = ['#3b3fd8', '#0f766e', '#b91c1c', '#c2410c', '#7c3aed', '#0369a1', '#be185d', '#1f2937', '#15803d', '#a16207'];

function ColorField(p: FieldProps) {
  const v = str(p.value) || str(p.fallback) || '#000000';
  const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
  return (
    <div class="color">
      <label class="swatch" style={{ background: v }}>
        <input type="color" value={hex} onInput={(e) => p.onChange((e.target as HTMLInputElement).value)} />
      </label>
      <input class="input tiny mono" value={str(p.value)} placeholder={str(p.fallback)} onInput={(e) => p.onChange((e.target as HTMLInputElement).value || undefined)} />
      {['accent', 'cover_start', 'cover_end'].includes(p.field.id) && (
        <div class="presets">
          {PRESETS.map((c) => (
            <button class={`preset ${v.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => p.onChange(c, true)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FontField(p: FieldProps) {
  const v = str(p.value) || str(p.fallback);
  const options = p.field.options ?? [];
  const custom = /\.(woff2?|ttf|otf)$/i.test(v);
  return (
    <div class="font">
      <select class="input" value={custom ? '__file' : v} onChange={(e) => p.onChange((e.target as HTMLSelectElement).value, true)}>
        {options.map((o) => (
          <option value={o.value} style={{ fontFamily: o.value }}>
            {o.label}
          </option>
        ))}
        {!options.some((o) => o.value === v) && !custom && v && <option value={v}>{v}</option>}
        {custom && <option value="__file">{v.split('/').pop()}</option>}
      </select>
      <button
        class="btn"
        title="Use a font file (.woff2, .woff, .ttf, .otf) copied into assets/fonts"
        onClick={async () => {
          const r = await request<{ path?: string }>({ type: 'pickImage', accept: 'font' });
          if (r.path) p.onChange(r.path, true);
        }}
      >
        <i class="codicon codicon-text-size" /> Font file…
      </button>
      <span class="font-sample" style={{ fontFamily: custom ? undefined : v }}>
        Aa Bb 123
      </span>
    </div>
  );
}
