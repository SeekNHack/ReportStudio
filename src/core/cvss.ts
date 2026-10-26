import { Cvss2, Cvss3P0, Cvss3P1, Cvss4P0 } from 'ae-cvss-calculator';
import type { SeverityDef } from './types';

export interface CvssResult {
  version: '2.0' | '3.0' | '3.1' | '4.0';
  vector: string;
  score: number;
}

/** Parses and scores a CVSS vector; returns undefined for an invalid one. */
export function scoreCvss(vector: unknown): CvssResult | undefined {
  if (typeof vector !== 'string' || !vector.trim()) return undefined;
  const v = vector.trim();
  try {
    if (v.startsWith('CVSS:4.0/')) {
      const s = new Cvss4P0(v).calculateScores();
      return { version: '4.0', vector: v, score: num(s.overall ?? s.base) };
    }
    if (v.startsWith('CVSS:3.1/') || v.startsWith('CVSS:3.0/')) {
      const c = v.startsWith('CVSS:3.1/') ? new Cvss3P1(v) : new Cvss3P0(v);
      const s = c.calculateScores();
      if (!isComplete(v, ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'])) return undefined;
      return { version: v.startsWith('CVSS:3.1/') ? '3.1' : '3.0', vector: v, score: num(s.overall ?? s.base) };
    }
    if (/^(\()?AV:[LAN]\//.test(v)) {
      const s = new Cvss2(v).calculateScores();
      return { version: '2.0', vector: v, score: num(s.overall ?? s.base) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isComplete(v: string, metrics: string[]): boolean {
  return metrics.every((m) => new RegExp(`/${m}:[A-Z]`).test(v));
}

function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

export function severityForScore(score: number, severities: SeverityDef[]): SeverityDef {
  const sorted = [...severities].sort((a, b) => b.min - a.min);
  return sorted.find((s) => score >= s.min) ?? sorted[sorted.length - 1];
}

/** Human readable metric names for CVSS 3.x vectors, used by the `cvss_table` filter. */
export const CVSS3_METRICS: Record<string, { name: string; values: Record<string, string> }> = {
  AV: { name: 'Attack Vector', values: { N: 'Network', A: 'Adjacent', L: 'Local', P: 'Physical' } },
  AC: { name: 'Attack Complexity', values: { L: 'Low', H: 'High' } },
  PR: { name: 'Privileges Required', values: { N: 'None', L: 'Low', H: 'High' } },
  UI: { name: 'User Interaction', values: { N: 'None', R: 'Required' } },
  S: { name: 'Scope', values: { U: 'Unchanged', C: 'Changed' } },
  C: { name: 'Confidentiality', values: { N: 'None', L: 'Low', H: 'High' } },
  I: { name: 'Integrity', values: { N: 'None', L: 'Low', H: 'High' } },
  A: { name: 'Availability', values: { N: 'None', L: 'Low', H: 'High' } },
};

export const CVSS4_METRICS: Record<string, { name: string; values: Record<string, string> }> = {
  AV: { name: 'Attack Vector', values: { N: 'Network', A: 'Adjacent', L: 'Local', P: 'Physical' } },
  AC: { name: 'Attack Complexity', values: { L: 'Low', H: 'High' } },
  AT: { name: 'Attack Requirements', values: { N: 'None', P: 'Present' } },
  PR: { name: 'Privileges Required', values: { N: 'None', L: 'Low', H: 'High' } },
  UI: { name: 'User Interaction', values: { N: 'None', P: 'Passive', A: 'Active' } },
  VC: { name: 'Confidentiality (Vulnerable)', values: { H: 'High', L: 'Low', N: 'None' } },
  VI: { name: 'Integrity (Vulnerable)', values: { H: 'High', L: 'Low', N: 'None' } },
  VA: { name: 'Availability (Vulnerable)', values: { H: 'High', L: 'Low', N: 'None' } },
  SC: { name: 'Confidentiality (Subsequent)', values: { H: 'High', L: 'Low', N: 'None' } },
  SI: { name: 'Integrity (Subsequent)', values: { H: 'High', L: 'Low', N: 'None' } },
  SA: { name: 'Availability (Subsequent)', values: { H: 'High', L: 'Low', N: 'None' } },
};

export function cvssMetrics(vector: string): { metric: string; name: string; value: string }[] {
  const table = vector.startsWith('CVSS:4.0/') ? CVSS4_METRICS : CVSS3_METRICS;
  return vector
    .split('/')
    .slice(1)
    .map((part) => part.split(':'))
    .filter(([k]) => table[k])
    .map(([k, v]) => ({ metric: k, name: table[k].name, value: table[k].values[v] ?? v }));
}
