import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';
import { isAbsolute, join } from 'node:path';

export interface MarkdownOptions {
  /** directory relative image paths are resolved against */
  baseDir: string;
  /** turns an absolute file path into a URL usable by the renderer */
  assetUrl: (absPath: string) => string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type Markdown = ReturnType<typeof MarkdownIt>;

export function createMarkdown(opts: MarkdownOptions): Markdown {
  const md: Markdown = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
  });

  // ```lang title="exploit.py" caption="Payload used" lines highlight="3,5-7"
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = parseFenceInfo(token.info);
    if (info.lang === 'mermaid') return `<pre class="mermaid">${escapeHtml(token.content)}</pre>\n`;
    return renderCode(token.content, info) + '\n';
  };

  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = String(token.attrGet('src') ?? '');
    if (src && !/^([a-z]+:|\/\/|#)/i.test(src)) {
      const abs = isAbsolute(src) ? src : join(opts.baseDir, decodeURI(src));
      token.attrSet('src', opts.assetUrl(abs));
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  // A paragraph that only contains an image becomes a numbered <figure>.
  md.core.ruler.push('figures', (state) => {
    const t = state.tokens;
    for (let i = 0; i < t.length - 2; i++) {
      if (t[i].type !== 'paragraph_open' || t[i + 2].type !== 'paragraph_close') continue;
      const inline = t[i + 1];
      const children = inline.children ?? [];
      if (children.length !== 1 || children[0].type !== 'image') continue;
      const img = children[0];
      // ![Caption|60%](shot.png) → width 60%
      const sized = /^(.*?)\s*\|\s*(\d+(?:\.\d+)?(?:%|mm|cm|px))\s*$/.exec(img.content);
      if (sized) {
        img.content = sized[1];
        if (img.children?.length) img.children = [Object.assign(new state.Token('text', '', 0), { content: sized[1] })];
        img.attrSet('style', `width:${sized[2]}`);
      }
      const caption = img.attrGet('title') || img.content;
      t[i].type = 'figure_open';
      t[i].tag = 'figure';
      t[i + 2].type = 'figure_close';
      t[i + 2].tag = 'figure';
      inline.meta = { caption };
    }
    return true;
  });
  md.renderer.rules.figure_open = () => '<figure class="figure">';
  md.renderer.rules.figure_close = (tokens, idx) => {
    const caption = tokens[idx - 1].meta?.caption as string | undefined;
    return `${caption ? `<figcaption>${md.utils.escapeHtml(caption)}</figcaption>` : ''}</figure>\n`;
  };

  // Tables get a wrapper class so designs can style them consistently.
  md.renderer.rules.table_open = () => '<table class="md-table">\n';
  return md;
}

export interface CodeOptions {
  lang?: string;
  title?: string;
  caption?: string;
  lines?: boolean;
  /** 1-based line numbers to highlight */
  highlight?: number[];
  /** first line number */
  start?: number;
}

/** Parses the info string of a fence: `lang key="value" flag`. */
export function parseFenceInfo(info: string): CodeOptions {
  const out: CodeOptions = {};
  const lang = /^\s*([^\s{"=]+)(?=\s|$)/.exec(info);
  if (lang && !lang[1].includes('=')) out.lang = lang[1];
  for (const m of info.matchAll(/(\w+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g)) {
    if (m.index === lang?.index && m[1] === out.lang) continue;
    const key = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    if (key === 'title' || key === 'file' || key === 'filename') out.title = value;
    else if (key === 'caption') out.caption = value;
    else if (key === 'lines' || key === 'linenos' || key === 'numbers') out.lines = value === undefined || value !== 'false';
    else if (key === 'start') out.start = Number(value) || 1;
    else if (key === 'highlight' || key === 'hl' || key === 'mark') out.highlight = parseRanges(value ?? '');
  }
  return out;
}

function parseRanges(s: string): number[] {
  return s.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map((x) => Number(x.trim()));
    if (!a) return [];
    return b && b >= a ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
  });
}

/** Splits highlighted HTML into lines, re-opening spans that cross line breaks. */
function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!part) continue;
    if (part === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else {
      if (part.startsWith('<span')) open.push(part);
      else if (part === '</span>') open.pop();
      current += part;
    }
  }
  lines.push(current);
  return lines;
}

/** A highlighted code listing, optionally with file name, caption, line numbers and marked lines. */
export function renderCode(code: string, o: CodeOptions = {}): string {
  const text = code.replace(/\n$/, '');
  let language = o.lang && hljs.getLanguage(o.lang) ? o.lang : undefined;
  let html: string;
  if (language) html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  else if (o.lang === 'auto') {
    const r = hljs.highlightAuto(text);
    html = r.value;
    language = r.language;
  } else html = escapeHtml(text);
  const marked = new Set(o.highlight ?? []);
  const start = o.start ?? 1;
  const body =
    o.lines || marked.size
      ? splitHtmlLines(html)
          .map((l, i) => `<span class="line${marked.has(i + 1) ? ' marked' : ''}"${o.lines ? ` data-n="${start + i}"` : ''}>${l || ' '}</span>`)
          .join('')
      : html;
  const pre = `<pre class="code hljs${language ? ` language-${language}` : ''}${o.lines ? ' numbered' : ''}${marked.size ? ' has-marks' : ''}"><code>${body}</code></pre>`;
  if (!o.title && !o.caption) return pre;
  return `<figure class="listing">${o.title ? `<div class="code-title">${escapeHtml(o.title)}</div>` : ''}${pre}${o.caption ? `<figcaption>${escapeHtml(o.caption)}</figcaption>` : ''}</figure>`;
}

/**
 * Hides fenced and inline code before placeholder rendering, so payloads like
 * `{{7*7}}` inside code are never evaluated.
 */
export function protectCode(src: string): { text: string; restore: (s: string) => string } {
  const saved: string[] = [];
  const hold = (m: string) => `\u0000${saved.push(m) - 1}\u0000`;
  const text = src
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, hold)
    .replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, hold);
  return { text, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => saved[Number(i)]) };
}
