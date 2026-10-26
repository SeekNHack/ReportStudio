import { vscode } from '../shared/vscode';
import './preview.css';

interface RenderMsg {
  type: 'render';
  version: number;
  body: string;
  css: string;
  title: string;
  design: string;
  issues: { file: string; message: string; severity: string; line?: number }[];
  renderMs: number;
  lang: string;
  /** set when previewing a template with sample data */
  template?: string;
}

const app = document.getElementById('app')!;
const nonce = app.dataset.nonce!;
const vendor = app.dataset.vendor!;
const saved = vscode.getState<{ zoom: number | 'fit' }>() ?? { zoom: 'fit' };
let zoom: number | 'fit' = saved.zoom;

app.innerHTML = `
  <div class="toolbar">
    <button class="icon-btn" data-act="zoomOut" title="Zoom out"><i class="codicon codicon-zoom-out"></i></button>
    <button class="zoom-label" data-act="fit" title="Fit width"></button>
    <button class="icon-btn" data-act="zoomIn" title="Zoom in"><i class="codicon codicon-zoom-in"></i></button>
    <span class="sep"></span>
    <span class="pages"></span>
    <span class="spacer"></span>
    <span class="status"><i class="codicon codicon-loading codicon-modifier-spin"></i> Rendering…</span>
    <button class="icon-btn" data-act="refresh" title="Refresh"><i class="codicon codicon-refresh"></i></button>
    <span class="sample-note" title="Every field is filled with sample values">Sample data</span>
    <button class="btn for-template" data-act="editTemplate" title="Fields, collections and layout"><i class="codicon codicon-edit"></i> Edit Template</button>
    <button class="btn primary for-template" data-act="useTemplate" title="Create an engagement with this template"><i class="codicon codicon-add"></i> New Engagement</button>
    <button class="btn for-project" data-act="report" title="Edit report details"><i class="codicon codicon-edit"></i> Report</button>
    <button class="btn primary for-project" data-act="build" title="Build PDF (Ctrl+Alt+B)"><i class="codicon codicon-file-pdf"></i> Build PDF</button>
  </div>
  <div class="issues hidden"></div>
  <div class="stage">
    <iframe class="frame active" title="Report preview"></iframe>
    <iframe class="frame" title="Report preview"></iframe>
    <div class="empty"><i class="codicon codicon-loading codicon-modifier-spin"></i><span>Rendering report…</span></div>
  </div>
`;

const $ = <T extends HTMLElement>(s: string) => app.querySelector(s) as T;
const frames = [...app.querySelectorAll('iframe')] as HTMLIFrameElement[];
const status = $('.status');
const pagesLabel = $('.pages');
const zoomLabel = $('.zoom-label');
const issuesBox = $('.issues');
let active = 0;
let token = 0;
let pending: { token: number; frame: HTMLIFrameElement; started: number } | undefined;
let queued: RenderMsg | undefined;

function stageBg(): string {
  const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  return dark ? '#2b2b2e' : '#dcdde1';
}

const SCREEN_CSS = `
  html, body { background: STAGE_BG !important; }
  body { margin: 0; }
  .pagedjs_pages { display: flex; flex-direction: column; align-items: center; padding: 24px 0 48px; zoom: var(--zoom, 1); }
  .pagedjs_page { background: #fff; box-shadow: 0 2px 14px rgba(0,0,0,.28); margin-bottom: 22px; }
  [data-finding] { cursor: default; }
  [data-finding]:hover { outline: 2px dashed rgba(80,120,255,.35); outline-offset: 6px; }
`;

function docFor(msg: RenderMsg, t: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const mermaid = msg.body.includes('class="mermaid"') ? `<script nonce="${nonce}" src="${vendor}/mermaid.min.js"></script>` : '';
  return `<!doctype html><html lang="${esc(msg.lang)}"><head><meta charset="utf-8"><title>${esc(msg.title)}</title>
<style>${msg.css}</style>
<style>html, body { background: ${stageBg()}; }</style>
<script nonce="${nonce}">
window.PagedConfig = {
  auto: true,
  before: async function () {
    if (window.mermaid) {
      window.mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
      try { await window.mermaid.run({ querySelector: 'pre.mermaid' }); } catch (e) { console.error(e); }
    }
  },
  after: function (flow) {
    // Added after pagination: Paged.js drops @media screen rules from the stylesheets it processes.
    var style = document.createElement('style');
    style.textContent = ${JSON.stringify(SCREEN_CSS)}.replace('STAGE_BG', '${stageBg()}');
    document.head.appendChild(style);
    parent.postMessage({ __paged: ${t}, pages: flow ? flow.total : document.querySelectorAll('.pagedjs_page').length }, '*'); }
};
</script>
${mermaid}
<script nonce="${nonce}" src="${vendor}/paged.polyfill.js"></script>
</head><body>${msg.body}</body></html>`;
}

// The srcdoc frame is not served by the webview's resource loader in browser hosts
// (code-server, vscode.dev), so every resource URL is fetched here and handed over as a blob: URL.
// Literal prefix: URL.origin would decode %2B in remote authorities and stop matching the HTML.
const resourceOrigin = /^[a-z]+:\/\/[^/]+/i.exec(vendor)?.[0] ?? new URL(vendor).origin;
const resourceUrl = new RegExp(`${resourceOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^"'()\\s<>]+`, 'g');
let blobs = new Map<string, Promise<string>>();

async function localize(html: string): Promise<string> {
  const urls = [...new Set(html.match(resourceUrl) ?? [])];
  const next = new Map<string, Promise<string>>();
  for (const u of urls) {
    const raw = u.replace(/&amp;/g, '&');
    next.set(u, blobs.get(u) ?? fetch(raw).then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : raw), () => raw));
  }
  for (const [u, b] of blobs) if (!next.has(u)) void b.then((x) => x.startsWith('blob:') && URL.revokeObjectURL(x));
  blobs = next;
  const resolved = new Map(await Promise.all(urls.map(async (u) => [u, await next.get(u)!] as const)));
  return html.replace(resourceUrl, (u) => resolved.get(u) ?? u);
}

function render(msg: RenderMsg): void {
  if (pending) {
    queued = msg; // render the latest content once the current pass is done
    return;
  }
  const t = ++token;
  const frame = frames[1 - active];
  pending = { token: t, frame, started: performance.now() };
  status.innerHTML = '<i class="codicon codicon-loading codicon-modifier-spin"></i> Rendering…';
  showIssues(msg.issues);
  void localize(docFor(msg, t)).then((html) => {
    if (pending?.token === t) frame.srcdoc = html;
  });
}

function showIssues(issues: RenderMsg['issues']): void {
  const relevant = issues.filter((i) => i.severity !== 'info');
  issuesBox.classList.toggle('hidden', !relevant.length);
  issuesBox.innerHTML = relevant
    .map(
      (i, idx) =>
        `<div class="issue ${i.severity}" data-idx="${idx}"><i class="codicon codicon-${i.severity === 'error' ? 'error' : 'warning'}"></i><span>${i.message.replace(/</g, '&lt;')}</span><span class="where">${i.file.split(/[\\/]/).slice(-2).join('/')}${i.line ? `:${i.line}` : ''}</span></div>`,
    )
    .join('');
  issuesBox.querySelectorAll<HTMLElement>('.issue').forEach((el) => {
    el.onclick = () => {
      const i = relevant[Number(el.dataset.idx)];
      vscode.postMessage({ type: 'openIssue', file: i.file, line: i.line });
    };
  });
}

function applyZoom(frame: HTMLIFrameElement): void {
  const doc = frame.contentDocument;
  const page = doc?.querySelector('.pagedjs_page') as HTMLElement | null;
  if (!doc || !page) return;
  let z = typeof zoom === 'number' ? zoom : 1;
  if (zoom === 'fit') {
    const width = page.getBoundingClientRect().width / (Number(doc.documentElement.style.getPropertyValue('--zoom')) || 1);
    z = Math.min(1.5, Math.max(0.3, (frame.clientWidth - 48) / width));
  }
  doc.documentElement.style.setProperty('--zoom', String(z));
  zoomLabel.textContent = `${Math.round(z * 100)}%${zoom === 'fit' ? ' · fit' : ''}`;
}

function wire(frame: HTMLIFrameElement): void {
  const doc = frame.contentDocument!;
  doc.addEventListener('dblclick', (e) => {
    const el = (e.target as HTMLElement).closest('[data-finding]') as HTMLElement | null;
    if (el) vscode.postMessage({ type: 'openFinding', id: el.dataset.finding });
  });
  doc.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    e.preventDefault();
    if (href.startsWith('#')) doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  frame.contentWindow!.addEventListener('scroll', () => updatePage(frame), { passive: true });
}

function updatePage(frame: HTMLIFrameElement): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  const pages = [...doc.querySelectorAll('.pagedjs_page')] as HTMLElement[];
  const mid = (frame.contentWindow?.innerHeight ?? 0) / 3;
  const current = pages.findIndex((p) => p.getBoundingClientRect().bottom > mid) + 1;
  pagesLabel.textContent = pages.length ? `Page ${Math.max(1, current)} / ${pages.length}` : '';
}

window.addEventListener('message', (e) => {
  const data = e.data;
  if (data && typeof data.__paged === 'number') {
    if (!pending || data.__paged !== pending.token) return;
    const { frame, started } = pending;
    const old = frames[active];
    const scroll = old.contentWindow?.scrollY ?? 0;
    applyZoom(frame);
    wire(frame);
    frame.contentWindow?.scrollTo(0, scroll);
    frame.classList.add('active');
    old.classList.remove('active');
    active = frames.indexOf(frame);
    $('.empty').classList.add('hidden');
    status.innerHTML = `<i class="codicon codicon-check"></i> ${data.pages} pages · ${Math.round(performance.now() - started)} ms`;
    pending = undefined;
    updatePage(frame);
    if (queued) {
      const next = queued;
      queued = undefined;
      render(next);
    }
    return;
  }
  if (data?.type === 'render' || data?.type === 'error') setTemplate(data.template);
  if (data?.type === 'render') render(data as RenderMsg);
  if (data?.type === 'error') {
    status.innerHTML = '<i class="codicon codicon-error"></i> Error';
    showIssues([{ file: data.file ?? '', message: data.message, severity: 'error' }]);
    $('.empty').classList.remove('hidden');
    $('.empty').innerHTML = `<i class="codicon codicon-error"></i><span>${String(data.message).replace(/</g, '&lt;')}</span>`;
  }
});

app.querySelector('.toolbar')!.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
  const current = Number(frames[active].contentDocument?.documentElement.style.getPropertyValue('--zoom')) || 1;
  if (act === 'zoomIn') zoom = Math.min(3, Math.round((current + 0.1) * 10) / 10);
  if (act === 'zoomOut') zoom = Math.max(0.3, Math.round((current - 0.1) * 10) / 10);
  if (act === 'fit') zoom = 'fit';
  if (act === 'zoomIn' || act === 'zoomOut' || act === 'fit') {
    vscode.setState({ zoom });
    applyZoom(frames[active]);
  }
  if (act === 'refresh') vscode.postMessage({ type: 'refresh' });
  if (act === 'build') vscode.postMessage({ type: 'command', command: 'reportStudio.buildPdf' });
  if (act === 'report') vscode.postMessage({ type: 'command', command: 'reportStudio.openReport' });
  if (act === 'editTemplate') vscode.postMessage({ type: 'command', command: 'reportStudio.editTemplate', args: [template] });
  if (act === 'useTemplate') vscode.postMessage({ type: 'command', command: 'reportStudio.openHome', args: ['templates', { newEngagement: template }] });
});

let template: string | undefined;
function setTemplate(id: string | undefined) {
  template = id;
  app.querySelector('.toolbar')!.classList.toggle('template-mode', !!id);
}
setTemplate(undefined);

window.addEventListener('resize', () => zoom === 'fit' && applyZoom(frames[active]));
vscode.postMessage({ type: 'ready' });
