import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { listDesigns, loadDesign } from '../src/core/design';
import { applyDesignOp } from '../src/core/designEdit';
import { defaultLayout, normalizeLayout, supportsLayout, templatePartials } from '../src/core/layout';
import { defaultRead, designRoots, loadProject, scaffoldProject } from '../src/core/project';
import { renderReport } from '../src/core/render';
import { sampleProject } from '../src/core/sample';

const builtin = join(__dirname, '..', 'designs');
const shot = join(__dirname, '..', 'media', 'sample-screenshot.svg');

describe('template preview with sample data', () => {
  for (const { id } of listDesigns([builtin])) {
    it(`renders ${id}`, () => {
      const design = loadDesign([builtin], id, defaultRead);
      const project = sampleProject(design, design.dir, shot);
      const r = renderReport(project, design, { read: defaultRead, assetUrl: (p) => pathToFileURL(p).href });
      expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
      for (const c of design.collections) expect(r.body).toContain(`${c.itemLabel} 1`);
    });
  }

  it('gives findings different severities through CVSS', () => {
    const design = loadDesign([builtin], 'pentest', defaultRead);
    const findings = sampleProject(design, design.dir).items.findings;
    expect(findings.map((f) => f.values.severity)).toEqual([undefined, undefined, undefined]);
    expect(new Set(findings.map((f) => f.values.cvss)).size).toBe(3);
  });
});

describe('engagements and workspace templates', () => {
  it('finds templates in the designs/ folder of a parent folder', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(ws, 'designs', 'acme'), { recursive: true });
    writeFileSync(join(ws, 'designs', 'acme', 'design.yaml'), 'name: ACME Pentest\nextends: pentest\nreport_fields:\n  contract: { type: string }\n');
    const dir = join(ws, 'engagements', '2026-10-acme');
    const roots = designRoots(dir, builtin);
    expect(roots).toContain(join(ws, 'designs'));
    const design = loadDesign(roots, 'acme', defaultRead);
    scaffoldProject(dir, design, { client: 'ACME', start_date: '2026-10-01', end_date: '' });
    const report = parse(readFileSync(join(dir, 'report.yaml'), 'utf8'));
    expect(report).toMatchObject({ design: 'acme', client: 'ACME', start_date: '2026-10-01', title: 'Penetration Test Report' });
    expect(report.end_date).toBeUndefined();
    expect(report.report_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const project = loadProject(dir);
    expect(Object.keys(project.items)).toEqual(expect.arrayContaining(['findings']));
    expect(loadDesign(designRoots(dir, builtin), project.designId, defaultRead).reportFields.some((f) => f.id === 'contract')).toBe(true);
  });
});

describe('template theme', () => {
  it('edits design.yaml → theme and resets it', () => {
    let text = 'name: ACME\nextends: pentest # keep\n';
    text = applyDesignOp(text, { op: 'setTheme', key: 'accent', value: '#ff0000' });
    text = applyDesignOp(text, { op: 'setTheme', key: 'logo', value: 'assets/logo.png' });
    expect(parse(text).theme).toEqual({ accent: '#ff0000', logo: 'assets/logo.png' });
    expect(text).toContain('# keep');
    text = applyDesignOp(text, { op: 'setTheme', key: 'accent', value: '' });
    expect(parse(text).theme).toEqual({ logo: 'assets/logo.png' });
    text = applyDesignOp(text, { op: 'setTheme', key: 'logo' });
    expect(parse(text).theme).toBeUndefined();
    text = applyDesignOp(applyDesignOp(text, { op: 'setTheme', key: 'accent', value: '#00f' }), { op: 'setTheme' });
    expect(parse(text).theme).toBeUndefined();
  });

  it('resolves theme images relative to the template folder', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const dir = join(ws, 'designs', 'acme');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(dir, 'design.yaml'), 'name: ACME\nextends: pentest\ntheme:\n  logo: assets/logo.svg\n  accent: "#ff0000"\n');
    const roots = [join(ws, 'designs'), builtin];
    const design = loadDesign(roots, 'acme', defaultRead);
    expect(design.theme.logo).toBe(join(dir, 'assets', 'logo.svg'));
    // Also from an engagement elsewhere, and in the sample preview.
    const r = renderReport(sampleProject(design, join(ws, 'engagements', 'x')), design, { read: defaultRead, assetUrl: (p) => pathToFileURL(p).href });
    expect(r.body).toContain(pathToFileURL(join(dir, 'assets', 'logo.svg')).href);
  });
});

describe('visual layout', () => {
  const headings = (html: string) => [...html.matchAll(/<h([12])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => `${m[1]}:${m[2].replace(/<[^>]+>/g, '').replace(/^[\d.]+\s*/, '').trim()}`);
  for (const { id } of listDesigns([builtin])) {
    it(`default layout of ${id} prints the same chapters as its HTML`, () => {
      const design = loadDesign([builtin], id, defaultRead);
      if (!supportsLayout(design, defaultRead)) return;
      const project = sampleProject(design, design.dir, shot);
      const opts = { read: defaultRead, assetUrl: (p: string) => pathToFileURL(p).href };
      const plain = renderReport(project, design, opts);
      const laid = renderReport(project, { ...design, layout: normalizeLayout(defaultLayout(design, templatePartials(design))) }, opts);
      expect(laid.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(headings(laid.body)).toEqual(headings(plain.body));
    });
  }

  it('moves a field before the findings and adds text with placeholders', () => {
    const design = loadDesign([builtin], 'pentest', defaultRead);
    const project = sampleProject(design, design.dir, shot);
    const layout = normalizeLayout([
      { type: 'cover' },
      { type: 'collection', collection: 'findings', title: 'Vulnerabilities' },
      { type: 'text', title: 'Note', level: 2, body: 'Prepared for **{{ report.client }}**.' },
      { type: 'field', field: 'executive_summary', title: 'Summary' },
    ]);
    const r = renderReport(project, { ...design, layout }, { read: defaultRead, assetUrl: (p) => pathToFileURL(p).href });
    const h = headings(r.body);
    expect(h.indexOf('1:Vulnerabilities')).toBeLessThan(h.indexOf('1:Summary'));
    expect(r.body).toContain('Prepared for <strong>ACME Corp</strong>');
    expect(r.body).not.toContain('Table of Contents');
  });

  it('applies severity colors and heading colors from the theme', () => {
    const design = loadDesign([builtin], 'pentest', defaultRead);
    const project = sampleProject(design, design.dir);
    project.report.theme = { severity_critical: '#000001', h1_color: '#123456' };
    const r = renderReport(project, design, { read: defaultRead, assetUrl: (p) => pathToFileURL(p).href });
    expect(r.body).toContain('#000001');
    expect(r.css).toContain('h1 { color: #123456 !important; }');
  });
});
