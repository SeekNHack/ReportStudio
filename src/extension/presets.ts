/** Order, grouping and icons of the built-in report types. */
export const PRESET_GROUPS: [string, string[]][] = [
  ['Offensive security', ['pentest', 'retest', 'vulnerability-assessment', 'code-review', 'red-team', 'phishing-campaign']],
  ['Blue team', ['incident-response', 'blue-team-analysis', 'threat-hunting', 'forensic-analysis', 'malware-analysis']],
  ['General', ['activity-report', 'compliance-audit', 'base', 'minimal']],
];

export const PRESET_ICONS: Record<string, string> = {
  pentest: 'bug',
  retest: 'debug-rerun',
  'vulnerability-assessment': 'radio-tower',
  'code-review': 'code',
  'red-team': 'flame',
  'phishing-campaign': 'mail',
  'incident-response': 'flame',
  'blue-team-analysis': 'pulse',
  'threat-hunting': 'search',
  'forensic-analysis': 'microscope',
  'malware-analysis': 'shield',
  'activity-report': 'checklist',
  'compliance-audit': 'law',
  base: 'file',
  minimal: 'file-text',
};

export function presetGroup(id: string): string | undefined {
  return PRESET_GROUPS.find(([, ids]) => ids.includes(id))?.[0];
}

export function presetOrder(id: string): number {
  const all = PRESET_GROUPS.flatMap(([, ids]) => ids);
  const i = all.indexOf(id);
  return i < 0 ? all.length : i;
}
