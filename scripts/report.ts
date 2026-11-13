/**
 * Open a Playwright HTML report. Each test run keeps its own: playwright-report/<run id>/.
 *
 *   npm run report                 # the latest run
 *   npm run report -- <run id>     # a specific run (or part of its name, e.g. "p1")
 *   npm run report -- --list       # list the reports
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Every report folder that has an index.html, newest first.
const ROOT = 'playwright-report';
const reports = existsSync(ROOT)
  ? readdirSync(ROOT)
      .filter((d) => existsSync(join(ROOT, d, 'index.html')))
      .sort((a, b) => statSync(join(ROOT, b)).mtimeMs - statSync(join(ROOT, a)).mtimeMs)
  : [];

// Optional: a run id, part of one ("p1"), or --list.
const arg = process.argv[2];
if (reports.length === 0) {
  console.error('No reports yet. Run a Playwright project first (npm run p1, p2 or p3).');
  process.exit(1);
}
if (arg === '--list') {
  console.log(reports.join('\n'));
  process.exit(0);
}
// An exact match first, then the newest report whose name contains the text. No argument: the newest.
const chosen = arg ? reports.find((r) => r === arg) ?? reports.find((r) => r.includes(arg)) : reports[0];
if (!chosen) {
  console.error(`No report matching "${arg}". Available:\n${reports.join('\n')}`);
  process.exit(1);
}
console.log(`Opening ${join(ROOT, chosen)}`);
// Hand over to Playwright's own report server (it opens the browser).
spawn('npx', ['playwright', 'show-report', join(ROOT, chosen)], { stdio: 'inherit' });
