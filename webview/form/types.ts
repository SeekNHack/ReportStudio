import type { FieldDef, SeverityDef } from '../../src/core/types';

export type { FieldDef, SeverityDef };

export interface Placeholders {
  report: { id: string; label: string; type: string }[];
  finding: { id: string; label: string; type: string }[];
  /** variable name of the current item (finding, event …) */
  itemVar: string;
  collections: string[];
  stats: string[];
}

export interface Meta {
  file: string;
  projectName?: string;
  inProject: boolean;
  library: boolean;
  designId?: string;
  designName?: string;
  designError?: string;
  designs: { id: string; builtin: boolean }[];
  severities: SeverityDef[];
  collection?: { id: string; label: string; itemLabel: string; itemVar: string; titleField: string; hasSeverity: boolean };
  collectionMissing: boolean;
  themeFields: FieldDef[];
  themeDefaults: Record<string, unknown>;
  number?: string;
  parseError?: string;
  projectBase?: string;
  placeholders: Placeholders;
}

export interface FieldIssue {
  field?: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface InitMessage {
  type: 'init';
  kind: 'finding' | 'report';
  fields: FieldDef[];
  values: Record<string, unknown>;
  issues: FieldIssue[];
  meta: Meta;
}
