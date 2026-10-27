import { useState } from 'preact/hooks';
import { Field } from './fields';
import type { FieldDef, FieldIssue, Meta } from './types';

/** Grouped field sections shared by the forms and the theme editors. */

export type Values = Record<string, unknown>;

export function groupFields(fields: FieldDef[]): [string, FieldDef[]][] {
  const groups = new Map<string, FieldDef[]>();
  for (const f of fields) {
    const g = f.group ?? 'General';
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  return [...groups];
}

export const GROUP_ICONS: Record<string, string> = {
  General: 'info',
  Overview: 'dashboard',
  Details: 'note',
  Remediation: 'tools',
  Retest: 'debug-rerun',
  Engagement: 'calendar',
  Summary: 'graph',
  Colors: 'symbol-color',
  Typography: 'text-size',
  Cover: 'book',
  Page: 'file',
  Headings: 'symbol-text',
  Tables: 'table',
  Severities: 'shield',
};

export function Sections(props: { fields: FieldDef[]; values: Values; meta: Meta; onChange: (k: string, v: unknown, immediate?: boolean) => void; issuesFor: (id: string) => FieldIssue[]; prefix?: string; defaults?: Values; context?: Values }) {
  const groups = groupFields(props.fields);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <>
      {groups.length > 1 && (
        <nav class="group-nav">
          {groups.map(([g, list]) => {
            const missing = list.filter((f) => f.required && isEmpty(getPath(props.values, (props.prefix ?? '') + f.id))).length;
            return (
              <a onClick={() => document.getElementById(`group-${g}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                <i class={`codicon codicon-${GROUP_ICONS[g] ?? 'symbol-namespace'}`} /> {g}
                {missing > 0 && <span class="pill warn">{missing}</span>}
              </a>
            );
          })}
        </nav>
      )}
      {groups.map(([g, list]) => (
        <section class="group" id={`group-${g}`}>
          <h2 class="group-title" onClick={() => setCollapsed({ ...collapsed, [g]: !collapsed[g] })}>
            <i class={`codicon codicon-chevron-${collapsed[g] ? 'right' : 'down'}`} />
            <i class={`codicon codicon-${GROUP_ICONS[g] ?? 'symbol-namespace'}`} /> {g}
          </h2>
          {!collapsed[g] && (
            <div class="group-body">
              {list.map((f) => {
                const key = (props.prefix ?? '') + f.id;
                return (
                  <Field
                    field={f}
                    value={getPath(props.values, key)}
                    onChange={(v, immediate) => props.onChange(key, v, immediate)}
                    meta={props.meta}
                    issues={props.issuesFor(f.id)}
                    fallback={props.defaults?.[f.id]}
                    onReset={props.defaults ? () => props.onChange(key, undefined, true) : undefined}
                    context={props.context}
                  />
                );
              })}
            </div>
          )}
        </section>
      ))}
    </>
  );
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
}

export function getPath(obj: Values, key: string): unknown {
  if (!key.startsWith('theme.')) return obj[key];
  return ((obj.theme as Values) ?? {})[key.slice(6)];
}

export function setPath(obj: Values, key: string, value: unknown): void {
  if (key === 'theme') {
    obj.theme = value ?? {};
    return;
  }
  if (!key.startsWith('theme.')) {
    obj[key] = value;
    return;
  }
  const theme = { ...((obj.theme as Values) ?? {}) };
  if (value === undefined) delete theme[key.slice(6)];
  else theme[key.slice(6)] = value;
  obj.theme = theme;
}

