import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { request, vscode } from '../shared/vscode';
import './home.css';
import type { EngagementInfo, HomeState, HomeTab, LibraryInfo, TemplateInfo } from './types';

const SEVERITY_COLORS: Record<string, string> = { critical: '#7b1fa2', high: '#d32f2f', medium: '#f57c00', low: '#fbc02d', info: '#1976d2' };

const post = (msg: Record<string, unknown>) => vscode.postMessage(msg);
const command = (id: string, ...args: unknown[]) => post({ type: 'command', command: id, args });
const engagementAction = (dir: string, action: string) => post({ type: 'engagementAction', dir, action });
const templateAction = (id: string, action: string, file?: string) => post({ type: 'templateAction', id, action, file });

const Icon = ({ name, cls = '' }: { name: string; cls?: string }) => <i class={`codicon codicon-${name} ${cls}`} />;

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ago(ms: number): string {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- menu */

function Menu({ items }: { items: ({ label: string; icon: string; run: () => void; danger?: boolean } | false | undefined)[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div class="menu" ref={ref}>
      <button class="icon-btn" title="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="ellipsis" />
      </button>
      {open && (
        <div class="menu-list" role="menu">
          {items.filter(Boolean).map((it) => {
            const i = it as { label: string; icon: string; run: () => void; danger?: boolean };
            return (
              <button
                role="menuitem"
                class={`menu-item ${i.danger ? 'danger' : ''}`}
                onClick={() => {
                  setOpen(false);
                  i.run();
                }}
              >
                <Icon name={i.icon} /> {i.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- pieces */

/** Small picture of the cover, from the template's theme colors and layout. */
function CoverThumb({ t }: { t: TemplateInfo }) {
  const { accent, coverStart, coverEnd, coverText, layout } = t.theme;
  const gid = `g-${t.id.replace(/[^\w-]/g, '')}`;
  const light = layout === 'minimal';
  const fill = layout === 'gradient' || layout === 'image' ? `url(#${gid})` : coverStart;
  const text = light ? '#1d2433' : coverText;
  return (
    <svg class="thumb" viewBox="0 0 120 84" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color={coverStart} />
          <stop offset="1" stop-color={coverEnd} />
        </linearGradient>
      </defs>
      <rect width="120" height="84" fill="var(--thumb-bg)" />
      <g transform="translate(14 8)">
        <rect width="52" height="72" rx="2" fill={light ? '#ffffff' : fill} stroke="#0002" />
        {layout === 'split' && <rect width="20" height="72" fill="#ffffff22" />}
        {light && <rect width="4" height="72" fill={accent} />}
        <rect x="8" y="24" width="20" height="2.5" rx="1" fill={light ? accent : text} opacity=".7" />
        <rect x="8" y="30" width="36" height="5" rx="1" fill={text} />
        <rect x="8" y="38" width="28" height="3" rx="1" fill={text} opacity=".6" />
        <rect x="8" y="62" width="18" height="2" rx="1" fill={text} opacity=".5" />
      </g>
      <g transform="translate(72 14)">
        <rect width="38" height="56" rx="2" fill="#ffffff" stroke="#0002" />
        <rect x="5" y="6" width="18" height="3" rx="1" fill={accent} />
        {[14, 19, 24].map((y) => (
          <rect x="5" y={y} width="28" height="1.6" rx=".8" fill="#9aa1ad" />
        ))}
        <rect x="5" y="31" width="28" height="9" rx="1" fill={accent} opacity=".15" />
        <rect x="5" y="31" width="28" height="2.5" fill={accent} opacity=".8" />
        {[45, 50].map((y) => (
          <rect x="5" y={y} width="24" height="1.6" rx=".8" fill="#9aa1ad" />
        ))}
      </g>
    </svg>
  );
}

function SeverityBar({ e }: { e: EngagementInfo }) {
  const total = e.severities.reduce((n, s) => n + s.count, 0);
  if (!total) return null;
  return (
    <div class="sevbar" title={e.severities.filter((s) => s.count).map((s) => `${s.count} ${s.label}`).join(' · ')}>
      {e.severities
        .filter((s) => s.count)
        .map((s) => (
          <span style={{ flex: s.count, background: s.color }} />
        ))}
    </div>
  );
}

function Empty({ icon, title, children }: { icon: string; title: string; children?: preact.ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} cls="empty-icon" />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/* ------------------------------------------------------ engagements */

function EngagementCard({ e, compact }: { e: EngagementInfo; compact?: boolean }) {
  const counts = e.collections.filter((c) => c.count);
  const dates = e.dates.start ? `${e.dates.start}${e.dates.end && e.dates.end !== e.dates.start ? ` → ${e.dates.end}` : ''}` : e.dates.report;
  return (
    <div class={`eng ${e.active ? 'active' : ''} ${compact ? 'compact' : ''}`}>
      <button class="eng-main" onClick={() => post({ type: 'openEngagement', dir: e.dir })} title={`Open ${e.path}`}>
        <span class="eng-icon">
          <Icon name={e.icon} />
        </span>
        <span class="eng-text">
          <span class="eng-title">
            {e.name}
            {e.active && <span class="pill">active</span>}
          </span>
          <span class="eng-sub">{[e.client, e.title].filter(Boolean).join(' — ') || e.path}</span>
          {!compact && (
            <span class="eng-meta">
              <span class="tag">
                <Icon name="symbol-color" /> {e.designName || 'unknown template'}
              </span>
              {dates && (
                <span>
                  <Icon name="calendar" /> {dates}
                </span>
              )}
              {counts.map((c) => (
                <span>
                  <Icon name={c.icon} /> {c.count} {c.label.toLowerCase()}
                </span>
              ))}
              {e.open !== undefined && <span class={e.open ? 'warn' : 'ok'}>{e.open ? `${e.open} open` : 'all solved'}</span>}
            </span>
          )}
          {e.error && (
            <span class="eng-error">
              <Icon name="error" /> {e.error}
            </span>
          )}
          <SeverityBar e={e} />
        </span>
        <span class="eng-time">{ago(e.modified)}</span>
      </button>
      {!compact && (
        <div class="eng-actions">
          <button class="icon-btn" title="Live preview" onClick={() => engagementAction(e.dir, 'preview')}>
            <Icon name="open-preview" />
          </button>
          <button class="icon-btn" title="Build PDF" onClick={() => engagementAction(e.dir, 'build')}>
            <Icon name="file-pdf" />
          </button>
          <Menu
            items={[
              { label: 'Add Entry…', icon: 'add', run: () => engagementAction(e.dir, 'addEntry') },
              { label: 'New Report from This One (e.g. retest)…', icon: 'repo-forked', run: () => engagementAction(e.dir, 'newFrom') },
              { label: 'Change Report Type…', icon: 'arrow-swap', run: () => engagementAction(e.dir, 'changeType') },
              { label: 'Export Data…', icon: 'table', run: () => engagementAction(e.dir, 'export') },
              { label: 'Reveal in Explorer', icon: 'folder-opened', run: () => engagementAction(e.dir, 'reveal') },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function Engagements({ state, query, onNew }: { state: HomeState; query: string; onNew: () => void }) {
  const q = query.toLowerCase();
  const list = state.engagements.filter((e) => !q || [e.name, e.client, e.title, e.designName].some((x) => x?.toLowerCase().includes(q)));
  return (
    <section>
      <div class="section-head">
        <div>
          <h2>Engagements</h2>
          <p class="muted">
            One folder each, with report.yaml and the entries as Markdown files{state.engagementsDir ? <> — new ones go in <code>{state.engagementsDir}/</code></> : ''}.
          </p>
        </div>
        <button class="btn primary" onClick={onNew}>
          <Icon name="add" /> New Engagement
        </button>
      </div>
      {!state.engagements.length ? (
        <Empty icon="briefcase" title="No engagements yet">
          <p>Pick a template first — or build your own with its HTML — then create the engagement.</p>
          <div class="row">
            <button class="btn primary" onClick={onNew}>
              <Icon name="add" /> New Engagement
            </button>
            <button class="btn" onClick={() => command('reportStudio.openHome', 'templates')}>
              <Icon name="symbol-color" /> Browse Templates
            </button>
          </div>
        </Empty>
      ) : !list.length ? (
        <p class="muted">No engagement matches “{query}”.</p>
      ) : (
        <div class="eng-list">
          {list.map((e) => (
            <EngagementCard e={e} />
          ))}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------- templates */

function TemplateCard({ t, onUse }: { t: TemplateInfo; onUse: (id: string) => void }) {
  const own = t.source !== 'builtin';
  return (
    <div class={`tpl ${t.error ? 'broken' : ''}`}>
      <button class="tpl-thumb" onClick={() => templateAction(t.id, 'preview')} title="Preview with sample data">
        <CoverThumb t={t} />
        <span class="tpl-hover">
          <Icon name="open-preview" /> Preview
        </span>
      </button>
      <div class="tpl-body">
        <div class="tpl-title">
          <Icon name={t.icon} />
          <span>{t.name}</span>
        </div>
        <div class="tpl-sub">
          {own ? (
            <>
              <span class="tag own">{t.source === 'project' ? 'engagement' : 'yours'}</span>
              {t.extends && <span class="muted">extends {t.extends}</span>}
            </>
          ) : (
            <span class="muted">built-in · {t.id}</span>
          )}
          {t.usedBy > 0 && <span class="muted">· used by {t.usedBy}</span>}
        </div>
        {t.error ? (
          <p class="tpl-desc error">
            <Icon name="error" /> {t.error}
          </p>
        ) : (
          <p class="tpl-desc">{t.description || `${t.reportFields} report fields`}</p>
        )}
        <div class="tpl-cols">
          {t.collections.map((c) => (
            <span class="tag" title={`${c.fields} fields`}>
              <Icon name={c.icon} /> {c.label}
            </span>
          ))}
        </div>
        {own && t.files.length > 0 && (
          <div class="tpl-files">
            {t.files.map((f) => (
              <button class="file" onClick={() => templateAction(t.id, 'open', f)} title={`Open ${f}`}>
                <Icon name={f.endsWith('.css') ? 'symbol-color' : 'code'} /> {f}
              </button>
            ))}
          </div>
        )}
      </div>
      <div class="tpl-foot">
        <button class="btn primary" disabled={!!t.error} onClick={() => onUse(t.id)} title="Create an engagement with this template">
          Use
        </button>
        <button class="btn" onClick={() => templateAction(t.id, own ? 'edit' : 'extend')} title={own ? 'Fields, collections and layout' : 'Create your own template that inherits this one'}>
          <Icon name={own ? 'edit' : 'symbol-color'} /> {own ? 'Edit' : 'Customize'}
        </button>
        <Menu
          items={[
            { label: 'Preview with Sample Data', icon: 'open-preview', run: () => templateAction(t.id, 'preview') },
            { label: 'Create Template Extending It…', icon: 'symbol-color', run: () => templateAction(t.id, 'extend') },
            { label: 'Copy with HTML and CSS…', icon: 'copy', run: () => templateAction(t.id, 'copy') },
            own && { label: 'Edit Fields & Collections', icon: 'settings-gear', run: () => templateAction(t.id, 'edit') },
            own && { label: 'Open design.yaml', icon: 'file-code', run: () => templateAction(t.id, 'open', 'design.yaml') },
            { label: own ? 'Reveal in Explorer' : 'Reveal Files', icon: 'folder-opened', run: () => templateAction(t.id, 'reveal') },
            own && { label: 'Delete Template…', icon: 'trash', danger: true, run: () => templateAction(t.id, 'delete') },
          ]}
        />
      </div>
    </div>
  );
}

function Templates({ state, query, onUse }: { state: HomeState; query: string; onUse: (id: string) => void }) {
  const q = query.toLowerCase();
  const match = (t: TemplateInfo) => !q || [t.name, t.id, t.description, t.group, ...t.collections.map((c) => c.label)].some((x) => x?.toLowerCase().includes(q));
  const own = state.templates.filter((t) => t.source !== 'builtin' && match(t));
  const groups = new Map<string, TemplateInfo[]>();
  for (const t of state.templates.filter((t) => t.source === 'builtin' && match(t))) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  return (
    <section>
      <div class="section-head">
        <div>
          <h2>Templates</h2>
          <p class="muted">
            A template is a report type: its fields, collections (findings, events, IOCs…), cover, colors and HTML. Preview any of them with sample data, then use it or make it yours.
          </p>
        </div>
        <div class="row">
          <button class="btn" onClick={() => command('reportStudio.importTemplate')} title="Copy template folders (with a design.yaml) into the workspace">
            <Icon name="cloud-download" /> Import…
          </button>
          <button class="btn primary" onClick={() => command('reportStudio.newDesign')}>
            <Icon name="add" /> New Template
          </button>
        </div>
      </div>

      <h3 class="group">
        Your templates <span class="muted">{state.templatesDir ? `${state.templatesDir}/` : ''}</span>
      </h3>
      {own.length ? (
        <div class="tpl-grid">
          {own.map((t) => (
            <TemplateCard t={t} onUse={onUse} />
          ))}
        </div>
      ) : q ? (
        <p class="muted">None matches.</p>
      ) : (
        <div class="callout">
          <Icon name="lightbulb" />
          <div>
            <strong>Start from a preset, or from scratch.</strong> <em>Customize</em> creates a template that inherits a preset: add or hide fields with the editor, no HTML needed. <em>Copy with HTML and CSS</em> gives you every template file to change the layout. Templates live in{' '}
            <code>{state.templatesDir ?? 'designs'}/</code> and every engagement of the workspace can use them.
          </div>
        </div>
      )}

      {[...groups].map(([group, list]) => (
        <>
          <h3 class="group">{group}</h3>
          <div class="tpl-grid">
            {list.map((t) => (
              <TemplateCard t={t} onUse={onUse} />
            ))}
          </div>
        </>
      ))}
    </section>
  );
}

/* ---------------------------------------------------------- library */

function Library({ state, query }: { state: HomeState; query: string }) {
  const q = query.toLowerCase();
  const list = state.library.filter((l) => !q || [l.title, l.category].some((x) => x?.toLowerCase().includes(q)));
  return (
    <section>
      <div class="section-head">
        <div>
          <h2>Finding library</h2>
          <p class="muted">Reusable findings (Markdown files in a library/ folder, or the folder set in reportStudio.libraryPath). Insert them into the active engagement.</p>
        </div>
        <button class="btn" onClick={() => command('workbench.action.openSettings', 'reportStudio.libraryPath')}>
          <Icon name="settings-gear" /> Library Folder
        </button>
      </div>
      {!state.library.length ? (
        <Empty icon="library" title="The library is empty">
          <p>Open a finding and use “Save to Library” (right-click in the Content view) to reuse it in other engagements.</p>
        </Empty>
      ) : (
        <div class="lib-list">
          {list.map((l: LibraryInfo) => (
            <div class="lib">
              <span class="dot" style={{ background: SEVERITY_COLORS[l.severity ?? ''] ?? 'var(--muted)' }} title={l.severity} />
              <button class="lib-main" onClick={() => post({ type: 'openLibrary', file: l.file })}>
                <span class="lib-title">{l.title}</span>
                <span class="muted">{[l.category, l.score !== undefined ? `CVSS ${l.score.toFixed(1)}` : ''].filter(Boolean).join(' · ')}</span>
              </button>
              <button class="btn" disabled={!state.hasActive} title={state.hasActive ? 'Insert into the active engagement' : 'Create an engagement first'} onClick={() => post({ type: 'insertLibrary', file: l.file })}>
                <Icon name="insert" /> Insert
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- home */

function Overview({ state, onNew, go }: { state: HomeState; onNew: (id?: string) => void; go: (t: HomeTab) => void }) {
  const own = state.templates.filter((t) => t.source !== 'builtin');
  const featured = ['pentest', 'retest', 'incident-response', 'code-review', 'red-team', 'compliance-audit'].map((id) => state.templates.find((t) => t.id === id)).filter((t): t is TemplateInfo => !!t);
  const findings = state.engagements.reduce((n, e) => n + e.severities.reduce((m, s) => m + s.count, 0), 0);
  const open = state.engagements.reduce((n, e) => n + (e.open ?? 0), 0);
  return (
    <section>
      <div class="hero">
        <div>
          <h1>{state.workspace ?? 'Report Studio'}</h1>
          <p class="muted">Engagements, report templates and your finding library — all plain files in this workspace.</p>
        </div>
        <div class="row">
          <button class="btn" onClick={() => command('reportStudio.newDesign')}>
            <Icon name="symbol-color" /> New Template
          </button>
          <button class="btn primary" onClick={() => onNew()}>
            <Icon name="add" /> New Engagement
          </button>
        </div>
      </div>

      {!state.engagements.length && (
        <div class="steps">
          <div class="step">
            <span class="num">1</span>
            <div>
              <strong>Choose a template</strong>
              <p>15 presets for pentest, retest, red/blue team, forensics, audits… Preview them with sample data.</p>
              <a onClick={() => go('templates')}>Browse templates</a>
            </div>
          </div>
          <div class="step">
            <span class="num">2</span>
            <div>
              <strong>Make it yours (optional)</strong>
              <p>Add fields and collections with the editor, or copy the HTML and CSS and change the layout with a live preview.</p>
              <a onClick={() => command('reportStudio.newDesign')}>New template</a>
            </div>
          </div>
          <div class="step">
            <span class="num">3</span>
            <div>
              <strong>Create the engagement</strong>
              <p>Fill in the report form, add findings with screenshots, preview the pages and build the PDF.</p>
              <a onClick={() => onNew()}>New engagement</a>
            </div>
          </div>
        </div>
      )}

      <div class="grid">
        <div class="panel wide">
          <div class="panel-head">
            <h3>
              <Icon name="briefcase" /> Recent engagements
            </h3>
            {state.engagements.length > 0 && <a onClick={() => go('engagements')}>All {state.engagements.length}</a>}
          </div>
          {state.engagements.length ? (
            <div class="eng-list">
              {state.engagements.slice(0, 5).map((e) => (
                <EngagementCard e={e} compact />
              ))}
            </div>
          ) : (
            <p class="muted pad">
              Nothing yet. <a onClick={() => onNew()}>Create your first engagement</a>.
            </p>
          )}
        </div>

        <div class="panel">
          <div class="panel-head">
            <h3>
              <Icon name="graph" /> At a glance
            </h3>
          </div>
          <div class="stats">
            <button class="stat" onClick={() => go('engagements')}>
              <b>{state.engagements.length}</b>
              <span>engagements</span>
            </button>
            <button class="stat" onClick={() => go('engagements')}>
              <b>{findings}</b>
              <span>findings{open ? ` · ${open} open` : ''}</span>
            </button>
            <button class="stat" onClick={() => go('templates')}>
              <b>{own.length}</b>
              <span>your templates</span>
            </button>
            <button class="stat" onClick={() => go('library')}>
              <b>{state.library.length}</b>
              <span>library entries</span>
            </button>
          </div>
        </div>

        <div class="panel wide">
          <div class="panel-head">
            <h3>
              <Icon name="symbol-color" /> {own.length ? 'Your templates' : 'Popular templates'}
            </h3>
            <a onClick={() => go('templates')}>All templates</a>
          </div>
          <div class="mini-tpls">
            {(own.length ? own.slice(0, 6) : featured).map((t) => (
              <div class="mini-tpl">
                <button class="mini-thumb" onClick={() => templateAction(t.id, 'preview')} title="Preview with sample data">
                  <CoverThumb t={t} />
                </button>
                <div class="mini-text">
                  <span class="mini-name">{t.name}</span>
                  <span class="mini-actions">
                    <a onClick={() => onNew(t.id)}>Use</a>
                    <a onClick={() => templateAction(t.id, 'preview')}>Preview</a>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <h3>
              <Icon name="zap" /> Quick actions
            </h3>
          </div>
          <div class="quick">
            <button onClick={() => command('reportStudio.newDesign')}>
              <Icon name="new-file" /> New template from scratch
            </button>
            <button onClick={() => command('reportStudio.copyDesign')}>
              <Icon name="code" /> Copy a template with its HTML
            </button>
            <button onClick={() => command('reportStudio.importTemplate')}>
              <Icon name="cloud-download" /> Import templates
            </button>
            <button onClick={() => go('library')}>
              <Icon name="library" /> Finding library
            </button>
            <button onClick={() => command('workbench.action.openSettings', '@ext:hacknseek.report-studio')}>
              <Icon name="settings-gear" /> Settings
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------- new engagement */

function NewEngagement({ state, initial, onClose }: { state: HomeState; initial?: string; onClose: () => void }) {
  const usable = state.templates.filter((t) => !t.error);
  const [design, setDesign] = useState(initial && usable.some((t) => t.id === initial) ? initial : (usable.find((t) => t.id === 'pentest') ?? usable[0])?.id ?? '');
  const [name, setName] = useState(`${new Date().toISOString().slice(0, 7)}-`);
  const [client, setClient] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const t = usable.find((x) => x.id === design);
  const folder = slug(name);
  const taken = !!folder && state.taken.includes(folder);

  useEffect(() => {
    const el = nameRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  // Suggest the client in the folder name while it still is the default.
  const onClient = (v: string) => {
    if (/^\d{4}-\d{2}-[\w-]*$/.test(name) && (name.endsWith('-') || name.endsWith(slug(client)))) setName(`${name.slice(0, 8)}${slug(v)}`);
    setClient(v);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!folder || taken || !design || busy) return;
    setBusy(true);
    setError('');
    const r = await request<{ error?: string }>({ type: 'createEngagement', name: folder, design, client, start_date: start || undefined, end_date: end || undefined });
    setBusy(false);
    if (r.error) setError(r.error);
    else onClose();
  };

  const groups = new Map<string, TemplateInfo[]>();
  for (const x of usable) groups.set(x.group, [...(groups.get(x.group) ?? []), x]);

  return (
    <div class="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form class="dialog" onSubmit={submit} aria-label="New engagement">
        <div class="dialog-head">
          <h2>New engagement</h2>
          <button type="button" class="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        {!state.hasFolder && (
          <div class="callout warn">
            <Icon name="warning" /> Open a folder first: engagements and templates are stored in the workspace.
            <button type="button" class="btn" onClick={() => command('workbench.action.files.openFolder')}>
              Open Folder
            </button>
          </div>
        )}
        <div class="dialog-body">
          <label class="fld">
            <span>Template</span>
            <select class="input" value={design} onChange={(e) => setDesign((e.target as HTMLSelectElement).value)}>
              {[...groups].map(([g, list]) => (
                <optgroup label={g}>
                  {list.map((x) => (
                    <option value={x.id}>{x.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {t && (
            <div class="dialog-tpl">
              <CoverThumb t={t} />
              <div>
                <p>{t.description}</p>
                <div class="tpl-cols">
                  {t.collections.map((c) => (
                    <span class="tag">
                      <Icon name={c.icon} /> {c.label}
                    </span>
                  ))}
                </div>
                <a onClick={() => templateAction(t.id, 'preview')}>Preview with sample data</a>
              </div>
            </div>
          )}
          <label class="fld">
            <span>Client</span>
            <input class="input" value={client} placeholder="ACME Corp" onInput={(e) => onClient((e.target as HTMLInputElement).value)} />
          </label>
          <label class="fld">
            <span>Folder name</span>
            <input ref={nameRef} class={`input ${taken ? 'invalid' : ''}`} value={name} required onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <small class={taken ? 'error' : 'muted'}>{taken ? 'A folder with this name already exists.' : folder ? `Created in ${state.engagementsDir ?? '.'}/${folder}` : 'Required'}</small>
          </label>
          {t?.hasDates && (
            <div class="fld-row">
              <label class="fld">
                <span>Start</span>
                <input class="input" type="date" value={start} onInput={(e) => setStart((e.target as HTMLInputElement).value)} />
              </label>
              <label class="fld">
                <span>End</span>
                <input class="input" type="date" value={end} min={start} onInput={(e) => setEnd((e.target as HTMLInputElement).value)} />
              </label>
            </div>
          )}
          {error && (
            <p class="error">
              <Icon name="error" /> {error}
            </p>
          )}
        </div>
        <div class="dialog-foot">
          <span class="muted">Everything else is filled in the report form.</span>
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={!folder || taken || !design || busy || !state.hasFolder}>
            {busy ? <Icon name="loading" cls="codicon-modifier-spin" /> : <Icon name="add" />} Create
          </button>
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------- app */

const TABS: { id: HomeTab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'engagements', label: 'Engagements', icon: 'briefcase' },
  { id: 'templates', label: 'Templates', icon: 'symbol-color' },
  { id: 'library', label: 'Library', icon: 'library' },
];

function App() {
  const [state, setState] = useState<HomeState | null>(null);
  const [tab, setTab] = useState<HomeTab>(() => vscode.getState<{ tab?: HomeTab }>()?.tab ?? 'home');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<{ design?: string } | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'state') setState(msg.state);
      if (msg.type === 'navigate') {
        if (msg.tab) setTab(msg.tab);
        if (msg.newEngagement) setDialog({ design: typeof msg.newEngagement === 'string' ? msg.newEngagement : undefined });
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => vscode.setState({ tab }), [tab]);
  useEffect(() => setQuery(''), [tab]);

  const counts = useMemo<Record<HomeTab, number | undefined>>(
    () => ({ home: undefined, engagements: state?.engagements.length, templates: state?.templates.length, library: state?.library.length || undefined }),
    [state],
  );

  if (!state) return <div class="loading">Loading…</div>;
  const onNew = (design?: string) => setDialog({ design });

  return (
    <div class="home">
      <nav class="nav">
        {TABS.map((t) => (
          <button class={`nav-tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} /> {t.label}
            {counts[t.id] !== undefined && <span class="count">{counts[t.id]}</span>}
          </button>
        ))}
        <span class="spacer" />
        {tab !== 'home' && (
          <input class="input search" type="search" placeholder={`Search ${tab}`} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        )}
      </nav>
      {!state.hasFolder && (
        <div class="callout warn top">
          <Icon name="warning" />
          <div>No folder is open. Open one to store engagements and your templates (you can still preview the built-in templates).</div>
          <button class="btn" onClick={() => command('workbench.action.files.openFolder')}>
            Open Folder
          </button>
        </div>
      )}
      <main class="content">
        {tab === 'home' && <Overview state={state} onNew={onNew} go={setTab} />}
        {tab === 'engagements' && <Engagements state={state} query={query} onNew={() => onNew()} />}
        {tab === 'templates' && <Templates state={state} query={query} onUse={onNew} />}
        {tab === 'library' && <Library state={state} query={query} />}
      </main>
      {dialog && <NewEngagement state={state} initial={dialog.design} onClose={() => setDialog(null)} />}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
