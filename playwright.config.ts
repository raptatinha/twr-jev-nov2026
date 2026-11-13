import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
import { labelFromArgs, makeRunId } from './src/run-id';

/**
 * One run id for the whole test run, e.g. "2026-11-09_20-15-33_p1". Set here, in the main
 * process, so every worker writes to the same runs/<id>/calls.jsonl, and the HTML report
 * goes to playwright-report/<id>/ instead of overwriting the last one.
 */
process.env.RUN_ID ??= makeRunId(labelFromArgs(process.argv));

export default defineConfig({
  testDir: './tests',
  // Every run builds its own dashboard at the end: reports/dashboard-<run id>.html
  globalTeardown: './tests/global-teardown.ts',
  // Model calls take seconds; an agent run can take a minute.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // Tests in a file run in order, so each project's summary test runs last.
  fullyParallel: false,
  workers: process.env.CI ? 1 : 3,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `playwright-report/${process.env.RUN_ID}` }]],
  use: {
    baseURL: 'https://demoqa.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Project 1 calls APIs only: no browser.
    { name: 'p1-cut-costs', testMatch: /p1-.*\.spec\.ts/ },
    { name: 'p2-explore', testMatch: /p2-.*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'p3-agent', testMatch: /p3-.*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
});
