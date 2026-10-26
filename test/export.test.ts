import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDesign } from '../src/core/design';
import { exportData, toCsv, toSarif, toXlsx } from '../src/core/export';
import { defaultRead, designRoots, loadProject } from '../src/core/project';

const root = join(__dirname, '..');
const demo = join(root, 'examples/demo-engagement');
const project = loadProject(demo);
const design = loadDesign(designRoots(demo, join(root, 'designs')), project.designId, defaultRead);

describe('data exports', () => {
  const data = exportData(project, design, new Date('2026-10-26T10:00:00Z'));
  const findings = data.collections.find((c) => c.id === 'findings')!;

  it('collects items with number, severity and resolved placeholders', () => {
    expect(findings.items.length).toBe(project.findings.length);
    expect(findings.items[0].number).toBe('F-01');
    expect(findings.items[0].severity).toBe('critical');
    const text = JSON.stringify(data);
    expect(text).not.toContain('{{ report.');
    expect(data.report.client).toBe('ACME Corp');
  });

  it('writes CSV with a header and quoted multi-line cells', () => {
    const csv = toCsv(data, design, 'findings');
    expect(csv.startsWith('﻿#,ID,Title,Severity,Score')).toBe(true);
    expect(csv.split('\r\n')[1]).toMatch(/^F-01,/);
    expect(csv).toMatch(/"[^"]*\n[^"]*"/);
  });

  it('writes an xlsx package', () => {
    const buf = toXlsx(data, design);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    if (process.env.XLSX_OUT) writeFileSync(process.env.XLSX_OUT, buf);
  });

  it('writes SARIF with rules, levels and pass results for solved findings', () => {
    const log = JSON.parse(toSarif(data));
    expect(log.version).toBe('2.1.0');
    const run = log.runs[0];
    expect(run.tool.driver.rules.length).toBe(findings.items.length);
    const open = findings.items.findIndex((i) => !i.resolved && i.severity === 'high');
    expect(run.results[open].level).toBe('error');
    expect(run.results[findings.items.findIndex((i) => i.resolved)].level).toBe('none');
    const solved = findings.items.filter((i) => i.resolved).length;
    expect(run.results.filter((r: { kind: string }) => r.kind === 'pass').length).toBe(solved);
    expect(run.results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('https://shop.acme.example/api/v2/auth/login');
  });
});
