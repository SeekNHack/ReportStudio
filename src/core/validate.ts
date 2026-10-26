import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { scoreCvss } from './cvss';
import { screenshotPath, SECTION_TYPES } from './design';
import { parseDate } from './render';
import type { Design, FieldDef, Issue, Project, ReadFile } from './types';

function lineOf(text: string, key: string, markdown: boolean): number | undefined {
  const lines = text.split(/\r?\n/);
  const re = markdown ? new RegExp(`^<!--\\s*field:${key}\\s*-->`) : new RegExp(`^${key}\\s*:`);
  const i = lines.findIndex((l) => re.test(l));
  return i >= 0 ? i + 1 : undefined;
}

function checkValue(f: FieldDef, v: unknown, baseDir: string, prefix = ''): string[] {
  const label = `${prefix}"${f.label}"`;
  const errors: string[] = [];
  if (f.type === 'cvss' && !scoreCvss(v)) errors.push(`${label} is not a valid CVSS vector`);
  if (f.type === 'enum' && !f.options?.some((o) => o.value === String(v))) errors.push(`${label}: "${v}" is not one of ${f.options?.map((o) => o.value).join(', ')}`);
  if (f.type === 'boolean' && typeof v !== 'boolean') errors.push(`${label} must be true or false`);
  if ((f.type === 'number' || f.type === 'range') && typeof v !== 'number') errors.push(`${label} must be a number`);
  if ((f.type === 'date' || f.type === 'datetime') && !parseDate(v)) errors.push(`${label} is not a valid date (use YYYY-MM-DD${f.type === 'datetime' ? 'THH:mm' : ''})`);
  if (f.type === 'list' && !Array.isArray(v)) errors.push(`${label} must be a list`);
  if (f.type === 'screenshots') {
    if (!Array.isArray(v)) errors.push(`${label} must be a list of { image, caption }`);
    else v.forEach((s, i) => !screenshotPath(s) && errors.push(`${label} entry ${i + 1}: "image" is missing`));
  }
  if (f.type === 'table') {
    if (!Array.isArray(v)) errors.push(`${label} must be a list of rows`);
    else
      v.forEach((row, i) => {
        for (const col of f.columns ?? []) {
          const cell = (row as Record<string, unknown>)?.[col.id];
          if (cell === undefined || cell === null || cell === '') {
            if (col.required) errors.push(`${label} row ${i + 1}: "${col.label}" is required`);
            continue;
          }
          errors.push(...checkValue(col, cell, baseDir, `${label} row ${i + 1}: `));
        }
      });
  }
  return errors;
}

export function validateValues(values: Record<string, unknown>, fields: FieldDef[], file: string, text: string, baseDir: string): Issue[] {
  const issues: Issue[] = [];
  const add = (f: FieldDef, message: string, severity: Issue['severity'] = 'warning') => issues.push({ file, field: f.id, message, severity, line: lineOf(text, f.id, SECTION_TYPES.includes(f.type)) ?? 1 });
  for (const f of fields) {
    const v = values[f.id];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) {
      if (f.required) add(f, `"${f.label}" is required`);
      continue;
    }
    for (const e of checkValue(f, v, baseDir)) add(f, e, 'error');
    if (f.type === 'markdown' || f.type === 'image' || f.type === 'screenshots') {
      const refs =
        f.type === 'image'
          ? [String(v)]
          : f.type === 'screenshots'
            ? (Array.isArray(v) ? v : []).map(screenshotPath).filter((x): x is string => !!x)
            : [...String(v).matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
      for (const ref of refs) {
        if (/^([a-z]+:|\/\/|#)/i.test(ref)) continue;
        const abs = isAbsolute(ref) ? ref : join(baseDir, decodeURI(ref));
        if (!existsSync(abs)) add(f, `Image not found: ${ref}`);
      }
    }
  }
  return issues;
}

export function validateProject(project: Project, design: Design, read: ReadFile): Issue[] {
  const issues = validateValues(project.report, design.reportFields, project.reportFile, read(project.reportFile), project.dir);
  const ids = new Map<string, string>();
  for (const [cid, items] of Object.entries(project.items)) {
    const collection = design.collections.find((c) => c.id === cid);
    if (!collection) {
      if (items.length)
        issues.push({ file: items[0].file, severity: 'info', line: 1, message: `Folder "${cid}/" is not a collection of design "${design.name}" and is not printed` });
      continue;
    }
    for (const f of items) {
      const text = read(f.file);
      issues.push(...validateValues(f.values, collection.fields, f.file, text, project.dir));
      const unknown = Object.keys(f.values).filter((k) => !['id', 'order'].includes(k) && !collection.fields.some((d) => d.id === k));
      for (const k of unknown)
        issues.push({ file: f.file, field: k, severity: 'info', line: lineOf(text, k, text.includes(`field:${k}`)), message: `"${k}" is not a field of "${collection.label}" in design "${design.name}" and is ignored by the form` });
      const key = `${cid}/${f.id}`;
      if (ids.has(key)) issues.push({ file: f.file, severity: 'error', line: 1, message: `Duplicate id "${f.id}" (also in ${relative(project.dir, ids.get(key)!)})` });
      ids.set(key, f.file);
    }
  }
  return issues;
}
