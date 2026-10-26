import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { markdownFieldIds } from '../src/core/design';
import { newFindingText } from '../src/core/findingFile';
import type { Design, FieldDef } from '../src/core/types';

const SHOT = join(__dirname, '../examples/demo-engagement/assets/sqli-error.svg');

/** A plausible value for any field, so every preset can be rendered end to end. */
export function sampleValue(f: FieldDef, i: number): unknown {
  switch (f.type) {
    case 'string':
    case 'user':
      return `${f.label} ${i + 1}`;
    case 'text':
      return `Plain text for ${f.label}.`;
    case 'markdown':
      return `Sample **${f.label}** for {{ report.client }}.\n\n\`\`\`bash title="cmd.sh" lines highlight="2"\nwhoami\nid\n\`\`\`\n\n![Sample screenshot|50%](assets/shot.svg)`;
    case 'code':
      return '```python title="poc.py" caption="Sample"\nimport requests\nprint(requests.get("https://example.com").status_code)\n```';
    case 'number':
    case 'range':
      return 3 + i;
    case 'boolean':
      return i % 2 === 0;
    case 'enum':
      return f.options![i % f.options!.length].value;
    case 'date':
      return `2026-10-${String(10 + i).padStart(2, '0')}`;
    case 'datetime':
      return `2026-10-${String(10 + i).padStart(2, '0')}T0${i % 9}:30`;
    case 'list':
      return ['First entry', 'Second entry'];
    case 'table':
      return [0, 1].map((r) => Object.fromEntries((f.columns ?? []).map((c) => [c.id, sampleValue(c, r)])));
    case 'cvss':
      return ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N'][i % 2];
    case 'image':
      return 'assets/shot.svg';
    case 'screenshots':
      return [{ image: 'assets/shot.svg', caption: `Screenshot of ${f.label}`, width: '60%' }];
    default:
      return undefined;
  }
}

/** Writes a project for `design` with two entries per collection and every field filled in. */
export function sampleProject(design: Design): string {
  const dir = mkdtempSync(join(tmpdir(), `preset-${design.id}-`));
  mkdirSync(join(dir, 'assets'));
  copyFileSync(SHOT, join(dir, 'assets/shot.svg'));
  const report: Record<string, unknown> = { design: design.id };
  for (const f of design.reportFields) report[f.id] = f.id === 'language' ? 'en' : sampleValue(f, 0);
  report.title = design.name;
  writeFileSync(join(dir, 'report.yaml'), stringify(report));
  for (const c of design.collections) {
    mkdirSync(join(dir, c.id));
    for (let i = 0; i < 2; i++) {
      const values = Object.fromEntries(c.fields.map((f) => [f.id, sampleValue(f, i)]));
      if (c.fields.some((f) => f.id === 'severity') && c.fields.some((f) => f.id === 'cvss')) delete values.severity;
      writeFileSync(join(dir, c.id, `entry-${i + 1}.md`), newFindingText(values, markdownFieldIds(c.fields), c.fields.map((f) => f.id)));
    }
  }
  return dir;
}
