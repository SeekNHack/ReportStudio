import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { scoreCvss, severityForScore } from '../../src/core/cvss';
import { vscode } from '../shared/vscode';
import { getPath, Sections, setPath, type Values } from './sections';
import './form.css';
import type { FieldDef, FieldIssue, InitMessage, Meta } from './types';


function App() {
  const [init, setInit] = useState<InitMessage | null>(null);
  const [values, setValues] = useState<Values>({});
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tab, setTab] = useState<'content' | 'theme'>(() => (vscode.getState<{ tab?: 'content' | 'theme' }>()?.tab ?? 'content'));
  const timers = useRef(new Map<string, number>());
  const edited = useRef(new Map<string, number>());

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'init') {
        setInit(msg);
        setValues(msg.values);
        setIssues(msg.issues);
        setMeta(msg.meta);
      } else if (msg.type === 'values') {
        // Keep what the user is typing right now; take everything else from the document.
        const now = Date.now();
        setValues((old) => {
          const next: Values = { ...msg.values };
          for (const [k, t] of edited.current) if (now - t < 1200) setPath(next, k, getPath(old, k));
          return next;
        });
        setIssues(msg.issues);
        setMeta(msg.meta);
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => vscode.setState({ tab }), [tab]);

  const change = (key: string, value: unknown, immediate = false) => {
    edited.current.set(key, Date.now());
    setValues((v) => {
      const next = { ...v, theme: { ...((v.theme as Values) ?? {}) } };
      setPath(next, key, value);
      return next;
    });
    clearTimeout(timers.current.get(key));
    const send = () => vscode.postMessage({ type: 'change', key, value });
    if (immediate) send();
    else timers.current.set(key, window.setTimeout(send, 250));
  };

  if (!init || !meta) return <div class="loading"><i class="codicon codicon-loading codicon-modifier-spin" /> Loading…</div>;

  const isFinding = init.kind === 'finding';
  const fields = init.fields;
  const fieldIssues = (id: string) => issues.filter((i) => i.field === id);
  const general = issues.filter((i) => !i.field || !fields.some((f) => f.id === i.field));

  return (
    <div class={`app ${init.kind}`}>
      <Header kind={init.kind} values={values} meta={meta} fields={fields} onChange={change} />
      {meta.parseError && (
        <div class="banner error">
          <i class="codicon codicon-error" /> The file cannot be parsed: {meta.parseError}. <a onClick={() => vscode.postMessage({ type: 'command', command: 'openAsText' })}>Open as text</a> to fix it.
        </div>
      )}
      {meta.designError && (
        <div class="banner error">
          <i class="codicon codicon-error" /> {meta.designError}
        </div>
      )}
      {!meta.inProject && !meta.library && (
        <div class="banner">
          <i class="codicon codicon-info" /> This file is not inside a report project (no report.yaml found above it).
        </div>
      )}
      {meta.collectionMissing && (
        <div class="banner warning">
          <i class="codicon codicon-warning" /> The folder of this file is not a collection of design "{meta.designName}". Add it in the design editor or move the file.
        </div>
      )}
      {meta.library && (
        <div class="banner">
          <i class="codicon codicon-library" /> Library entry — fields come from the active project's design ({meta.designName ?? 'none'}).
        </div>
      )}
      {general.map((i) => (
        <div class={`banner ${i.severity}`}>
          <i class={`codicon codicon-${i.severity === 'error' ? 'error' : 'warning'}`} /> {i.message}
        </div>
      ))}

      {init.kind === 'report' && (
        <div class="tabs">
          <button class={tab === 'content' ? 'on' : ''} onClick={() => setTab('content')}>
            <i class="codicon codicon-edit" /> Content
          </button>
          <button class={tab === 'theme' ? 'on' : ''} onClick={() => setTab('theme')}>
            <i class="codicon codicon-paintcan" /> Theme
          </button>
        </div>
      )}

      {tab === 'theme' && init.kind === 'report' ? (
        <ThemeEditor meta={meta} values={values} onChange={change} />
      ) : (
        <Sections
          fields={fields.filter((f) => !(isFinding && f.id === (meta.collection?.titleField ?? 'title')))}
          values={values}
          meta={meta}
          onChange={change}
          issuesFor={fieldIssues}
        />
      )}
    </div>
  );
}

function ThemeEditor(props: { meta: Meta; values: Values; onChange: (k: string, v: unknown, immediate?: boolean) => void }) {
  const theme = (props.values.theme as Values) ?? {};
  const effective = { ...props.meta.themeDefaults, ...theme };
  const overridden = Object.keys(theme).length;
  return (
    <>
      <div class="theme-bar">
        <span>
          <i class="codicon codicon-info" /> Changes are saved in <code>report.yaml → theme</code> and override the design defaults. Keep the live preview open to see them.
        </span>
        <span class="spacer" />
        <button class="btn" onClick={() => vscode.postMessage({ type: 'command', command: 'reportStudio.openPreview' })}>
          <i class="codicon codicon-open-preview" /> Live Preview
        </button>
        <button class="btn ghost" disabled={!overridden} onClick={() => props.onChange('theme', undefined, true)}>
          <i class="codicon codicon-discard" /> Reset all
        </button>
      </div>
      <Sections fields={props.meta.themeFields} values={props.values} meta={props.meta} onChange={props.onChange} issuesFor={() => []} prefix="theme." defaults={props.meta.themeDefaults} context={effective} />
    </>
  );
}

function Header(props: { kind: 'finding' | 'report'; values: Values; meta: Meta; fields: FieldDef[]; onChange: (k: string, v: unknown, immediate?: boolean) => void }) {
  const { values, meta } = props;
  const severity = useMemo(() => {
    const explicit = meta.severities.find((s) => s.id === values.severity);
    const cvss = scoreCvss(values.cvss);
    if (explicit) return { ...explicit, score: cvss?.score };
    if (cvss && meta.severities.length) return { ...severityForScore(cvss.score, meta.severities), score: cvss.score };
    return undefined;
  }, [values.severity, values.cvss, meta.severities]);
  const fixed = values.fixed === true || ['fixed', 'solved', 'resolved'].includes(String(values.retest_status));
  const status = props.fields.find((f) => f.id === 'retest_status')?.options?.find((o) => o.value === values.retest_status);
  const cmd = (command: string) => vscode.postMessage({ type: 'command', command });
  return (
    <header class="header">
      <div class="header-main">
        {props.kind === 'finding' ? (
          <>
            <div class="chips">
              <span class="chip number">{meta.number ?? meta.collection?.itemLabel ?? 'Item'}</span>
              {severity && (
                <span class="chip severity" style={{ '--c': severity.color }}>
                  {severity.label}
                  {severity.score !== undefined && <b>{severity.score.toFixed(1)}</b>}
                </span>
              )}
              {status ? (
                <span class="chip severity" style={{ '--c': status.color ?? '#888' }}>
                  {fixed ? '✓ ' : ''}
                  {status.label}
                </span>
              ) : (
                values.fixed !== undefined && <span class={`chip ${fixed ? 'fixed' : 'open'}`}>{fixed ? '✓ Fixed' : 'Open'}</span>
              )}
              <span class="chip ghost">{meta.file}</span>
            </div>
            <input
              class="title-input"
              value={String(values[meta.collection?.titleField ?? 'title'] ?? '')}
              placeholder={`${meta.collection?.itemLabel ?? 'Item'} title`}
              onInput={(e) => props.onChange(meta.collection?.titleField ?? 'title', (e.target as HTMLInputElement).value)}
            />
          </>
        ) : (
          <>
            <div class="chips">
              <span class="chip number">Report</span>
              {meta.projectName && <span class="chip ghost">{meta.projectName}</span>}
              <button class="design-select" title="Change the report type — convert this report, or create a new one from it (e.g. a retest)" onClick={() => cmd('reportStudio.switchDesign')}>
                <i class="codicon codicon-symbol-color" />
                <span>{meta.designName ?? meta.designId ?? String(values.design ?? '')}</span>
                <i class="codicon codicon-arrow-swap" />
              </button>
            </div>
            <div class="title-static">{String(values.title ?? 'Untitled report')}</div>
          </>
        )}
      </div>
      <div class="header-actions">
        <button class="btn" onClick={() => cmd('reportStudio.openPreview')} title="Live preview (Ctrl+Alt+P)">
          <i class="codicon codicon-open-preview" /> Preview
        </button>
        <button class="btn primary" onClick={() => cmd('reportStudio.buildPdf')} title="Build PDF (Ctrl+Alt+B)">
          <i class="codicon codicon-file-pdf" /> Build PDF
        </button>
        {props.kind === 'report' && (
          <button class="icon-btn" onClick={() => cmd('reportStudio.newReportFrom')} title="New report from this one (e.g. retest)">
            <i class="codicon codicon-repo-forked" />
          </button>
        )}
        <button class="icon-btn" onClick={() => cmd('openAsText')} title="Open as text">
          <i class="codicon codicon-go-to-file" />
        </button>
      </div>
    </header>
  );
}

render(<App />, document.getElementById('app')!);
