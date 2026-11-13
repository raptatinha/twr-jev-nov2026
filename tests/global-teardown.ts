import { buildDashboard } from '../src/report/dashboard';

/** After every Playwright run: build this run's dashboard (reports/dashboard-<run id>.html). */
export default async function globalTeardown(): Promise<void> {
  // Same run id as the tests (set in playwright.config.ts). No model calls in the run: no dashboard.
  const file = buildDashboard(process.env.RUN_ID);
  if (file) console.log(`\nDashboard: ${file}`);
}
