import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { convertProject, convertValue, describePlan, matchOption, suggestMapping } from '../src/core/convert';
import { loadDesign } from '../src/core/design';
import { findingValues, parseFinding } from '../src/core/findingFile';
import { defaultRead, loadProject } from '../src/core/project';

const roots = [join(__dirname, '../designs')];
const design = (id: string) => loadDesign(roots, id, defaultRead);

function project(designId: string, findings: Record<string, string>, extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'rs-convert-'));
  writeFileSync(join(dir, 'report.yaml'), `# my comment\ndesign: ${designId}\ntitle: Web App Pentest\nversion: "1.0"\nreport_date: 2026-03-01\nclient: ACME\n${extra}`);
  mkdirSync(join(dir, 'findings'));
  for (const [name, text] of Object.entries(findings)) writeFileSync(join(dir, 'findings', `${name}.md`), text);
  return loadProject(dir);
}

const written = (r: ReturnType<typeof convertProject>, path: string) => r.writes.find((w) => w.path === path)!.content;
const item = (r: ReturnType<typeof convertProject>, path: string) => findingValues(parseFinding(written(r, path)));

describe('option matching', () => {
  const retest = design('retest').findingFields.find((f) => f.id === 'retest_status')!.options!;
  it('matches by value, label and meaning', () => {
    expect(matchOption('solved', retest)).toBe('solved');
    expect(matchOption('Partially solved', retest)).toBe('partial');
    expect(matchOption('fixed', retest)).toBe('solved');
    expect(matchOption('not_fixed', retest)).toBe('not_solved');
    expect(matchOption('banana', retest)).toBeUndefined();
  });
  it('converts between field types', () => {
    const enumF = design('retest').findingFields.find((f) => f.id === 'retest_status')!;
    expect(convertValue(true, { id: 'x', type: 'boolean', label: 'X' }, enumF)).toEqual({ ok: true, value: 'solved', changed: true });
    expect(convertValue('a\nb', { id: 'x', type: 'text', label: 'X' }, { id: 'x', type: 'list', label: 'X' })).toEqual({ ok: true, value: ['a', 'b'], changed: true });
    expect(convertValue(['a', 'b'], undefined, { id: 'x', type: 'markdown', label: 'X' })).toEqual({ ok: true, value: '- a\n- b', changed: true });
    expect(convertValue('3,5', undefined, { id: 'x', type: 'number', label: 'X' })).toEqual({ ok: true, value: 3.5, changed: true });
  });
});

describe('changing the report type', () => {
  const sqli = `---\ntitle: SQL Injection\ncvss: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H\n---\n<!-- field:description -->\nThe id parameter.\n\n<!-- field:recommendation -->\nPrepared statements.\n`;

  it('creates a retest from a pentest: retest fields start empty, previous report is referenced', () => {
    const p = project('pentest', { sqli });
    const r = convertProject(p, design('pentest'), design('retest'), { mode: 'copy', map: suggestMapping(p, design('pentest'), design('retest')), now: new Date('2026-10-26') }, defaultRead);
    const report = parse(written(r, 'report.yaml'));
    expect(written(r, 'report.yaml')).toContain('# my comment');
    expect(report.design).toBe('retest');
    expect(String(report.report_date)).toBe('2026-10-26');
    expect(report.original_report).toBe('Web App Pentest v1.0 (2026-03-01)');
    const f = item(r, 'findings/sqli.md');
    expect(f.retest_status).toBe('not_tested');
    expect(f.description).toBe('The id parameter.');
    expect(r.deletes).toEqual([]);
    expect(describePlan(r)).toContain('Retest result');
  });

  it('starts a new retest round: results of the previous round are reset', () => {
    const p = project('retest', { sqli: sqli.replace('---\n<!--', 'retest_status: solved\nretest_date: 2026-04-01\n---\n<!--') + '<!-- field:retest_notes -->\nVerified.\n' });
    const r = convertProject(p, design('retest'), design('retest'), { mode: 'copy', map: { findings: 'findings' } }, defaultRead);
    const f = item(r, 'findings/sqli.md');
    expect(f.retest_status).toBe('not_tested');
    expect(f.retest_date).toBeUndefined();
    expect(f.retest_notes).toBeUndefined();
    expect(r.plan.collections[0].changes.reset).toContain('Retest notes');
  });

  it('converts in place, keeping values the new type does not use unless asked', () => {
    const p = project('retest', { sqli: sqli.replace('---\n<!--', 'retest_status: partial\n---\n<!--') });
    const keep = convertProject(p, design('retest'), design('pentest'), { mode: 'inplace', map: { findings: 'findings' } }, defaultRead);
    expect(item(keep, 'findings/sqli.md').retest_status).toBe('partial');
    expect(keep.plan.collections[0].changes.unused).toContain('Retest result');
    const drop = convertProject(p, design('retest'), design('pentest'), { mode: 'inplace', map: { findings: 'findings' }, dropUnused: true }, defaultRead);
    expect(item(drop, 'findings/sqli.md').retest_status).toBeUndefined();
  });

  it('maps the legacy fixed flag to the retest result', () => {
    const p = project('pentest', { sqli: sqli.replace('---\n<!--', 'fixed: true\n---\n<!--') });
    const r = convertProject(p, design('pentest'), design('retest'), { mode: 'inplace', map: { findings: 'findings' } }, defaultRead);
    const f = item(r, 'findings/sqli.md');
    expect(f.retest_status).toBe('solved');
    expect(f.fixed).toBeUndefined();
  });

  it('moves items to another collection and renames the title field', () => {
    const p = project('pentest', { sqli });
    const to = design('incident-response');
    const r = convertProject(p, design('pentest'), to, { mode: 'inplace', map: { findings: 'iocs' } }, defaultRead);
    expect(r.deletes).toEqual(['findings/sqli.md']);
    const f = item(r, 'iocs/sqli.md');
    expect(f.value).toBe('SQL Injection');
  });
});
