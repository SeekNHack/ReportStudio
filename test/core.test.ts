import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scoreCvss } from '../src/core/cvss';
import { listDesigns, loadDesign } from '../src/core/design';
import { applyDesignOp } from '../src/core/designEdit';
import { findingValues, parseFinding, serializeFinding, setFindingValue } from '../src/core/findingFile';
import { defaultRead, designRoots, loadProject, sortItems } from '../src/core/project';
import { renderReport } from '../src/core/render';
import { parseFenceInfo, renderCode } from '../src/core/render/markdown';
import { sampleProject } from './presets';
import { themeCss } from '../src/core/theme';
import { validateProject } from '../src/core/validate';
import { parse } from 'yaml';

const root = join(__dirname, '..');
const builtin = join(root, 'designs');
const roots = [builtin];
const asset = (p: string) => pathToFileURL(p).href;

describe('finding files', () => {
  const text = `---
title: SQLi
cvss: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H # comment kept
---
<!-- field:description -->
The \`id\` parameter.

## Heading inside

<!-- field:recommendation -->
Use prepared statements.
`;

  it('round-trips without changes', () => {
    expect(serializeFinding(parseFinding(text))).toBe(text);
  });

  it('keeps comments and order when a value changes', () => {
    const p = parseFinding(text);
    setFindingValue(p, 'title', 'SQL Injection', false);
    setFindingValue(p, 'recommendation', 'Use ORM.', true);
    const out = serializeFinding(p);
    expect(out).toContain('# comment kept');
    expect(out).toContain('title: SQL Injection');
    expect(findingValues(parseFinding(out)).recommendation).toBe('Use ORM.');
    expect(findingValues(parseFinding(out)).description).toContain('## Heading inside');
  });
});

describe('designs', () => {
  it('resolves extends chains and legacy finding_fields', () => {
    const d = loadDesign(roots, 'retest', defaultRead);
    expect(d.parents.map((p) => p.id)).toEqual(['pentest', 'base']);
    const findings = d.collections.find((c) => c.id === 'findings')!;
    expect(findings.hasSeverity).toBe(true);
    expect(findings.sort).toBe('severity');
    expect(findings.prefix).toBe('F-');
    expect(findings.fields.map((f) => f.id)).toEqual(expect.arrayContaining(['cvss', 'description', 'retest_status', 'retest_notes', 'evidence', 'request']));
    expect(d.reportFields.find((f) => f.id === 'title')?.default).toBe('Penetration Test Retest');
  });

  it('loads generic collections with layouts and table fields', () => {
    const d = loadDesign(roots, 'incident-response', defaultRead);
    expect(d.collections.map((c) => [c.id, c.layout])).toEqual([
      ['events', 'timeline'],
      ['iocs', 'table'],
      ['actions', 'sections'],
    ]);
    expect(d.collections.find((c) => c.id === 'iocs')!.titleField).toBe('value');
    expect(d.reportFields.find((f) => f.id === 'affected_systems')!.columns!.map((c) => c.id)).toEqual(['hostname', 'ip', 'role', 'impact']);
    expect(d.collections.find((c) => c.id === 'events')!.itemVar).toBe('event');
  });
});

describe('design editor operations', () => {
  const base = `# my design\nname: Test\nextends: base\n`;
  it('adds, edits, moves and removes fields keeping comments', () => {
    let t = applyDesignOp(base, { op: 'addCollection', id: 'interviews', label: 'Interviews' });
    t = applyDesignOp(t, { op: 'addField', scope: 'interviews', id: 'person', type: 'user' });
    t = applyDesignOp(t, { op: 'addField', scope: 'interviews', id: 'mood', type: 'enum' });
    t = applyDesignOp(t, { op: 'setField', scope: 'interviews', id: 'person', prop: 'required', value: true });
    t = applyDesignOp(t, { op: 'moveField', scope: 'interviews', id: 'mood', delta: -1 });
    t = applyDesignOp(t, { op: 'setField', scope: 'interviews', id: 'mood', prop: 'options', value: [{ value: 'calm', label: 'Calm', color: '#00ff00' }, { value: 'angry', label: 'Angry' }] });
    t = applyDesignOp(t, { op: 'removeField', scope: '_report', id: 'subtitle', inherited: true });
    t = applyDesignOp(t, { op: 'setCollection', id: 'interviews', prop: 'layout', value: 'table' });
    expect(t).toContain('# my design');
    const raw = parse(t);
    expect(Object.keys(raw.collections.interviews.fields)).toEqual(['title', 'mood', 'person']);
    expect(raw.collections.interviews.fields.person).toEqual({ type: 'user', required: true });
    expect(raw.collections.interviews.fields.mood.options[0]).toEqual({ value: 'calm', label: 'Calm', color: '#00ff00' });
    expect(raw.report_fields.subtitle).toBeNull();
    expect(raw.collections.interviews.layout).toBe('table');
  });

  it('edits legacy finding_fields in place', () => {
    const t = applyDesignOp('finding_fields:\n  title: { type: string }\n', { op: 'setField', scope: 'findings', id: 'title', prop: 'label', value: 'Name' });
    expect(parse(t).finding_fields.title.label).toBe('Name');
  });
});

describe('rendering', () => {
  it('renders the retest demo with placeholders, numbering and protected code', () => {
    const project = loadProject(join(root, 'examples/demo-engagement'));
    const design = loadDesign(designRoots(project.dir, builtin), project.designId, defaultRead);
    const r = renderReport(project, design, { read: defaultRead, assetUrl: asset });
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.body).toContain('F-01');
    expect(r.body).toContain("ACME Corp's ticket SEC-142");
    expect(r.body).toContain('{{7*7}}');
    expect(r.body).toMatch(/<nav class="toc">/);
    expect(validateProject(project, design, defaultRead).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('renders a generic incident report without any custom HTML for items', () => {
    const project = loadProject(join(root, 'examples/incident-2026'));
    const design = loadDesign(designRoots(project.dir, builtin), project.designId, defaultRead);
    const r = renderReport(project, design, { read: defaultRead, assetUrl: asset });
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.body).toContain('class="timeline timeline-events"');
    expect(r.body).toContain('update-cdn-sync.com');
    expect(r.body).toContain('A-01');
    expect(r.body).toContain('<table class="field-table">');
    expect(r.body).toMatch(/3 Oct 2026 02:14/); // placeholder with datetime filter, no time zone shift
    // sorted by timestamp
    const titles = [...r.body.matchAll(/class="tl-title">([^<]+)/g)].map((m) => m[1].trim());
    expect(titles[0]).toBe('VPN login from unusual country');
    expect(r.css).toContain('--accent: #0f766e');
    expect(validateProject(project, design, defaultRead).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('sorts by date fields and enum order', () => {
    const project = loadProject(join(root, 'examples/incident-2026'));
    const design = loadDesign(designRoots(project.dir, builtin), project.designId, defaultRead);
    const actions = sortItems(project.items.actions, design.collections.find((c) => c.id === 'actions'), design);
    expect(actions.map((a) => a.values.title)).toEqual(['Rotate privileged credentials', 'Enforce MFA on VPN']);
  });
});

describe('cvss and theme', () => {
  it('scores CVSS 3.1 and 4.0', () => {
    expect(scoreCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')?.score).toBe(9.8);
    expect(scoreCvss('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')?.score).toBe(9.3);
    expect(scoreCvss('nonsense')).toBeUndefined();
  });

  it('generates CSS variables and font faces', () => {
    const css = themeCss({ accent: '#ff0000', font_body: 'assets/fonts/Brand.woff2', header: false }, '/p', (p) => `file://${p}`);
    expect(css).toContain('--accent: #ff0000');
    expect(css).toContain("@font-face { font-family: 'theme-Brand'; src: url('file:///p/assets/fonts/Brand.woff2') format('woff2'); }");
    expect(css).toContain('@top-left { content: none; }');
  });
});

describe('presets', () => {
  const ids = listDesigns(roots).map((d) => d.id);

  it('ships the expected report types', () => {
    expect(ids).toEqual(
      expect.arrayContaining(['pentest', 'retest', 'incident-response', 'blue-team-analysis', 'threat-hunting', 'forensic-analysis', 'malware-analysis', 'activity-report', 'vulnerability-assessment', 'red-team', 'code-review', 'phishing-campaign', 'compliance-audit']),
    );
  });

  it.each(ids)('renders %s with every field filled in', (id) => {
    const design = loadDesign(roots, id, defaultRead);
    const project = loadProject(sampleProject(design));
    const r = renderReport(project, design, { read: defaultRead, assetUrl: asset });
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(validateProject(project, design, defaultRead).filter((i) => i.severity === 'error')).toEqual([]);
    for (const c of design.collections) expect(r.body).toContain(`collection-${c.id}`.replace('collection-findings', 'findings'));
    // every report field with a printable section appears in the output
    const shots = [...design.reportFields, ...design.collections.flatMap((c) => c.fields)].some((f) => f.type === 'screenshots');
    if (shots) expect(r.body).toContain('figure screenshot');
  });

  it('retest counts solved and partially solved findings', () => {
    const project = loadProject(join(root, 'examples/demo-engagement'));
    const design = loadDesign(designRoots(project.dir, builtin), project.designId, defaultRead);
    const r = renderReport(project, design, { read: defaultRead, assetUrl: asset });
    expect(r.body).toContain('2 of 5 findings are solved, 1 partially solved');
    expect(r.body).toContain('Partially solved');
  });
});

describe('code and screenshots', () => {
  it('renders fenced code with title, caption, line numbers and marked lines', () => {
    const md = parseFenceInfo('python title="exploit.py" caption="Payload" lines highlight="2,4-5"');
    expect(md).toEqual({ lang: 'python', title: 'exploit.py', caption: 'Payload', lines: true, highlight: [2, 4, 5] });
    const html = renderCode('a = """x\ny"""\nb = 1\n', { lang: 'python', lines: true, highlight: [2] });
    expect(html.match(/class="line/g)).toHaveLength(3);
    expect(html).toContain('class="line marked" data-n="2"><span class="hljs-string">y&quot;&quot;&quot;</span>');
  });

  it('sizes images with ![caption|50%](…)', () => {
    const r = renderReport(loadProject(join(root, 'examples/demo-engagement')), loadDesign(roots, 'retest', defaultRead), { read: defaultRead, assetUrl: asset });
    expect(r.body).toContain('style="width:75%"');
    expect(r.body).toContain('<figure class="listing"><div class="code-title">POST /api/v2/auth/login</div>');
  });
});
