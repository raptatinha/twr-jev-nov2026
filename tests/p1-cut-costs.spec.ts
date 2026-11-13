import { decide, readCalls } from '../src/meter';
import { availableModels, models } from '../src/models';
import { renderReport } from '../src/report/html';
import { pct, roleLabel, statsByModel, usd } from '../src/report/stats';
import { summarize } from '../src/report/summary';
import { policyFromEnv, route } from '../src/route';
import { sample } from '../src/triage/dataset';
import { TRIAGE_QUESTION, failureState } from '../src/triage/question';
import { expect, test } from './fixtures';

/**
 * Project 1: Cut AI Costs. Measure, Route and Cascade.
 *
 * One test per test failure. Each test:
 *   BEFORE: asks the strong model (the "send everything to the best model" pipeline)
 *   AFTER:  asks route(task): Jev first, escalate only when Jev is unsure
 * The numbers land in the test annotations, and the last test attaches the before/after report.
 *
 *   npm run p1                 then   npm run report
 *   SAMPLE=12 npm run p1       (a quicker run for class)
 */
// The router settings from .env: thresholds, cheap and strong models.
const policy = policyFromEnv();
/**
 * For the "each LLM alone vs. with Jev" comparison, every other LLM with a key also answers each
 * failure on its own. COMPARE_ALL_LLMS=false skips them: faster and cheaper, for a quick demo.
 */
const compareAll = process.env.COMPARE_ALL_LLMS !== 'false';
// The LLMs used only for the comparison: every LLM with a key except the strong one (it's already the "before").
const others = availableModels().filter((m) => m.key !== 'jev' && m.model !== policy.strong.model);
// The three models the router needs. Any missing key skips the whole project with a clear message.
const missing = [models().jev, policy.cheap, policy.strong].filter((m) => !m.available()).map((m) => m.label);

test.describe(`Project 1: route(task) vs. ${policy.strong.model} only`, () => {
  test.skip(missing.length > 0, `Missing API keys for: ${missing.join(', ')} (see .env.example)`);

  // One Playwright test per failure (all 48, or SAMPLE). The test title shows its id and name.
  for (const failure of sample()) {
    test(`${failure.id} ${failure.test}`, { tag: '@p1' }, async ({}, testInfo) => {
      const state = failureState(failure);
      // The same state and question for before and after: a fair comparison.
      const task = { id: failure.id, state, question: TRIAGE_QUESTION, expected: failure.label };

      // BEFORE: the "send everything to the best model" pipeline.
      const before = await test.step(`Before: ask ${policy.strong.model}`, async () =>
        (await decide(policy.strong, state, TRIAGE_QUESTION, { experiment: 'baseline', taskId: failure.id, expected: failure.label })).record,
      );

      // AFTER: Jev first, an LLM only when Jev is unsure.
      const after = await test.step('After: route(task)', () => route(task, policy));

      // Extra: the other LLMs alone on the same failure, for the "each LLM alone vs. with Jev" table.
      if (compareAll && others.length > 0) {
        await test.step(`For the comparison: ${others.map((m) => m.model).join(', ')} alone`, () =>
          Promise.allSettled(others.map((m) => decide(m, state, TRIAGE_QUESTION, { experiment: 'baseline-other', taskId: failure.id, expected: failure.label }))),
        );
      }

      // Annotations: the numbers show up under the test in the Playwright report.
      const note = (type: string, description: string) => testInfo.annotations.push({ type, description });
      note('expected', failure.label + (failure.ambiguous ? ' (ambiguous case)' : ''));
      note('before', `${before.answer} · ${before.latency_ms} ms · ${usd(before.cost_usd)} · ${before.input_tokens} in / ${before.output_tokens} out tokens`);
      note('answered by', `${after.calls[after.calls.length - 1].model}${after.jevConfidence !== null ? ` (Jev confidence ${after.jevConfidence.toFixed(2)}, calibrated)` : ''}`);
      note('after', `${after.label} · ${after.latencyMs} ms · ${usd(after.costUsd)}`);
      if (after.overheadUsd > 0) note('router overhead', `${usd(after.overheadUsd)} · ${after.overheadMs} ms (Jev call before escalating)`);
      const jevCall = after.calls[0];
      if (jevCall.probabilities) {
        note('Jev probabilities', Object.entries(jevCall.probabilities).map(([k, v]) => `${k} ${pct(v)}`).join(', '));
      }
      // Attach the raw calls to the test, so the report shows exactly what was sent and received.
      await testInfo.attach('model calls (JSON lines)', {
        body: [before, ...after.calls].map((c) => JSON.stringify(c)).join('\n'),
        contentType: 'application/json',
      });

      // Decision quality is part of the result: a wrong routed answer turns the row red.
      expect.soft(after.label, `route(task) answered "${after.label}", expected "${failure.label}"`).toBe(failure.label);
    });
  }

  // The last test: turns this run's calls into the before/after page and attaches it.
  test('Summary: before vs. after', { tag: '@p1' }, async ({}, testInfo) => {
    // Only this run's Project 1 calls. Works across workers: they all write to the same calls.jsonl.
    const calls = readCalls(process.env.RUN_ID).filter((c) => ['baseline', 'baseline-other', 'routed'].includes(c.experiment));
    test.skip(calls.length === 0, 'No calls recorded in this run');

    const summary = summarize(calls);
    const html = renderReport({
      title: 'Project 1: before vs. after',
      subtitle: `Run ${process.env.RUN_ID} · Jev alone at confidence ≥ ${policy.act} · ${policy.cheap.model} for ${policy.escalate}–${policy.act} · ${policy.strong.model} below ${policy.escalate} · before: ${policy.strong.model} for everything`,
      summary,
      // Before (the strong model) and after (every model route(task) called), one row each.
      models: statsByModel(calls, roleLabel),
      act: policy.act,
    });
    // Open this attachment in the report: the full before/after page with charts.
    await testInfo.attach('before-vs-after.html', { body: html, contentType: 'text/html' });

    // The headline numbers also go in as annotations, readable without opening the page.
    const { baseline, routed, split } = summary;
    if (baseline && routed) {
      testInfo.annotations.push(
        { type: 'cost per 1,000 decisions', description: `${usd(baseline.costPer1k)} -> ${usd(routed.costPer1k)}` },
        { type: 'accuracy', description: `${pct(baseline.accuracy)} -> ${pct(routed.accuracy)}` },
        { type: 'typical latency', description: `${baseline.medianMs} ms -> ${routed.medianMs} ms` },
        { type: 'routed', description: `Jev ${split.jev} · cheap ${split.cheap} · strong ${split.strong}` },
      );
    }
  });
});
