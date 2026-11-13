import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent, ACT_THRESHOLD, type AgentRun, type Goal } from '../src/agent/agent';
import { RUNS_DIR, runId } from '../src/meter';
import { models } from '../src/models';
import { usd } from '../src/report/stats';
import { expect, test } from './fixtures';

/**
 * Project 3: a simple hybrid agent, compared with an LLM-only agent on the same task.
 * Start: the DemoQA home page. The agent has to find the Book Store, then the right book.
 *
 *   npm run p3                     one run per mode
 *   AGENT_RUNS=3 npm run p3        three runs per mode (better comparison)
 */
// The task, in words, plus the rubric Jev checks at every step to know when it's done.
const GOAL: Goal = {
  text: 'Find out who publishes the book written by Addy Osmani: open that book\'s details page.',
  rubric: {
    onDetails: 'The page shows the details of one single book (ISBN, title, author, publisher), not a list of books.',
    rightBook: 'The book shown on this page was written by Addy Osmani.',
  },
};
// Runs per mode. More runs smooth out the luck of a single run.
const RUNS = Number(process.env.AGENT_RUNS || 1);
// The LLM: every step in llm-only mode, unsure steps in hybrid mode.
const strong = models()[(process.env.ROUTE_STRONG || 'opus') as 'opus'];
// Saved to disk, not kept in memory: a failed test restarts the worker and would lose them.
const resultsFile = () => join(RUNS_DIR, runId(), 'agent-runs.jsonl');
const saveRun = (run: AgentRun) => {
  mkdirSync(join(RUNS_DIR, runId()), { recursive: true });
  appendFileSync(resultsFile(), `${JSON.stringify(run)}\n`);
};
// Read back every run saved so far in this run's folder.
const loadRuns = (): AgentRun[] =>
  existsSync(resultsFile()) ? readFileSync(resultsFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentRun) : [];

test.describe('E2E: hybrid agent vs. LLM-only agent', () => {
  test.skip(!models().jev.available() || !strong.available(), `Needs JEV_API_KEY and the key for ${strong.label}`);

  for (const mode of ['hybrid', 'llm-only'] as const) {
    // One test per mode and per run: hybrid run 1, llm-only run 1, ...
    for (let i = 1; i <= RUNS; i++) {
      test(`${mode} agent, run ${i}`, { tag: '@p3' }, async ({ page }, testInfo) => {
        // Start from the DemoQA home page (baseURL in playwright.config.ts).
        await page.goto('/');
        const run = await runAgent(page, GOAL, mode, { taskId: `${mode}-${i}` });
        // Ground truth, checked by plain Playwright (not by a model): are we on Addy Osmani's book?
        run.verified = /search=9781449331818/.test(page.url()) && (await page.getByText('Addy Osmani').isVisible());
        saveRun(run);

        // One annotation per step: what was clicked, who decided, confidence, time and cost.
        for (const s of run.steps) {
          testInfo.annotations.push({
            type: `step ${s.step} (${s.decidedBy})`,
            description: `${s.action}${s.confidence !== null ? ` · confidence ${s.confidence.toFixed(2)} (${s.decidedBy === 'jev' ? 'calibrated' : 'self-reported'})` : ''} · ${s.ms} ms · ${usd(s.costUsd)}`,
          });
        }
        testInfo.annotations.push({ type: 'total', description: `${run.steps.length} steps · Jev calls ${run.jevCalls} · LLM calls ${run.llmCalls} · ${run.ms} ms · ${usd(run.costUsd)}` });

        // The agent must believe it's done AND Playwright must confirm it: right book page, author visible.
        expect(run.done, 'the agent should decide it reached the goal').toBe(true);
        await expect(page).toHaveURL(/search=9781449331818/);
        await expect(page.getByText('Addy Osmani')).toBeVisible();
      });
    }
  }

  // The last test: averages per mode, from the saved runs.
  test('Summary: hybrid vs. LLM-only', { tag: '@p3' }, async ({}, testInfo) => {
    const results = loadRuns();
    test.skip(results.length === 0, 'No agent runs recorded');
    for (const mode of ['hybrid', 'llm-only'] as const) {
      const runs = results.filter((r) => r.mode === mode);
      if (runs.length === 0) continue;
      // Average of any number over this mode's runs.
      const avg = (f: (r: AgentRun) => number) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
      testInfo.annotations.push({
        type: mode,
        description: `reached the goal ${runs.filter((r) => r.verified).length}/${runs.length} (agent said done: ${runs.filter((r) => r.done).length}) · avg ${avg((r) => r.steps.length).toFixed(1)} steps · avg ${Math.round(avg((r) => r.ms))} ms · avg ${usd(avg((r) => r.costUsd))} · LLM calls ${avg((r) => r.llmCalls).toFixed(1)} per run`,
      });
    }
    testInfo.annotations.push({ type: 'policy', description: `hybrid acts on its own when Jev confidence >= ${ACT_THRESHOLD}; LLM model: ${strong.label}` });
  });
});
