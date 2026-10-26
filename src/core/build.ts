import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDesign } from './design';
import { buildDocument, printPdf, vendorScripts } from './pdf';
import { designRoots, loadProject, slugify } from './project';
import { renderReport, type RenderResult } from './render';
import type { Design, Issue, Project, ReadFile } from './types';
import { validateProject } from './validate';

export interface BuildOptions {
  projectDir: string;
  extensionRoot: string;
  format: 'pdf' | 'html';
  outDir?: string;
  designsPath?: string;
  chromePath?: string;
  read: ReadFile;
  log?: (s: string) => void;
}

export interface BuildOutput {
  file: string;
  issues: Issue[];
  project: Project;
  design: Design;
  result: RenderResult;
}

export function outputName(project: Project): string {
  const base = [project.report.client, project.report.title].filter(Boolean).join(' ') || 'report';
  return slugify(String(base));
}

export async function build(opts: BuildOptions): Promise<BuildOutput> {
  const t0 = Date.now();
  const project = loadProject(opts.projectDir, opts.read);
  const design = loadDesign(designRoots(project.dir, join(opts.extensionRoot, 'designs'), opts.designsPath), project.designId, opts.read);
  opts.log?.(`Design: ${design.name} (${design.id}) · ${design.collections.map((c) => `${project.items[c.id]?.length ?? 0} ${c.label.toLowerCase()}`).join(', ') || 'no collections'}`);
  const result = renderReport(project, design, { read: opts.read, assetUrl: (p) => pathToFileURL(p).href });
  const issues = [...validateProject(project, design, opts.read), ...result.issues];
  const outDir = join(project.dir, opts.outDir ?? 'out');
  const file = join(outDir, `${outputName(project)}.${opts.format}`);
  const html = buildDocument(result, vendorScripts(opts.extensionRoot), { lang: String(project.report.language ?? 'en'), paged: opts.format === 'pdf' });
  if (opts.format === 'html') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  } else {
    await printPdf(html, file, { chromePath: opts.chromePath, log: opts.log });
  }
  opts.log?.(`Wrote ${file} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { file, issues, project, design, result };
}
