import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Annotated screenshots: `assets/x.png` annotated becomes `assets/x.annotated.png`
 * (what the report shows) plus `assets/x.annotated.json` (original path and
 * shapes), so the annotations can be edited again later.
 */

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };

export interface AnnotationSidecar {
  version: 1;
  source: string;
  shapes: unknown[];
  crop?: unknown;
}

const toPosix = (p: string) => p.split('\\').join('/');

/** Absolute path of a project relative image, refusing paths outside the project. */
export function resolveInProject(base: string, path: string): string | undefined {
  if (!path || /^[a-z][\w+.-]*:/i.test(path)) return undefined;
  const abs = resolve(base, isAbsolute(path) ? relative(base, path) : decodeURI(path));
  return relative(base, abs).startsWith('..') ? undefined : abs;
}

export function sidecarOf(abs: string): string {
  return abs.replace(/\.annotated\.png$/i, '.annotated.json');
}

/** Image to edit: the original behind an annotated image, with its shapes. */
export function readForAnnotation(base: string, path: string): { data?: string; source?: string; doc?: AnnotationSidecar; error?: string } {
  const abs = resolveInProject(base, path);
  if (!abs || !existsSync(abs)) return { error: `Image not found: ${path}` };
  let source = abs;
  let doc: AnnotationSidecar | undefined;
  const side = sidecarOf(abs);
  if (side !== abs && existsSync(side)) {
    try {
      const d = JSON.parse(readFileSync(side, 'utf8')) as AnnotationSidecar;
      const src = resolveInProject(base, d.source);
      if (src && existsSync(src)) {
        source = src;
        doc = d;
      }
    } catch {
      /* broken sidecar: edit the annotated image itself */
    }
  }
  const mime = MIME[extname(source).toLowerCase()];
  if (!mime) return { error: `Unsupported image type: ${extname(source)}` };
  return { data: `data:${mime};base64,${readFileSync(source).toString('base64')}`, source: toPosix(relative(base, source)), doc };
}

/** Files of the project (Markdown/YAML) that mention a path, except `ignore`. */
function referenced(base: string, rel: string, ignore: string[]): boolean {
  const walk = (dir: string, depth: number): boolean => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'out') continue;
      const p = join(dir, name);
      if (ignore.includes(p)) continue;
      const st = statSync(p);
      if (st.isDirectory()) {
        if (depth < 3 && walk(p, depth + 1)) return true;
      } else if (/\.(md|ya?ml)$/i.test(name) && readFileSync(p, 'utf8').includes(rel)) return true;
    }
    return false;
  };
  return walk(base, 0);
}

/**
 * Saves the flattened PNG next to the original and the sidecar with the shapes.
 * With `keep: false` the original and the sidecar are removed (unless another
 * file still uses the original), e.g. after redacting secrets.
 */
export function saveAnnotation(
  base: string,
  opts: { path: string; source: string; data: string; doc: AnnotationSidecar; keep: boolean; editedFile?: string },
): { path?: string; error?: string } {
  const current = resolveInProject(base, opts.path);
  const source = resolveInProject(base, opts.source);
  if (!current || !source) return { error: 'The image must be inside the report project.' };
  let out = /\.annotated\.png$/i.test(current) ? current : join(dirname(source), `${basename(source, extname(source))}.annotated.png`);
  // Do not overwrite the annotated version of another image.
  for (let i = 2; out !== current && existsSync(out); i++) {
    const side = sidecarOf(out);
    try {
      if (existsSync(side) && resolveInProject(base, (JSON.parse(readFileSync(side, 'utf8')) as AnnotationSidecar).source) === source) break;
    } catch {
      /* not ours */
    }
    out = join(dirname(source), `${basename(source, extname(source))}-${i}.annotated.png`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(opts.data, 'base64'));
  const side = sidecarOf(out);
  if (opts.keep) writeFileSync(side, JSON.stringify({ ...opts.doc, version: 1, source: toPosix(relative(base, source)) }, null, 2) + '\n');
  else {
    rmSync(side, { force: true });
    const rel = toPosix(relative(base, source));
    if (source !== out && !referenced(base, rel, opts.editedFile ? [opts.editedFile] : [])) rmSync(source, { force: true });
  }
  return { path: toPosix(relative(base, out)) };
}
