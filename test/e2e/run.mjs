// End-to-end smoke test in a real VS Code (downloaded by @vscode/test-electron).
import { runTests } from '@vscode/test-electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, 'test', 'e2e', 'suite.cjs'),
  launchArgs: [join(root, 'examples'), '--disable-extensions', '--disable-workspace-trust', '--no-sandbox'],
});
