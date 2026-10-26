import { useState } from 'preact/hooks';
import { CVSS3_METRICS, CVSS4_METRICS, scoreCvss, severityForScore } from '../../src/core/cvss';
import type { SeverityDef } from './types';

const DEFAULT_31 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N';
const DEFAULT_40 = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N';

function parse(vector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of vector.split('/').slice(1)) {
    const [k, v] = part.split(':');
    if (k && v) out[k] = v;
  }
  return out;
}

function build(version: '3.1' | '4.0', metrics: Record<string, string>, extra: string[]): string {
  const table = version === '4.0' ? CVSS4_METRICS : CVSS3_METRICS;
  const base = Object.keys(table).map((k) => `${k}:${metrics[k] ?? Object.keys(table[k].values).slice(-1)[0]}`);
  return [`CVSS:${version}`, ...base, ...extra].join('/');
}

export function CvssField(props: { value: string; onChange: (v: string) => void; severities: SeverityDef[] }) {
  const value = props.value ?? '';
  const [open, setOpen] = useState(false);
  const result = scoreCvss(value);
  const version: '3.1' | '4.0' = value.startsWith('CVSS:4.0/') ? '4.0' : '3.1';
  const table = version === '4.0' ? CVSS4_METRICS : CVSS3_METRICS;
  const metrics = parse(value);
  const extra = value
    .split('/')
    .slice(1)
    .filter((p) => !table[p.split(':')[0]]);
  const sev = result ? severityForScore(result.score, props.severities) : undefined;

  const set = (k: string, v: string) => {
    const start = value && (value.startsWith('CVSS:3') || value.startsWith('CVSS:4')) ? metrics : parse(version === '4.0' ? DEFAULT_40 : DEFAULT_31);
    props.onChange(build(version, { ...start, [k]: v }, extra));
  };
  const switchVersion = (v: '3.1' | '4.0') => {
    if (v === version && value) return;
    props.onChange(v === '4.0' ? DEFAULT_40 : DEFAULT_31);
  };

  return (
    <div class="cvss">
      <div class="cvss-row">
        <input
          class={`input mono ${value && !result ? 'invalid' : ''}`}
          value={value}
          placeholder="CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
          onInput={(e) => props.onChange((e.target as HTMLInputElement).value.trim())}
          spellcheck={false}
        />
        <span class="cvss-score" style={{ '--c': sev?.color ?? 'var(--vscode-descriptionForeground)' }}>
          <b>{result ? result.score.toFixed(1) : '–'}</b>
          <span>{sev?.label ?? (value ? 'invalid' : 'no score')}</span>
        </span>
        <button class={`btn ${open ? 'active' : ''}`} onClick={() => setOpen(!open)} title="CVSS calculator">
          <i class="codicon codicon-symbol-numeric" /> Calculator
        </button>
      </div>
      {open && (
        <div class="cvss-calc">
          <div class="segmented small">
            {(['3.1', '4.0'] as const).map((v) => (
              <button class={v === version && value ? 'on' : ''} onClick={() => switchVersion(v)}>
                CVSS {v}
              </button>
            ))}
          </div>
          <div class="cvss-grid">
            {Object.entries(table).map(([k, def]) => (
              <div class="cvss-metric">
                <span class="cvss-metric-name" title={k}>
                  {def.name}
                </span>
                <div class="segmented small">
                  {Object.entries(def.values).map(([code, label]) => (
                    <button class={metrics[k] === code ? 'on' : ''} onClick={() => set(k, code)} title={`${k}:${code}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
