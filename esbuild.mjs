import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

// Stale source maps from dev builds would end up in the .vsix.
if (production) rmSync('dist', { recursive: true, force: true });

// Third-party browser bundles used by the preview webview and by the PDF renderer.
mkdirSync('media/vendor', { recursive: true });
cpSync('node_modules/pagedjs/dist/paged.js', 'media/vendor/paged.js');
cpSync('node_modules/pagedjs/dist/paged.polyfill.js', 'media/vendor/paged.polyfill.js');
cpSync('node_modules/mermaid/dist/mermaid.min.js', 'media/vendor/mermaid.min.js');
cpSync('node_modules/@vscode/codicons/dist/codicon.css', 'media/vendor/codicon.css');
cpSync('node_modules/@vscode/codicons/dist/codicon.ttf', 'media/vendor/codicon.ttf');

const builds = [
  {
    ...common,
    entryPoints: { extension: 'src/extension/extension.ts', cli: 'src/cli.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'chokidar', 'fsevents'],
  },
  {
    ...common,
    entryPoints: { form: 'webview/form/main.tsx', preview: 'webview/preview/main.ts', design: 'webview/design/main.tsx', pdf: 'webview/pdf/main.ts' },
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'css' },
  },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
