/**
 * Project 1, step 1: MEASURE.
 * Runs the triage dataset on every model with a key, a few times each, and prints the table.
 * The output (runs/<id>/calls.jsonl) feeds the dashboard and the threshold sweep.
 *
 *   npm run bench                 # all models, SAMPLE items, 1 repeat
 *   npm run bench -- --repeat 3   # 3 runs per item (steadier typical times)
 *   npm run bench -- --models jev,opus
 */
// Name this run "..._bench". The run id itself is built later, on the first measured call.
process.env.RUN_LABEL ??= 'bench';
import { buildDashboard } from '../src/report/dashboard';
import { BudgetExceededError, budgetUsd, decide } from '../src/meter';
import { availableModels } from '../src/models';
import { statsByModel, textTable } from '../src/report/stats';
import { stopTelemetry } from '../src/telemetry';
import { sample } from '../src/triage/dataset';
import { TRIAGE_QUESTION, failureState } from '../src/triage/question';
import { readCalls } from '../src/meter';

// Read the optional flags: --repeat N and --models jev,opus.
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// How many times each failure is asked (more repeats = steadier typical times).
const repeat = Number(flag('repeat') ?? 1);
const only = flag('models')?.split(',');
// Every model with a key in .env, narrowed by --models when given.
const models = availableModels().filter((m) => !only || only.includes(m.key));
if (models.length === 0) throw new Error('No models to run. Check your keys in .env (and --models).');

// The failures to run: all 48, or SAMPLE from .env, with a fair mix of categories.
const items = sample();
console.log(`Benchmark: ${items.length} failures x ${models.length} models x ${repeat} repeat(s)\n`);

// Warm-up: one call per model, not counted (first calls pay for TLS and connection setup).
await Promise.allSettled(models.map((m) => m.choose(failureState(items[0]), TRIAGE_QUESTION)));

// How many calls each model skipped because it hit its budget (BUDGET_USD_PER_MODEL).
const skipped = new Map<string, number>();
for (let r = 0; r < repeat; r++) {
  for (const item of items) {
    // Models run in parallel per item; items run one after the other to stay under rate limits.
    const results = await Promise.allSettled(
      models.map((m) => decide(m, failureState(item), TRIAGE_QUESTION, { experiment: 'bench', taskId: item.id, expected: item.label })),
    );
    // A budget stop is not an error to print on every item: count it, report it once at the end.
    results.forEach((res, i) => {
      if (res.status === 'rejected' && res.reason instanceof BudgetExceededError) skipped.set(models[i].label, (skipped.get(models[i].label) ?? 0) + 1);
    });
    // One dot per item, so you can see progress.
    process.stdout.write('.');
  }
}

// The summary table: only this run's benchmark calls (the warm-up wasn't measured).
console.log(`\n\n${textTable(statsByModel(readCalls(process.env.RUN_ID).filter((c) => c.experiment === 'bench')))}`);
for (const [label, n] of skipped) console.log(`\n${label}: ${n} call(s) skipped, budget of $${budgetUsd()} per model reached.`);
console.log(`\nSaved to runs/${process.env.RUN_ID}/calls.jsonl`);
// Build this run's dashboard, then flush OpenTelemetry (a no-op when it's off).
console.log(`Dashboard: ${buildDashboard(process.env.RUN_ID)}`);
await stopTelemetry();
