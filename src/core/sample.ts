import { join } from 'node:path';
import type { Design, FieldDef, Item, Project } from './types';

/**
 * Sample data for a design, used to preview a template before any engagement
 * exists: every field gets a plausible value and each collection three entries
 * with different severities.
 */

const CVSS_SAMPLES = [
  'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
  'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N',
  'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N',
];

const REPORT_SAMPLES: Record<string, string> = {
  client: 'ACME Corp',
  title: 'Sample Report',
  target: 'https://app.example.com',
  version: '1.0',
  author: 'Jane Doe',
  authors: 'Jane Doe',
};

const today = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export function sampleValue(f: FieldDef, i = 0, label = f.label, screenshot?: string): unknown {
  if (f.default !== undefined && f.type !== 'markdown') return f.default;
  switch (f.type) {
    case 'string':
    case 'user':
      return f.placeholder || `Sample ${label.toLowerCase()}`;
    case 'text':
      return f.placeholder || `Sample ${label.toLowerCase()}.`;
    case 'markdown':
      return `Sample **${label.toLowerCase()}**. Replace this text with your own content.\n\n- First point\n- Second point`;
    case 'code':
      return `\`\`\`${f.language || 'http'}\nGET /api/users/${i + 1} HTTP/1.1\nHost: app.example.com\n\`\`\``;
    case 'number':
    case 'range':
      return f.min ?? i + 1;
    case 'boolean':
      return i % 2 === 1;
    case 'enum':
      return f.options?.length ? f.options[i % f.options.length].value : undefined;
    case 'date':
      return today(i);
    case 'datetime':
      return `${today()}T${String(9 + i).padStart(2, '0')}:30`;
    case 'list':
      return ['First item', 'Second item'];
    case 'table':
      return [0, 1].map((r) => Object.fromEntries((f.columns ?? []).map((c) => [c.id, sampleValue(c, r)])));
    case 'cvss':
      return CVSS_SAMPLES[i % CVSS_SAMPLES.length];
    case 'image':
      return screenshot;
    case 'screenshots':
      return screenshot && i === 0 ? [{ image: screenshot, caption: `Sample ${label.toLowerCase()}`, width: '70%' }] : undefined;
    default:
      return undefined;
  }
}

/**
 * An in-memory project rooted at `dir` (only used to resolve relative assets).
 * `screenshot` is an absolute image path used for image and screenshot fields.
 */
export function sampleProject(design: Design, dir: string, screenshot?: string): Project {
  const report: Record<string, unknown> = { design: design.id };
  for (const f of design.reportFields) {
    const known = f.default === undefined && REPORT_SAMPLES[f.id] !== undefined && (f.type === 'list' ? [REPORT_SAMPLES[f.id]] : f.type === 'string' || f.type === 'user' || f.type === 'text' ? REPORT_SAMPLES[f.id] : undefined);
    const v = known || (f.id.endsWith('_date') ? today() : f.type === 'image' ? undefined : sampleValue(f, 0, f.label, screenshot));
    if (v !== undefined) report[f.id] = v;
  }
  const items: Record<string, Item[]> = {};
  for (const c of design.collections) {
    items[c.id] = [0, 1, 2].map((i) => {
      const values: Record<string, unknown> = {};
      // With a CVSS vector the severity is derived from it, so the samples get different ones.
      const derived = c.fields.some((f) => f.type === 'cvss');
      for (const f of c.fields) {
        if (derived && f.id === 'severity') continue;
        const v = f.id === c.titleField ? `${c.itemLabel} ${i + 1}` : sampleValue(f, i, f.label, screenshot);
        if (v !== undefined) values[f.id] = v;
      }
      return { id: `sample-${c.id}-${i + 1}`, file: join(dir, c.id, `sample-${i + 1}.md`), collection: c.id, values };
    });
  }
  return { dir, reportFile: join(dir, 'report.yaml'), designId: design.id, report, items, findings: items.findings ?? [] };
}
