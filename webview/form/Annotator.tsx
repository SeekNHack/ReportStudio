import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { request } from '../shared/vscode';

/**
 * Screenshot annotation editor: boxes, arrows, highlighter, redaction
 * (solid or pixelated), text, numbered steps and crop.
 *
 * The original image is kept and the annotations are saved next to the
 * output (`foo.annotated.png` + `foo.annotated.json`), so they stay editable.
 * Shapes use image pixel coordinates.
 */

type Tool = 'select' | 'rect' | 'ellipse' | 'arrow' | 'highlight' | 'redact' | 'text' | 'step' | 'crop';

type Box = { x: number; y: number; w: number; h: number };
export type Shape =
  | ({ t: 'rect' | 'ellipse'; c: string; s: number } & Box)
  | ({ t: 'highlight'; c: string } & Box)
  | ({ t: 'redact'; mode: 'box' | 'pixelate' } & Box)
  | { t: 'arrow'; x1: number; y1: number; x2: number; y2: number; c: string; s: number }
  | { t: 'text'; x: number; y: number; text: string; c: string; size: number }
  | { t: 'step'; x: number; y: number; n: number; c: string; size: number };

export interface AnnotationDoc {
  version: 1;
  source: string;
  shapes: Shape[];
  crop?: Box;
}

const COLORS = ['#e5383b', '#ff8800', '#ffd60a', '#2dc653', '#3a86ff', '#111111', '#ffffff'];
const HIGHLIGHT = ['#ffd60a', '#2dc653', '#3a86ff', '#ff4fa3'];

const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: 'select', icon: 'move', label: 'Select and move', key: 'v' },
  { id: 'rect', icon: 'primitive-square', label: 'Box', key: 'r' },
  { id: 'ellipse', icon: 'circle-large', label: 'Ellipse', key: 'e' },
  { id: 'arrow', icon: 'arrow-up', label: 'Arrow', key: 'a' },
  { id: 'highlight', icon: 'symbol-color', label: 'Highlighter', key: 'h' },
  { id: 'redact', icon: 'eye-closed', label: 'Redact (hide secrets)', key: 'b' },
  { id: 'text', icon: 'text-size', label: 'Text', key: 't' },
  { id: 'step', icon: 'symbol-numeric', label: 'Numbered step', key: 'n' },
  { id: 'crop', icon: 'screen-normal', label: 'Crop', key: 'c' },
];

function normBox(b: Box): Box {
  return { x: Math.min(b.x, b.x + b.w), y: Math.min(b.y, b.y + b.h), w: Math.abs(b.w), h: Math.abs(b.h) };
}

function bounds(s: Shape, ctx?: CanvasRenderingContext2D): Box {
  switch (s.t) {
    case 'arrow':
      return normBox({ x: s.x1, y: s.y1, w: s.x2 - s.x1, h: s.y2 - s.y1 });
    case 'text': {
      const lines = s.text.split('\n');
      let w = s.size * 0.6 * Math.max(...lines.map((l) => l.length));
      if (ctx) {
        ctx.font = `600 ${s.size}px system-ui, sans-serif`;
        w = Math.max(...lines.map((l) => ctx.measureText(l).width));
      }
      return { x: s.x, y: s.y, w, h: s.size * 1.25 * lines.length };
    }
    case 'step':
      return { x: s.x - s.size, y: s.y - s.size, w: s.size * 2, h: s.size * 2 };
    default:
      return normBox(s);
  }
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hit(s: Shape, x: number, y: number, tol: number, ctx: CanvasRenderingContext2D): boolean {
  if (s.t === 'arrow') return distToSegment(x, y, s.x1, s.y1, s.x2, s.y2) <= tol + s.s;
  const b = bounds(s, ctx);
  if (s.t === 'rect' || s.t === 'ellipse') {
    const inside = x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
    const inner = x > b.x + tol + s.s && x < b.x + b.w - tol - s.s && y > b.y + tol + s.s && y < b.y + b.h - tol - s.s;
    return inside && !inner;
  }
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}

function moved(s: Shape, dx: number, dy: number): Shape {
  if (s.t === 'arrow') return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
  return { ...s, x: s.x + dx, y: s.y + dy } as Shape;
}

/** Draws the image scaled to width × height, then the shapes. */
export function paint(ctx: CanvasRenderingContext2D, img: CanvasImageSource, width: number, height: number, shapes: Shape[]): void {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  let base: CanvasImageSource = img;
  if (shapes.some((s) => s.t === 'redact' && s.mode === 'pixelate')) {
    // Pixelation samples the untouched image at canvas size.
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d')!.drawImage(img, 0, 0, width, height);
    base = c;
  }
  for (const s of shapes) drawShape(ctx, base, s, width);
}

function drawShape(ctx: CanvasRenderingContext2D, img: CanvasImageSource, s: Shape, imgWidth: number): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (s.t) {
    case 'rect': {
      const b = normBox(s);
      ctx.strokeStyle = s.c;
      ctx.lineWidth = s.s;
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = s.s;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      break;
    }
    case 'ellipse': {
      const b = normBox(s);
      ctx.strokeStyle = s.c;
      ctx.lineWidth = s.s;
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = s.s;
      ctx.beginPath();
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'highlight': {
      const b = normBox(s);
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = s.c;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      break;
    }
    case 'redact': {
      const b = normBox(s);
      if (b.w < 1 || b.h < 1) break;
      if (s.mode === 'box') {
        ctx.fillStyle = '#000';
        ctx.fillRect(b.x, b.y, b.w, b.h);
      } else {
        // Pixelate from the original pixels: big blocks, no smoothing.
        const block = Math.max(10, Math.round(imgWidth / 90));
        const tw = Math.max(1, Math.round(b.w / block));
        const th = Math.max(1, Math.round(b.h / block));
        const tmp = document.createElement('canvas');
        tmp.width = tw;
        tmp.height = th;
        const tctx = tmp.getContext('2d')!;
        tctx.drawImage(img, b.x, b.y, b.w, b.h, 0, 0, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, tw, th, b.x, b.y, b.w, b.h);
      }
      break;
    }
    case 'arrow': {
      const head = s.s * 3.2 + 8;
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      ctx.strokeStyle = s.c;
      ctx.fillStyle = s.c;
      ctx.lineWidth = s.s;
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = s.s;
      const bx = s.x2 - Math.cos(ang) * Math.min(head * 0.8, len);
      const by = s.y2 - Math.sin(ang) * Math.min(head * 0.8, len);
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(ang - 0.45), s.y2 - head * Math.sin(ang - 0.45));
      ctx.lineTo(s.x2 - head * Math.cos(ang + 0.45), s.y2 - head * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'text': {
      ctx.font = `600 ${s.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'top';
      const light = isLight(s.c);
      ctx.lineWidth = Math.max(2, s.size / 5);
      ctx.strokeStyle = light ? 'rgba(0,0,0,.85)' : 'rgba(255,255,255,.95)';
      ctx.fillStyle = s.c;
      s.text.split('\n').forEach((line, i) => {
        const y = s.y + i * s.size * 1.25;
        ctx.strokeText(line, s.x, y);
        ctx.fillText(line, s.x, y);
      });
      break;
    }
    case 'step': {
      ctx.fillStyle = s.c;
      ctx.shadowColor = 'rgba(0,0,0,.4)';
      ctx.shadowBlur = s.size / 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(2, s.size / 7);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = isLight(s.c) ? '#111' : '#fff';
      ctx.font = `700 ${Math.round(s.size * 1.1)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(s.n), s.x, s.y + s.size * 0.05);
      break;
    }
  }
  ctx.restore();
}

function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.62;
}

interface State {
  shapes: Shape[];
  crop?: Box;
}

export interface AnnotatorProps {
  /** project relative path of the image as stored in the field */
  path: string;
  onClose: () => void;
  /** called with the path of the saved (annotated) image */
  onSaved: (path: string) => void;
}

export function Annotator(props: AnnotatorProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<HTMLImageElement>();
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState(COLORS[0]);
  const [hl, setHl] = useState(HIGHLIGHT[0]);
  const [weight, setWeight] = useState(1);
  const [redactMode, setRedactMode] = useState<'box' | 'pixelate'>('box');
  const [state, setState] = useState<State>({ shapes: [] });
  const [history, setHistory] = useState<State[]>([]);
  const [future, setFuture] = useState<State[]>([]);
  const [selected, setSelected] = useState<number>(-1);
  const [draft, setDraft] = useState<Shape | Box | undefined>();
  const [editing, setEditing] = useState<{ x: number; y: number; index?: number; text: string }>();
  const [keep, setKeep] = useState(true);
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: boolean; origin?: Shape } | undefined>(undefined);

  useEffect(() => {
    void request<{ data?: string; source?: string; doc?: AnnotationDoc; error?: string }>({ type: 'readImage', path: props.path }).then((r) => {
      if (!r.data) return setError(r.error ?? 'Cannot read the image.');
      const image = new Image();
      image.onload = () => {
        setImg(image);
        setSource(r.source ?? props.path);
        if (r.doc) setState({ shapes: r.doc.shapes ?? [], crop: r.doc.crop });
      };
      image.onerror = () => setError('The image format is not supported by the editor.');
      image.src = r.data;
    });
  }, [props.path]);

  // Vector images are rasterised at twice their size so they stay sharp in the PDF.
  const k = /\.svg$/i.test(source) ? 2 : 1;
  const W = Math.round((img?.naturalWidth || img?.width || 1) * k);
  const H = Math.round((img?.naturalHeight || img?.height || 1) * k);
  const [fit, setFit] = useState<{ w: number; h: number }>();
  useEffect(() => {
    const el = wrap.current;
    if (!el || !img) return;
    const update = () => {
      const s = Math.min((el.clientWidth - 32) / W, (el.clientHeight - 32) / H, 4 / k);
      setFit({ w: Math.max(1, Math.floor(W * s)), h: Math.max(1, Math.floor(H * s)) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [img, W, H]);
  const base = Math.max(2, Math.round(W / 380));
  const stroke = base * [1, 2, 3.2][weight];
  const textSize = Math.max(14, Math.round(W / 48)) * [0.8, 1, 1.4][weight];
  const stepSize = Math.max(11, Math.round(W / 70)) * [0.8, 1, 1.3][weight];

  const commit = (next: State) => {
    setHistory((h) => [...h.slice(-80), state]);
    setFuture([]);
    setState(next);
  };
  const undo = () => {
    if (!history.length) return;
    setFuture((f) => [state, ...f]);
    setState(history[history.length - 1]);
    setHistory((h) => h.slice(0, -1));
    setSelected(-1);
  };
  const redo = () => {
    if (!future.length) return;
    setHistory((h) => [...h, state]);
    setState(future[0]);
    setFuture((f) => f.slice(1));
  };

  // Repaint.
  useLayoutEffect(() => {
    const cv = canvas.current;
    if (!cv || !img) return;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d')!;
    const shapes = draft && 't' in draft ? [...state.shapes, draft] : state.shapes;
    paint(ctx, img, W, H, shapes);
    if (selected >= 0 && state.shapes[selected]) {
      const b = bounds(state.shapes[selected], ctx);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = Math.max(1, base / 2);
      ctx.strokeStyle = '#3a86ff';
      const pad = base * 2;
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.restore();
    }
    const crop = draft && !('t' in draft) ? normBox(draft) : state.crop;
    if (crop) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(crop.x, crop.y, crop.w, crop.h);
      ctx.fill('evenodd');
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, base / 2);
      ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
      ctx.restore();
    }
  });

  const point = (e: PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };
  const toClient = (x: number, y: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const wr = wrap.current!.getBoundingClientRect();
    return { left: r.left - wr.left + wrap.current!.scrollLeft + (x * r.width) / W, top: r.top - wr.top + wrap.current!.scrollTop + (y * r.height) / H, scale: r.width / W };
  };

  const nextStep = () => Math.max(0, ...state.shapes.filter((s) => s.t === 'step').map((s) => (s as { n: number }).n)) + 1;

  const onDown = (e: PointerEvent) => {
    if (!img || editing) return;
    const p = point(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === 'select') {
      const ctx = canvas.current!.getContext('2d')!;
      const tol = base * 3;
      const i = [...state.shapes].reverse().findIndex((s) => hit(s, p.x, p.y, tol, ctx));
      const idx = i < 0 ? -1 : state.shapes.length - 1 - i;
      setSelected(idx);
      if (idx >= 0) drag.current = { ...p, moved: false, origin: state.shapes[idx] };
      return;
    }
    if (tool === 'text') {
      // Opened on pointer up, otherwise the click that follows takes the focus away.
      drag.current = { ...p, moved: false };
      return;
    }
    if (tool === 'step') {
      commit({ ...state, shapes: [...state.shapes, { t: 'step', x: p.x, y: p.y, n: nextStep(), c: color, size: stepSize }] });
      return;
    }
    drag.current = { ...p, moved: false };
    setSelected(-1);
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    d.moved = d.moved || Math.hypot(p.x - d.x, p.y - d.y) > 2;
    if (tool === 'select' && d.origin && selected >= 0) {
      const shapes = [...state.shapes];
      shapes[selected] = moved(d.origin, p.x - d.x, p.y - d.y);
      setState({ ...state, shapes });
      return;
    }
    const box = { x: d.x, y: d.y, w: p.x - d.x, h: p.y - d.y };
    if (tool === 'crop') setDraft(box);
    else if (tool === 'rect' || tool === 'ellipse') setDraft({ t: tool, ...box, c: color, s: stroke });
    else if (tool === 'highlight') setDraft({ t: 'highlight', ...box, c: hl });
    else if (tool === 'redact') setDraft({ t: 'redact', ...box, mode: redactMode });
    else if (tool === 'arrow') setDraft({ t: 'arrow', x1: d.x, y1: d.y, x2: p.x, y2: p.y, c: color, s: stroke });
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (!d) return;
    if (tool === 'text') {
      setEditing({ x: d.x, y: d.y, text: '' });
      return;
    }
    if (tool === 'select') {
      if (d.moved && d.origin) {
        // Record the move as one history step.
        setHistory((h) => [...h, { ...state, shapes: state.shapes.map((s, i) => (i === selected ? d.origin! : s)) }]);
        setFuture([]);
      }
      return;
    }
    const shape = draft;
    setDraft(undefined);
    if (!shape || !d.moved) return;
    if (!('t' in shape)) {
      const b = normBox(shape);
      if (b.w > 8 && b.h > 8) commit({ ...state, crop: clampBox(b, W, H) });
      return;
    }
    const b = bounds(shape);
    if (b.w < 3 && b.h < 3) return;
    commit({ ...state, shapes: [...state.shapes, shape.t === 'arrow' ? shape : ({ ...shape, ...normBox(shape as Box) } as Shape)] });
  };

  const onDouble = (e: MouseEvent) => {
    if (tool !== 'select' || selected < 0) return;
    const s = state.shapes[selected];
    if (s?.t === 'text') setEditing({ x: s.x, y: s.y, index: selected, text: s.text });
    e.preventDefault();
  };

  const finishText = (cancel = false) => {
    const ed = editing;
    setEditing(undefined);
    if (!ed || cancel) return;
    const text = ed.text.replace(/\s+$/, '');
    if (ed.index !== undefined) {
      const shapes = [...state.shapes];
      if (text) shapes[ed.index] = { ...(shapes[ed.index] as Extract<Shape, { t: 'text' }>), text };
      else shapes.splice(ed.index, 1);
      commit({ ...state, shapes });
    } else if (text) commit({ ...state, shapes: [...state.shapes, { t: 'text', x: ed.x, y: ed.y, text, c: color, size: textSize }] });
  };

  const removeSelected = () => {
    if (selected < 0) return;
    commit({ ...state, shapes: state.shapes.filter((_, i) => i !== selected) });
    setSelected(-1);
  };

  // Change the colour / weight of the selected shape from the toolbar.
  const restyle = (patch: { c?: string; weight?: number }) => {
    if (selected < 0) return;
    const s = state.shapes[selected];
    const shapes = [...state.shapes];
    if (patch.c && 'c' in s) shapes[selected] = { ...s, c: patch.c } as Shape;
    if (patch.weight !== undefined) {
      const f = [1, 2, 3.2][patch.weight];
      if ('s' in s) shapes[selected] = { ...(shapes[selected] as typeof s), s: base * f } as Shape;
      if (s.t === 'text') shapes[selected] = { ...(shapes[selected] as typeof s), size: Math.max(14, Math.round(W / 48)) * [0.8, 1, 1.4][patch.weight] };
      if (s.t === 'step') shapes[selected] = { ...(shapes[selected] as typeof s), size: Math.max(11, Math.round(W / 70)) * [0.8, 1, 1.3][patch.weight] };
    }
    commit({ ...state, shapes });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') return e.preventDefault(), e.shiftKey ? redo() : undo();
      if (mod && e.key.toLowerCase() === 'y') return e.preventDefault(), redo();
      if (mod && e.key.toLowerCase() === 's') return e.preventDefault(), void save();
      if (e.key === 'Escape') return e.preventDefault(), selected >= 0 ? setSelected(-1) : props.onClose();
      if (e.key === 'Delete' || e.key === 'Backspace') return e.preventDefault(), removeSelected();
      if (mod || e.altKey) return;
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) setTool(t.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const save = async () => {
    if (!img || saving) return;
    setSaving(true);
    const out = document.createElement('canvas');
    const crop = state.crop ? clampBox(state.crop, W, H) : { x: 0, y: 0, w: W, h: H };
    out.width = Math.round(crop.w);
    out.height = Math.round(crop.h);
    const ctx = out.getContext('2d')!;
    const full = document.createElement('canvas');
    full.width = W;
    full.height = H;
    paint(full.getContext('2d')!, img, W, H, state.shapes);
    ctx.drawImage(full, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
    const data = out.toDataURL('image/png').split(',')[1];
    const doc: AnnotationDoc = { version: 1, source, shapes: state.shapes, crop: state.crop };
    const r = await request<{ path?: string; error?: string }>({ type: 'saveAnnotated', path: props.path, source, data, doc, keep });
    setSaving(false);
    if (r.path) props.onSaved(r.path);
    else setError(r.error ?? 'Saving failed.');
  };

  const sel = selected >= 0 ? state.shapes[selected] : undefined;
  const showColors = tool !== 'redact' && tool !== 'crop' && tool !== 'highlight' && !(tool === 'select' && (!sel || !('c' in sel) || sel.t === 'highlight'));
  const showWeight = ['rect', 'ellipse', 'arrow', 'text', 'step'].includes(tool) || (tool === 'select' && sel && sel.t !== 'redact' && sel.t !== 'highlight');
  const edPos = editing && canvas.current && wrap.current ? toClient(editing.x, editing.y) : undefined;
  const hasRedaction = state.shapes.some((s) => s.t === 'redact');

  return (
    <div class="annotator" role="dialog" aria-label="Annotate screenshot">
      <div class="annotator-bar">
        <div class="tool-group">
          {TOOLS.map((t) => (
            <button class={`icon-btn ${tool === t.id ? 'active' : ''}`} title={`${t.label} (${t.key.toUpperCase()})`} onClick={() => (setTool(t.id), t.id !== 'select' && setSelected(-1))}>
              <i class={`codicon codicon-${t.icon}`} style={t.id === 'arrow' ? 'transform: rotate(45deg)' : undefined} />
            </button>
          ))}
        </div>
        <span class="sep" />
        {showColors && (
          <div class="tool-group">
            {COLORS.map((c) => (
              <button class={`swatch ${color === c ? 'on' : ''}`} style={`--c: ${c}`} title={c} onClick={() => (setColor(c), restyle({ c }))} />
            ))}
          </div>
        )}
        {(tool === 'highlight' || sel?.t === 'highlight') && (
          <div class="tool-group">
            {HIGHLIGHT.map((c) => (
              <button class={`swatch ${hl === c ? 'on' : ''}`} style={`--c: ${c}`} title={c} onClick={() => (setHl(c), restyle({ c }))} />
            ))}
          </div>
        )}
        {showWeight && (
          <div class="segmented slim">
            {['S', 'M', 'L'].map((l, i) => (
              <button class={weight === i ? 'on' : ''} onClick={() => (setWeight(i), restyle({ weight: i }))}>
                {l}
              </button>
            ))}
          </div>
        )}
        {tool === 'redact' && (
          <div class="segmented slim">
            <button class={redactMode === 'box' ? 'on' : ''} onClick={() => setRedactMode('box')} title="Solid black box — safest">
              Black box
            </button>
            <button class={redactMode === 'pixelate' ? 'on' : ''} onClick={() => setRedactMode('pixelate')} title="Pixelated">
              Pixelate
            </button>
          </div>
        )}
        {tool === 'crop' && state.crop && (
          <button class="btn ghost" onClick={() => commit({ ...state, crop: undefined })}>
            <i class="codicon codicon-discard" /> Reset crop
          </button>
        )}
        {tool === 'select' && sel && (
          <button class="btn ghost" onClick={removeSelected} title="Delete (Del)">
            <i class="codicon codicon-trash" /> Delete
          </button>
        )}
        <span class="spacer" />
        <button class="icon-btn" title="Undo (Ctrl+Z)" disabled={!history.length} onClick={undo}>
          <i class="codicon codicon-discard" />
        </button>
        <button class="icon-btn" title="Redo (Ctrl+Y)" disabled={!future.length} onClick={redo}>
          <i class="codicon codicon-redo" />
        </button>
        <button class="btn ghost" title="Remove every annotation" disabled={!state.shapes.length && !state.crop} onClick={() => commit({ shapes: [] })}>
          Clear
        </button>
        <span class="sep" />
        <label class="keep" title="Keeps the original image and the annotations so you can change them later. Turn off to remove the original (recommended when you redacted secrets).">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep((e.target as HTMLInputElement).checked)} /> Keep original
        </label>
        <button class="btn ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button class="btn primary" disabled={!img || saving} onClick={() => void save()} title="Save (Ctrl+S)">
          <i class={`codicon codicon-${saving ? 'loading codicon-modifier-spin' : 'check'}`} /> Save
        </button>
      </div>
      {hasRedaction && keep && (
        <div class="annotator-note">
          <i class="codicon codicon-shield" /> The PDF only contains the redacted image, but the original stays in <code>{source}</code>. Untick “Keep original” to delete it.
        </div>
      )}
      <div class="annotator-canvas" ref={wrap}>
        {error && (
          <div class="banner error">
            <i class="codicon codicon-error" /> {error}
          </div>
        )}
        {!img && !error && <div class="muted">Loading image…</div>}
        <canvas
          ref={canvas}
          class={`tool-${tool}`}
          style={img ? (fit ? `width:${fit.w}px;height:${fit.h}px` : undefined) : 'display:none'}
          onPointerDown={onDown as never}
          onPointerMove={onMove as never}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDblClick={onDouble as never}
        />
        {editing && edPos && (
          <textarea
            class="annotator-text"
            ref={(el) => {
              if (el && document.activeElement !== el) setTimeout(() => el.focus(), 0);
            }}
            rows={Math.max(1, editing.text.split('\n').length)}
            style={`left:${edPos.left}px; top:${edPos.top}px; font-size:${Math.max(12, textSize * edPos.scale)}px; color:${color}`}
            value={editing.text}
            placeholder="Text"
            onInput={(e) => setEditing({ ...editing, text: (e.target as HTMLTextAreaElement).value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), finishText());
              if (e.key === 'Escape') (e.preventDefault(), finishText(true));
            }}
            onBlur={() => finishText()}
          />
        )}
      </div>
      <div class="annotator-hint muted">
        {tool === 'select'
          ? 'Click a shape to select it, drag to move, double-click text to edit, Del to remove.'
          : tool === 'text'
            ? 'Click where the text should start. Enter to confirm, Shift+Enter for a new line.'
            : tool === 'step'
              ? 'Click to place numbered markers (1, 2, 3…) and refer to them in the caption.'
              : tool === 'crop'
                ? 'Drag to choose the area to keep.'
                : tool === 'redact'
                  ? 'Drag over passwords, tokens or personal data. Black box is irreversible in the saved image.'
                  : 'Drag on the image. Ctrl+Z undo · V select · Esc close'}
      </div>
    </div>
  );
}

function clampBox(b: Box, W: number, H: number): Box {
  const x = Math.max(0, Math.min(W, b.x));
  const y = Math.max(0, Math.min(H, b.y));
  return { x, y, w: Math.max(1, Math.min(W - x, b.w)), h: Math.max(1, Math.min(H - y, b.h)) };
}
