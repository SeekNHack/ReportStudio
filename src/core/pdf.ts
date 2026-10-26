import { type Dirent, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RenderResult } from './render';

export interface VendorScripts {
  pagedPolyfill: string;
  mermaid: string;
}

export function vendorScripts(extensionRoot: string): VendorScripts {
  return {
    pagedPolyfill: join(extensionRoot, 'media', 'vendor', 'paged.polyfill.js'),
    mermaid: join(extensionRoot, 'media', 'vendor', 'mermaid.min.js'),
  };
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** Full standalone HTML document; Paged.js paginates it when loaded. */
export function buildDocument(result: RenderResult, vendor: VendorScripts, opts: { lang?: string; paged?: boolean } = {}): string {
  const paged = opts.paged !== false;
  const hasMermaid = result.body.includes('class="mermaid"');
  return `<!doctype html>
<html lang="${escAttr(opts.lang ?? 'en')}">
<head>
<meta charset="utf-8">
<title>${escAttr(result.title)}</title>
<style>
${result.css}
</style>
<script>
window.PagedConfig = {
  auto: ${paged},
  before: async function () {
    if (window.mermaid) {
      window.mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
      try { await window.mermaid.run({ querySelector: 'pre.mermaid' }); } catch (e) { console.error(e); }
    }
  },
  after: function () { window.__reportReady = true; }
};
</script>
${hasMermaid ? `<script src="${pathToFileURL(vendor.mermaid).href}"></script>` : ''}
${paged ? `<script src="${pathToFileURL(vendor.pagedPolyfill).href}"></script>` : ''}
</head>
<body>
${result.body}
</body>
</html>
`;
}

export function findChrome(configured?: string): string | undefined {
  if (configured && existsSync(configured)) return configured;
  const env = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env && existsSync(env)) return env;
  const candidates: string[] =
    process.platform === 'win32'
      ? [
          ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((v) => {
            const base = process.env[v];
            return base
              ? [
                  join(base, 'Google/Chrome/Application/chrome.exe'),
                  join(base, 'Microsoft/Edge/Application/msedge.exe'),
                  join(base, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
                  join(base, 'Chromium/Application/chrome.exe'),
                ]
              : [];
          }),
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/microsoft-edge',
            '/usr/bin/brave-browser',
            '/opt/google/chrome/chrome',
          ];
  return candidates.find((c) => existsSync(c)) ?? findCachedChrome();
}

/** Browsers downloaded by Playwright / Puppeteer, common on headless servers (code-server, CI). */
function findCachedChrome(): string | undefined {
  const exe = process.platform === 'win32' ? ['chrome.exe', 'chrome-headless-shell.exe'] : process.platform === 'darwin' ? [] : ['chrome', 'chrome-headless-shell'];
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache/ms-playwright'), join(homedir(), '.cache/puppeteer')].filter(Boolean) as string[];
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && exe.includes(e.name)) found.push(p);
      else if (e.isDirectory() && depth > 0) walk(p, depth - 1);
    }
  };
  caches.forEach((c) => walk(c, 4));
  // Prefer the full browser over the headless shell, newest version first.
  return found.sort((a, b) => Number(a.includes('headless')) - Number(b.includes('headless')) || b.localeCompare(a, undefined, { numeric: true }))[0];
}

export class ChromeNotFoundError extends Error {
  constructor() {
    super('No Chrome, Chromium, Edge or Brave installation found. Install one or set "reportStudio.chromePath".');
  }
}

/**
 * Writes `<outFile>.html` next to the PDF (so relative file:// assets load),
 * lets Paged.js paginate it in headless Chrome and prints it.
 */
export async function printPdf(html: string, outFile: string, opts: { chromePath?: string; timeoutMs?: number; log?: (s: string) => void } = {}): Promise<void> {
  const executablePath = findChrome(opts.chromePath);
  if (!executablePath) throw new ChromeNotFoundError();
  mkdirSync(dirname(outFile), { recursive: true });
  const htmlFile = outFile.replace(/\.pdf$/i, '') + '.html';
  writeFileSync(htmlFile, html);
  const puppeteer = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warn') opts.log?.(`[chrome] ${m.text()}`);
    });
    // An uncaught error before pagination ends means Paged.js will never finish: fail fast.
    let failed: (e: Error) => void = () => undefined;
    const pageError = new Promise<never>((_, reject) => (failed = reject));
    pageError.catch(() => undefined);
    page.on('pageerror', (e) => {
      opts.log?.(`[chrome] ${(e as Error).message}`);
      failed(new Error(`The report page failed while paginating: ${(e as Error).message}`));
    });
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load', timeout: opts.timeoutMs ?? 120_000 });
    await Promise.race([page.waitForFunction('window.__reportReady === true', { timeout: opts.timeoutMs ?? 120_000 }), pageError]);
    await page.pdf({ path: outFile, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  } finally {
    await browser.close();
  }
}
