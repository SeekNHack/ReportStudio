import { resolve, relative } from 'node:path';
import { build } from './core/build';
import { defaultRead } from './core/project';

const USAGE = `Usage: report-studio <project-dir> [--html] [--out <dir>] [--chrome <path>]`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const projectDir = resolve(args[0]);
  const out = await build({
    projectDir,
    extensionRoot: resolve(__dirname, '..'),
    format: args.includes('--html') ? 'html' : 'pdf',
    outDir: opt('--out'),
    chromePath: opt('--chrome'),
    read: defaultRead,
    log: (s) => console.log(s),
  });
  for (const i of out.issues) {
    const where = `${relative(process.cwd(), i.file)}${i.line ? `:${i.line}` : ''}`;
    console.log(`${i.severity.padEnd(7)} ${where}  ${i.message}`);
  }
  if (out.issues.some((i) => i.severity === 'error')) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(2);
});
