import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { listDesigns, loadDesign } from '../src/core/design';
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
