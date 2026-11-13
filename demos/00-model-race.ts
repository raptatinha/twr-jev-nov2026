/**
 * Demo 0: the model race.
 * The SAME question goes to every model whose key is in .env, at the same time.
 * Watch who answers first, how many tokens each one spent, and what it cost.
 *
 *   npm run race            # failure F37 (a flaky test)
 *   npm run race -- F12     # any failure id from src/triage/dataset.ts
 *
 * WHERE THE DATA COMES FROM
 *   Not from a previous Playwright run. The failures live in src/triage/dataset.ts:
 *   48 test failures written by hand to look like real ones (test name, error message,
 *   pass/fail history, sometimes a bit of context such as a recent commit), each with the
 *   label a senior QA engineer would give. Project 1 uses the same 48.
 *   The default, F37, is a cart test that fails now and then with no code change: "flaky".
 *
 * WHAT A RUN PRODUCES
 *   runs/<run id>/calls.jsonl        one JSON line per model call (time, tokens, cost, answer)
 *   reports/dashboard-<run id>.html  the dashboard for this run
 *   The run id is the date and time plus "race", e.g. 2026-11-09_20-15-33_race.
 */

// ---------------------------------------------------------------------------------------------
// 1. Name this run.
// Every file this run writes is named after the run id, and the id ends with this label.
// `??=` keeps a label you set yourself (RUN_LABEL=... npm run race).
// Note: the imports below are loaded before this line runs, but that's fine: the run id is
// only built the first time a call is measured, and by then the label is set.
// ---------------------------------------------------------------------------------------------
process.env.RUN_LABEL ??= 'race';

// ---------------------------------------------------------------------------------------------
// 2. Imports. Everything the race needs, each with one job:
// ---------------------------------------------------------------------------------------------
import { buildDashboard } from '../src/report/dashboard'; // writes reports/dashboard-<run id>.html
import { decide } from '../src/meter'; // asks one model one "pick an option" question, and measures it
import { availableModels } from '../src/models'; // Jev, Opus, Astra, Grok: only the ones with a key in .env
import { CONFIDENCE_LEGEND, pct, statsByModel, textTable, usd } from '../src/report/stats'; // formatting, the summary table, the confidence legend
import { stopTelemetry } from '../src/telemetry'; // flushes OpenTelemetry spans (only does something when it's on)
import { FAILURES } from '../src/triage/dataset'; // the 48 hand-labelled test failures
import { TRIAGE_QUESTION, failureState } from '../src/triage/question'; // the question, and how a failure becomes the state

// ---------------------------------------------------------------------------------------------
// 3. Pick the failure to race on.
// `npm run race -- F12` puts "F12" in process.argv[2]. With no argument we use F37 (flaky).
// An unknown id stops the demo here, before any model is called (and before anything costs money).
// ---------------------------------------------------------------------------------------------
const failure = FAILURES.find((f) => f.id === (process.argv[2] ?? 'F37'));
if (!failure) throw new Error(`No failure with id ${process.argv[2]}`);

// ---------------------------------------------------------------------------------------------
// 4. Find out which models can run.
// A model joins the race only if its API key is in .env (JEV_API_KEY, ANTHROPIC_API_KEY,
// OPENAI_API_KEY, XAI_API_KEY). With no key at all there's nothing to race, so we stop with a hint.
// ---------------------------------------------------------------------------------------------
const models = availableModels();
if (models.length === 0) {
  console.error('No API keys found. Copy .env.example to .env and add at least one key.');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// 5. Build the state and show it.
// The state is the only thing the models see about the failure: test name, error, recent runs
// (P = pass, F = fail, oldest to newest) and the optional context. Printing it first lets the
// audience read the same facts the models get, and guess the answer themselves.
// ---------------------------------------------------------------------------------------------
const state = failureState(failure);
console.log(`\n${state}\n\nQuestion: ${TRIAGE_QUESTION.instructions}\nRacing: ${models.map((m) => m.label).join(', ')}\n`);

// ---------------------------------------------------------------------------------------------
// 6. The race itself.
// All models are called at the same time (models.map starts every call before any finishes).
// Each line is printed the moment THAT model answers, so the order on screen is the finishing order.
//
// decide() does the measuring for us. For each call it:
//   - times it (wall clock, so it includes the network, like your users feel it),
//   - reads the tokens from the vendor's own `usage` field (reasoning tokens count as output),
//   - turns tokens into dollars with src/prices.ts,
//   - writes one line to runs/<run id>/calls.jsonl.
// The meta object tags that line: which experiment, which failure, and the right answer,
// so the summary can compute accuracy.
//
// Promise.allSettled (not Promise.all): if one vendor is down, the others still finish the race.
// ---------------------------------------------------------------------------------------------
const started = performance.now();
const results = await Promise.allSettled(
  models.map(async (model) => {
    const { record } = await decide(model, state, TRIAGE_QUESTION, { experiment: 'race', taskId: failure.id, expected: failure.label });

    // Seconds since the race started: when this model crossed the finish line.
    const t = ((performance.now() - started) / 1000).toFixed(2);

    // Jev's confidence is calibrated: it comes from its probabilities.
    // The LLMs have no calibrated number, so we ask them to rate their own confidence:
    // "self-reported". Same field, very different meaning, so we label it.
    const confidence = record.confidence === null ? '' : ` | confidence ${record.confidence.toFixed(2)}${record.confidence_self_reported ? ' (self-reported)' : ' (calibrated)'}`;

    // One line per model: time, model, answer, confidence, tokens in/out, cost of this one call.
    console.log(`  ${t}s  ${model.label.padEnd(16)} -> ${String(record.answer).padEnd(12)}${confidence} | ${record.input_tokens} in / ${record.output_tokens} out tokens | ${usd(record.cost_usd)}`);
    return record;
  }),
);

// ---------------------------------------------------------------------------------------------
// 7. Report the models that failed.
// A rejected call (bad key, timeout, vendor error) is listed by name instead of stopping the demo.
// The error is also saved in calls.jsonl by decide(), so the dashboard shows it too.
// ---------------------------------------------------------------------------------------------
for (const [i, r] of results.entries()) {
  if (r.status === 'rejected') console.log(`  ${models[i].label}: ERROR ${(r.reason as Error).message}`);
}

// What "(calibrated)" and "(self-reported)" mean, right under the lines that use them.
console.log(`\n${CONFIDENCE_LEGEND}`);

// ---------------------------------------------------------------------------------------------
// 8. The summary.
// Keep only the calls that succeeded, then reveal the right answer (the hand-made label) and
// print one row per model: latency, tokens, cost per 1,000 decisions, accuracy, parse failures.
// ---------------------------------------------------------------------------------------------
const records = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
console.log(`\nExpected answer: ${failure.label}\n`);
console.log(textTable(statsByModel(records)));

// Jev returns a probability for EVERY option, not just the winner. Printing them shows how sure
// it was, and what came second: a close second means the options overlap (see F12).
const jevRecord = records.find((r) => r.model_key === 'jev');
if (jevRecord?.probabilities) {
  console.log('\nJev probabilities:', Object.entries(jevRecord.probabilities).map(([k, v]) => `${k} ${pct(v)}`).join(', '));
}

// ---------------------------------------------------------------------------------------------
// 9. Where to look next.
// The raw lines are in calls.jsonl; buildDashboard() turns them into an HTML page and returns
// its path. stopTelemetry() sends any OpenTelemetry data still waiting (a no-op when it's off),
// so the script can exit cleanly.
// ---------------------------------------------------------------------------------------------
console.log(`\nSaved to runs/${process.env.RUN_ID}/calls.jsonl`);
console.log(`Dashboard: ${buildDashboard(process.env.RUN_ID)}`);
await stopTelemetry();
