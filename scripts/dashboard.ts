/**
 * Open the dashboard of a run. Every run already builds its own at the end;
 * this rebuilds it (with the current report code) and opens it.
 *
 *   npm run dashboard              # latest run
 *   npm run dashboard -- <run id>  # a specific run (folder name under runs/)
 */
import 'dotenv/config';
import { exec } from 'node:child_process';
import { buildDashboard } from '../src/report/dashboard';

// Rebuild the dashboard for the given run (or the latest) from its calls.jsonl.
const file = buildDashboard(process.argv[2]);
if (!file) {
  console.error('No runs yet. Run `npm run bench` or `npm run p1` first.');
  process.exit(1);
}
console.log(`Wrote ${file}`);
// Open it in the default browser (macOS: open, Linux: xdg-open). Skipped on CI.
if (!process.env.CI) exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} ${file}`);
