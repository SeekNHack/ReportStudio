export type HomeTab = 'home' | 'engagements' | 'templates' | 'library';

export interface EngagementInfo {
  dir: string;
  /** folder name */
  name: string;
  /** path relative to the workspace */
  path: string;
  title?: string;
  client?: string;
  designId: string;
  designName: string;
  icon: string;
  dates: { start?: string; end?: string; report?: string };
  collections: { id: string; label: string; icon: string; count: number }[];
  severities: { id: string; label: string; color: string; count: number }[];
  /** findings still open, when the design tracks resolution */
  open?: number;
  modified: number;
  active: boolean;
  error?: string;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description?: string;
  group: string;
  icon: string;
  source: 'builtin' | 'workspace' | 'project' | 'settings';
  /** where it lives, relative to the workspace */
  location: string;
  dir: string;
  extends?: string;
  collections: { label: string; icon: string; fields: number }[];
  reportFields: number;
  /** own template and style files (template.html, styles.css …) */
  files: string[];
  theme: { accent: string; coverStart: string; coverEnd: string; coverText: string; layout: string };
  usedBy: number;
  hasDates: boolean;
  error?: string;
}

export interface LibraryInfo {
  file: string;
  title: string;
  category?: string;
  severity?: string;
  score?: number;
}

export interface HomeState {
  workspace?: string;
  hasFolder: boolean;
  engagementsDir?: string;
  templatesDir?: string;
  /** folder names already used in the engagements folder */
  taken: string[];
  engagements: EngagementInfo[];
  templates: TemplateInfo[];
  library: LibraryInfo[];
  hasActive: boolean;
}

/** Sent by the extension to switch tab or open the New Engagement dialog. */
export interface HomeNavigate {
  type: 'navigate';
  tab?: HomeTab;
  newEngagement?: string | true;
}
