# Changelog

## 0.4.0

- Template editor → **Layout** tab: the order of the report as blocks (cover, table of
  contents, headings, report fields, fields tables, collections, severity summary, findings
  table, severity scale, charts, Markdown text with placeholders, custom HTML files, page
  breaks). Drag them, add them from a palette (fields not yet in the report are highlighted),
  choose chapter / section / no heading. Saved as `layout:` in design.yaml; works for every
  template based on the built-in HTML.
- Templates with a template.html written by hand get a **Placeholders** tab instead: every
  field with the right placeholder for its type, inserted at the cursor.
- Template editor → **Theme** tab: the default look of a template (no engagement needed).
  New settings: heading colors and sizes, line under chapter titles, title case, link color,
  table header text, row labels, borders, striped rows, captions, gradient direction, cover
  title size, and one color per severity (badges, charts, tables).
- Template preview without engagements: the Preview button and Ctrl+Alt+P on design.yaml,
  template.html or styles.css preview the template with sample data.
- Theme images and fonts of a template are stored in, and resolved from, its own folder.
- Fixed: quick successive edits in the form and template editors could overwrite each other.

## 0.3.0

- Home: one tab with Home, Engagements, Templates and Library, opened from the Report Studio
  sidebar. Engagements are no longer the first step: browse, preview and customise templates
  first, then create the engagement.
- Template gallery with cover thumbnails; preview any template with sample data, live while
  you edit its HTML and CSS; customise (extend), copy with HTML, import and delete templates.
- Templates live in the workspace `designs/` folder and are shared by every engagement;
  engagements are created in `engagements/` (`reportStudio.engagementsFolder`).
- New Engagement dialog with template, client and dates. New Workspace view in the sidebar.

## 0.2.0

- Screenshot annotation editor: boxes, ellipses, arrows, highlighter, redaction (black box or
  pixelate), text, numbered steps and crop; annotations stay editable.
- Export Data: Excel, CSV, JSON and SARIF 2.1.0.
- Change Report Type and New Report from This One (e.g. pentest → retest, new retest rounds),
  with value conversion and a summary before writing. New field option `copy: false`.
- 15 built-in report types, screenshots gallery and code listing fields.

## 0.1.0

- First release: designs with configurable fields and collections, form editor, live preview,
  PDF export with Chrome and Paged.js, design and theme editors.
