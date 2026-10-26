# Report Studio

Write any kind of report inside VS Code — penetration tests, retests, incident response,
audits, code reviews — and export it to PDF. Everything is configurable: which fields are
asked, their type, repeatable collections (findings, timeline events, IOCs…), placeholders,
layout, cover, fonts and colors. Edit it all with a GUI or as plain YAML/Markdown.

## Concepts

| Concept | What it is | Where it lives |
|---|---|---|
| **Project** | One report | a folder with `report.yaml` |
| **Design** | A report type: fields, collections, template, styles, theme | `designs/<id>/design.yaml` (+ optional `template.html`, `styles.css`) |
| **Report fields** | Asked once per report (client, dates, summary…) | values in `report.yaml` |
| **Collections** | Repeatable entries (findings, events, IOCs, actions…) | one Markdown file per entry in `<collection>/` |
| **Theme** | Cover layout, colors, fonts, page | `theme:` in `report.yaml` (Theme tab) |

### Built-in report types (presets)

| Preset | For | Highlights |
|---|---|---|
| `pentest` — Penetration Test | Web/infra pentest | CVSS 3.1/4.0, severity charts, PoC, request/exploit code, screenshots |
| `retest` — Penetration Test Retest | Verifying fixes | Everything from pentest + per-finding result **Solved / Partially solved / Not solved / Not retested**, retest notes and screenshots, results chart |
| `vulnerability-assessment` | Scan-based VA | Affected hosts/ports table, CVEs, scanner plugin, remediation priority |
| `code-review` — Secure Code Review | Source code audits | File/line, vulnerable code and suggested fix with line numbers and highlighted lines |
| `red-team` — Red Team Engagement | Adversary simulation | Objectives, attack path timeline mapped to ATT&CK with "detected" flag, findings |
| `incident-response` — Blue Team · Incident Response | IR | Timeline with log excerpts and screenshots, IOCs, affected systems, actions |
| `blue-team-analysis` — Blue Team · Security Analysis | SOC triage / log analysis | Data sources, observations with queries and screenshots, verdict, IOCs, recommendations |
| `threat-hunting` — Blue Team · Threat Hunting | Hunts | Hypotheses with ATT&CK, queries and outcome, new detection rules |
| `forensic-analysis` — Blue Team · Forensic Analysis | DFIR | Evidence with hashes, chain of custody, artifacts, timeline |
| `malware-analysis` — Blue Team · Malware Analysis | Sample analysis | Hashes and verdict, static/dynamic analysis, behaviours, IOCs, YARA rule |
| `phishing-campaign` | Social engineering | Results by department, e-mails with screenshots and metrics |
| `compliance-audit` | ISO 27001, NIST, CIS, PCI, GDPR, NIS2 gap analysis | Controls with compliant / partial / non-compliant status chart and evidence |
| `activity-report` | Generic activity / status report | Activities with owner, effort and status, issues and risks, free **custom fields** tables |
| `base` — Generic Report | Start of your own type | Prints every field and collection automatically |
| `minimal` | Plain one-column report | — |

Every preset is a plain `design.yaml`: copy it to your workspace or extend it to change fields.

## Getting started

1. **Report Studio** icon in the Activity Bar → **Create Report Project** → pick a design.
2. Fill in the **Report** form, add entries from the **Content** view (`+` on each collection).
3. **Live Preview** (`Ctrl+Alt+P`) shows the real pages while you type.
4. **Build PDF**: status bar button, toolbar buttons, `Ctrl+Alt+B`, or *Terminal → Run Build Task*.

The PDF is printed by Chrome, Chromium, Edge or Brave (found automatically, also in the
Playwright/Puppeteer caches, or set `reportStudio.chromePath`). Without a browser you can still
use **Export HTML**.

### code-server, vscode.dev tunnels, Remote-SSH, containers

The extension runs on the machine that holds the files (`extensionKind: workspace`), so Chrome
must be installed **there** (e.g. `apt install chromium`, or `npx playwright install chromium`).
Built PDFs open in a built-in viewer with a **Download** button (`reportStudio.pdfViewer`).
Install with `code-server --install-extension report-studio-<version>.vsix`.

## Create your own report type (no HTML needed)

**Report Studio: New Design…** → *Blank generic design* → name it. The **Design editor** opens:

- **Report fields**: add fields with any type, mark them required, group them in form
  sections, set defaults, help text and where they are printed (chapter before/after the
  collections, info table, hidden).
- **Collections**: add one per kind of entry; choose labels, numbering prefix, sort order,
  title field, icon and layout (**sections**, **table** or **timeline**), then its fields.
- Inherited fields (with `extends`) can be changed or hidden without copying them.

The same thing in YAML:

```yaml
name: Phishing Campaign
extends: base               # generic layout, cover, TOC, theme

report_fields:
  campaign:   { type: string, required: true }
  summary:    { type: markdown, required: true }
  targets:
    type: table
    columns:
      department: string
      users: number
      clicked: number
  conclusion: { type: markdown, section: after }

collections:
  emails:
    label: Phishing e-mails
    item_label: E-mail
    prefix: "P-"
    sort: -sent_at
    fields:
      title:    { type: string, required: true }
      sent_at:  { type: datetime }
      lure:
        type: enum
        options:
          - { value: invoice, label: Fake invoice, color: "#e8590c" }
          - { value: hr, label: HR notice, color: "#1f7ae0" }
      body:     { type: markdown }
```

### Field types

`string`, `text`, `markdown`, `code`, `number`, `boolean`, `enum` (options with colors), `date`,
`datetime`, `list`, `table` (typed columns), `cvss` (3.1/4.0 with calculator), `image`,
`screenshots`, `user`.

- **`screenshots`** — a gallery: paste, drop or choose images, give each a caption and a printed
  width, reorder them. They are printed as numbered figures ("Figure 3: …").
- **`code`** — a code listing with language, file name, caption, line numbers and highlighted
  lines (`language: http` and `lines: true` set the defaults). Stored as a fenced block, so item
  files stay readable Markdown.

Common options: `label`, `required`, `default`, `group`, `help`, `placeholder`, `rows`,
`section` (report fields only), `copy: false` (not carried over to a report created from this
one, e.g. retest results).

### Collection options

`label`, `item_label`, `item_var` (name inside placeholders), `prefix`, `sort` (`severity`,
`manual`, `<field>` or `-<field>`), `title_field`, `layout` (`sections` | `table` | `timeline`),
`columns`, `page_break`, `chart` (enum/boolean field summarised with a donut chart), `icon` (any [codicon](https://microsoft.github.io/vscode-codicons/)),
`description`, `fields`. A collection with a `cvss` or `severity` field gets severities,
CVSS scores and severity charts automatically.

## Screenshots and code inside Markdown

Every Markdown field also supports them (toolbar buttons *Code block…* and *Screenshot with
caption…*, or the `rs-code` / `rs-shot` snippets):

````md
![Admin panel reachable without login|75%](assets/admin.png)

```http title="POST /api/login" caption="Injection in the username parameter" lines highlight="5"
POST /api/login HTTP/1.1
Host: app.example.com
Content-Type: application/json

{"username": "admin'--", "password": "x"}
```
````

An image alone in its paragraph becomes a numbered figure with the alt text as caption;
`|75%` (or `|120mm`) sets its width. Fences accept `title`, `caption` (numbered "Listing N"),
`lines`, `start=10` and `highlight="2,4-6"`. Mermaid diagrams use ` ```mermaid `.

### Annotating screenshots

Click a screenshot (or *Annotate* next to an image) to open the editor: boxes, ellipses, arrows,
highlighter, **redaction** (black box or pixelate), text, numbered steps (1, 2, 3… to refer to
in the caption) and crop, with undo/redo and keyboard shortcuts (`R` box, `A` arrow, `B` redact,
`T` text, `N` step, `C` crop, `V` select, `Del`, `Ctrl+Z`, `Ctrl+S`).

Saving writes `assets/x.annotated.png` (what the report prints) and `assets/x.annotated.json`
(the original path and the shapes), so annotations stay editable. When you redact secrets,
untick **Keep original** to delete the unredacted image.

## Changing the report type

**Change Report Type…** (the design chip in the report form, or the command palette) moves a
report to another design without copying anything by hand:

- **Create a new report from this one** — this report stays untouched; findings, details and
  assets are copied into a new folder. Typical for a retest: pentest → *Penetration Test
  Retest* adds the retest fields (result *Not retested*), sets today's report date and fills
  *Original report*. Retest → retest starts a new round: fields marked `copy: false` (retest
  result, notes, date, screenshots) are reset.
- **Convert this report** — changes the type in place.

Values go to the field with the same id and are converted to its type (text ↔ list, list →
Markdown bullets, number parsing…). Enum values are matched by value, label or meaning
(`fixed` → *Solved*, `not_fixed` → *Not solved*, `true` → *Solved*). Collections with the same id
are kept; for the others you choose a target collection (e.g. *Findings* → *Issues*) and the
title field is renamed when needed. A summary is shown before anything is written. Values the new
type has no field for stay in the files, hidden, so switching back loses nothing, unless you pick
*… and Remove Unused Values*.

## Exporting data

**Export Data…** (Report view, Explorer menu on `report.yaml`, or the command palette) writes to
`out/`, with placeholders resolved:

| Format | Content |
|---|---|
| Excel (`.xlsx`) | A *Report* sheet with the details and counts by severity, then one sheet per collection: frozen header, filters, coloured severity and status cells. |
| CSV | One collection, UTF-8 with BOM (opens correctly in Excel), multi-line cells quoted — for Jira, DefectDojo or spreadsheets. |
| JSON | The report, every collection with number, severity, score and resolved status, and the field definitions. |
| SARIF 2.1.0 | Findings as rules and results (`error`/`warning`/`note` from the severity, `security-severity` from CVSS, solved findings as `pass`). Locations come from `file`/`line` (code review), `affected` URLs — `POST /api/login` is resolved against the report target — and `hosts`. |

## Placeholders

Inside any text or Markdown field (code blocks are never evaluated):

```md
{{ report.client }} engaged us on {{ report.start_date | date }}.
This {{ finding.severity }} issue affects {{ report.target }}.
{{ collections.events | length }} events were reconstructed.
```

Variables: `report`, the current entry (`item` and its collection's `item_var`, e.g.
`finding` or `event`), `collections.<id>`, `stats`, `now`.
Filters: `date`, `datetime`, `markdown`, `yesno`, `where`, `sort_by`, `pluck`, `upper`…

## Templates

Designs that extend `base` need no HTML. To change one piece, add a file with the same name
to your design: `cover.html`, `item.html`, `item-<collection>.html`,
`collection-<collection>.html`, `summary-extra.html`. To start from a full copy use
**Copy Design to Workspace**. Templates are [Nunjucks](https://mozilla.github.io/nunjucks/);
helpers:

| Helper | Output |
|---|---|
| `toc(2)` | table of contents with page numbers |
| `render_field(obj, 'id')` | any field, formatted by type |
| `item_table(list, 'number,title,status')` | table of entries |
| `timeline(events, 'timestamp')` | chronological timeline |
| `chart(list, 'field', 'donut'\|'bar')`, `count_by(list, 'field')` | charts / counts by a field |
| `severity_chart()`, `status_chart()`, `finding_table()`, `badge()`, `cvss_table()` | security helpers |
| `ref('id')` | cross-reference with page number |
| `report_fields_in('before'\|'after'\|'details', report)`, `item_fields(item, 'meta'\|'body')` | generic sections |
| `pagebreak()`, `asset('logo.svg')`, `template_exists('x.html')`, `field_label()`, `fields_of()` | utilities |

Mermaid diagrams (` ```mermaid `) work in every Markdown field. Page layout uses CSS paged
media (`@page`, running headers, `target-counter`) through Paged.js — the preview and the PDF
use exactly the same HTML.

## Development

```bash
npm install
npm run build        # or F5 in VS Code (watch + Extension Development Host on examples/)
npm test             # core tests
npm run render:example
npm run package      # .vsix
```
