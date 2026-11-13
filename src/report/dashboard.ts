import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCalls } from '../meter';
import { renderReport } from './html';
import { roleLabel, statsByModel } from './stats';
import { summarize } from './summary';


/**
 * Build reports/dashboard-<run id>.html for one run. Called automatically at the end of every
 * run (scripts and Playwright), and by `npm run dashboard`. Returns the file path, or null if the run
 * made no model calls.
 */
export function buildDashboard(runId?: string): string | null {
  // Every call of the run (the latest run when no id is given). No calls: no dashboard.
  const calls = readCalls(runId);
  if (calls.length === 0) return null;
  // The run id comes from the data itself, so it also works for the latest run.
  const id = calls[0].run_id;
  // Project 1 runs get a cost-focused title; anything else is "Run results".
  const costRun = calls.some((c) => ['bench', 'baseline', 'routed'].includes(c.experiment));
  const html = renderReport({
    title: costRun ? 'Cut AI costs: results' : 'Run results',
    subtitle: `Run ${id} · ${calls.length} model calls · experiments: ${[...new Set(calls.map((c) => c.experiment))].join(', ')}`,
    // The before/after numbers (Project 1) and per-experiment summaries.
    summary: summarize(calls),
    // One row per model and role, for every kind of call the run made.
    models: statsByModel(calls, roleLabel),
    // The router's threshold, drawn as a line on the threshold and calibration charts.
    act: Number(process.env.ROUTE_ACT || 0.8),
  });
  // Write it to reports/dashboard-<run id>.html and return the path.
  mkdirSync('reports', { recursive: true });
  const file = join('reports', `dashboard-${id}.html`);
  writeFileSync(file, html);
  return file;
}
