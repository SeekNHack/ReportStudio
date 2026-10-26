import * as pdfjs from 'pdfjs-dist';
// Runs the pdf.js worker on the main thread: webviews cannot start workers from their resource origin.
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.js';
import { vscode } from '../shared/vscode';
import '../preview/preview.css';
import './pdf.css';

(globalThis as any).pdfjsWorker = pdfjsWorker;

interface ShowMsg {
  type: 'show';
  url: string;
  name: string;
  version: number;
}

const app = document.getElementById('app')!;
let zoom: number | 'fit' = vscode.getState<{ zoom: number | 'fit' }>()?.zoom ?? 'fit';
let doc: pdfjs.PDFDocumentProxy | undefined;
let current: ShowMsg | undefined;
let baseWidth = 595;

app.innerHTML = `
  <div class="toolbar">
    <button class="icon-btn" data-act="zoomOut" title="Zoom out"><i class="codicon codicon-zoom-out"></i></button>
    <button class="zoom-label" data-act="fit" title="Fit width"></button>
    <button class="icon-btn" data-act="zoomIn" title="Zoom in"><i class="codicon codicon-zoom-in"></i></button>
    <span class="sep"></span>
    <span class="pages"></span>
    <span class="spacer"></span>
    <span class="status hidden"><i class="codicon codicon-loading codicon-modifier-spin"></i> Loading…</span>
    <button class="icon-btn" data-act="reveal" title="Reveal in Explorer"><i class="codicon codicon-folder-opened"></i></button>
    <button class="btn" data-act="download" title="Download the PDF to this computer"><i class="codicon codicon-cloud-download"></i> Download</button>
    <button class="btn primary" data-act="build" title="Build PDF again (Ctrl+Alt+B)"><i class="codicon codicon-file-pdf"></i> Rebuild</button>
  </div>
  <div class="stage pdf-stage"><div class="sheets"></div><div class="empty"><i class="codicon codicon-loading codicon-modifier-spin"></i><span>Loading PDF…</span></div></div>
`;

const $ = <T extends Element>(s: string) => app.querySelector(s) as T;
const stage = $<HTMLDivElement>('.pdf-stage');
const sheets = $<HTMLDivElement>('.sheets');
const empty = $<HTMLDivElement>('.empty');
const status = $<HTMLSpanElement>('.status');

function scale(): number {
  return zoom === 'fit' ? Math.max(0.2, (stage.clientWidth - 48) / baseWidth) : zoom;
}

function updateZoomLabel(): void {
  $<HTMLButtonElement>('.zoom-label').textContent = zoom === 'fit' ? `Fit (${Math.round(scale() * 100)}%)` : `${Math.round(zoom * 100)}%`;
}

// Pages are rendered lazily when they scroll into view.
const observer = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && void renderPage(e.target as HTMLDivElement)),
  { root: stage, rootMargin: '600px 0px' },
);

async function renderPage(el: HTMLDivElement): Promise<void> {
  const s = scale();
  if (!doc || el.dataset.scale === String(s)) return;
  el.dataset.scale = String(s);
  const page = await doc.getPage(Number(el.dataset.page));
  const viewport = page.getViewport({ scale: s * devicePixelRatio });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
  if (el.dataset.scale === String(s)) el.replaceChildren(canvas);
}

async function layout(): Promise<void> {
  if (!doc) return;
  const first = await doc.getPage(1);
  baseWidth = first.getViewport({ scale: 1 }).width;
  const s = scale();
  const els = [...sheets.children] as HTMLDivElement[];
  for (const el of els) {
    const page = await doc.getPage(Number(el.dataset.page));
    const vp = page.getViewport({ scale: s });
    el.style.width = `${vp.width}px`;
    el.style.height = `${vp.height}px`;
    delete el.dataset.scale;
    observer.unobserve(el);
    observer.observe(el);
  }
  updateZoomLabel();
}

async function show(msg: ShowMsg): Promise<void> {
  current = msg;
  status.classList.remove('hidden');
  const top = stage.scrollTop;
  try {
    const next = await pdfjs.getDocument({ url: `${msg.url}?v=${msg.version}`, isEvalSupported: false }).promise;
    if (current !== msg) return;
    await doc?.destroy();
    doc = next;
    sheets.replaceChildren(
      ...Array.from({ length: doc.numPages }, (_, i) => {
        const el = document.createElement('div');
        el.className = 'sheet';
        el.dataset.page = String(i + 1);
        return el;
      }),
    );
    $<HTMLSpanElement>('.pages').textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
    await layout();
    stage.scrollTop = top;
    empty.classList.add('hidden');
  } catch (e) {
    empty.classList.remove('hidden');
    empty.innerHTML = `<i class="codicon codicon-error"></i><span>Cannot open the PDF: ${String((e as Error).message ?? e)}</span>`;
  } finally {
    status.classList.add('hidden');
  }
}

async function download(): Promise<void> {
  if (!current) return;
  const blob = await (await fetch(`${current.url}?v=${current.version}`)).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = current.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function setZoom(z: number | 'fit'): void {
  zoom = z === 'fit' ? z : Math.min(4, Math.max(0.25, Math.round(z * 100) / 100));
  vscode.setState({ zoom });
  void layout();
}

app.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'zoomIn') setZoom(scale() * 1.2);
  if (act === 'zoomOut') setZoom(scale() / 1.2);
  if (act === 'fit') setZoom('fit');
  if (act === 'download') download().catch(() => vscode.postMessage({ type: 'downloadFailed' }));
  if (act === 'reveal' || act === 'build') vscode.postMessage({ type: act });
});

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  if (zoom !== 'fit') return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void layout(), 150);
}).observe(stage);

window.addEventListener('message', (e) => {
  if (e.data?.type === 'show') void show(e.data as ShowMsg);
});
updateZoomLabel();
vscode.postMessage({ type: 'ready' });
