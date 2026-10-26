const assert = require('node:assert');
const { existsSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.stack || e}`);
    throw e;
  }
}

exports.run = async function () {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'report-studio');
  assert.ok(ext, 'extension found');
  const api = await ext.activate();
  const examples = vscode.workspace.workspaceFolders[0].uri.fsPath;

  await step('discovers both example projects', async () => {
    for (let i = 0; i < 40 && api.projects.projects.length < 2; i++) await sleep(100);
    assert.deepStrictEqual(api.projects.projects.map((p) => p.split(/[\\/]/).pop()).sort(), ['demo-engagement', 'incident-2026']);
  });

  await step('registers all commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['reportStudio.buildPdf', 'reportStudio.newItem', 'reportStudio.newDesign', 'reportStudio.editDesign', 'reportStudio.openPreview', 'reportStudio.exportHtml', 'reportStudio.exportData', 'reportStudio.switchDesign', 'reportStudio.newReportFrom'])
      assert.ok(all.includes(c), c);
  });

  const ir = join(examples, 'incident-2026');
  await step('loads the generic incident design', async () => {
    api.projects.setActive(ir);
    const loaded = api.projects.load(ir);
    assert.ok(loaded.design, loaded.error && loaded.error.message);
    assert.deepStrictEqual(loaded.design.collections.map((c) => c.id), ['events', 'iocs', 'actions']);
  });

  await step('opens an entry with the form editor', async () => {
    await vscode.commands.executeCommand('reportStudio.openFinding', vscode.Uri.file(join(ir, 'events', '01-vpn-login.md')));
    await sleep(1500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab.input instanceof vscode.TabInputCustom, 'custom editor');
    assert.strictEqual(tab.input.viewType, 'reportStudio.findingForm');
  });

  await step('opens report.yaml and design.yaml with their editors', async () => {
    await vscode.commands.executeCommand('reportStudio.openReport');
    await sleep(800);
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab.input.viewType, 'reportStudio.reportForm');
    const designFile = join(ext.extensionPath, 'designs', 'incident-response', 'design.yaml');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(designFile), 'reportStudio.designEditor');
    await sleep(800);
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab.input.viewType, 'reportStudio.designEditor');
  });

  await step('opens the live preview', async () => {
    await vscode.commands.executeCommand('reportStudio.openPreview');
    await sleep(1500);
    const found = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && t.label.startsWith('Preview')));
    assert.ok(found, 'preview tab');
  });

  await step('exports HTML', async () => {
    const out = join(ir, 'out');
    rmSync(out, { recursive: true, force: true });
    await vscode.commands.executeCommand('reportStudio.exportHtml');
    const file = join(out, 'northwind-logistics-ransomware-incident-report.html');
    assert.ok(existsSync(file), 'html written');
    assert.ok(readFileSync(file, 'utf8').includes('timeline-events'));
  });

  await step('exports data as JSON and Excel', async () => {
    const out = join(ir, 'out');
    vscode.commands.executeCommand('reportStudio.exportData', 'json');
    vscode.commands.executeCommand('reportStudio.exportData', 'xlsx');
    const json = join(out, 'northwind-logistics-ransomware-incident-report.json');
    const xlsx = join(out, 'northwind-logistics-ransomware-incident-report.xlsx');
    for (let i = 0; i < 30 && !(existsSync(json) && existsSync(xlsx)); i++) await sleep(200);
    const data = JSON.parse(readFileSync(json, 'utf8'));
    assert.ok(data.collections.some((c) => c.id === 'events' && c.items.length), 'events exported');
    assert.strictEqual(readFileSync(xlsx).subarray(0, 2).toString(), 'PK');
  });

  await step('reports problems in the Problems panel', async () => {
    const report = vscode.Uri.file(join(ir, 'report.yaml'));
    const doc = await vscode.workspace.openTextDocument(report);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(report, new vscode.Range(0, 0, doc.lineCount, 0), doc.getText().replace(/^incident_id: .*$/m, 'incident_id: ""'));
    await vscode.workspace.applyEdit(edit);
    let diags = [];
    for (let i = 0; i < 30 && !diags.length; i++) {
      await sleep(200);
      diags = vscode.languages.getDiagnostics(report);
    }
    assert.ok(diags.some((d) => d.message.includes('Incident ID')), JSON.stringify(diags.map((d) => d.message)));
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });
};
