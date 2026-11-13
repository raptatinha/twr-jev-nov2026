/**
 * Debug a decision: why did a model answer what it answered?
 * Jev gives no explanation, so we look at what it DID give us: the full probability
 * distribution and the exact state it saw. Then we compare with the other models.
 *
 *   npm run why -- F12                 # every call about task F12 in the latest run
 *   npm run why -- F12 <run id>        # in a specific run (folder name under runs/)
 *   npm run why -- "book list"         # any part of a task id (Project 2 uses test titles)
 */
// Load .env (ROUTE_ACT etc.). No model is called: this only reads saved calls.
import 'dotenv/config';
import { readCalls } from '../src/meter';
import { CONFIDENCE_LEGEND, pct, usd } from '../src/report/stats';

// What to look for (part of a task id) and, optionally, which run.
const [query, runId] = process.argv.slice(2);
if (!query) {
  console.error('Usage: npm run why -- <task id> [run id]');
  process.exit(1);
}

// Every saved call whose task id contains the query, from the latest run by default.
const calls = readCalls(runId).filter((c) => c.task_id.includes(query));
if (calls.length === 0) {
  console.error(`No calls matching "${query}" in ${runId ? `run ${runId}` : 'the latest run'}.`);
  process.exit(1);
}

// Print each distinct state once: usually every model saw the same one.
const states = new Set(calls.map((c) => c.state).filter(Boolean));
for (const state of states) console.log(`\nSTATE the model saw:\n${'-'.repeat(60)}\n${state}\n${'-'.repeat(60)}`);

// Then one block per call: who answered what, how sure, and what it cost.
for (const c of calls) {
  // RIGHT / WRONG only when the right answer is known.
  const right = c.correct === undefined || c.correct === null ? '' : c.correct ? '  RIGHT' : `  WRONG (expected ${c.expected})`;
  console.log(`\n${c.experiment} · ${c.task_id} · ${c.model}${c.route_path ? ` · route: ${c.route_path}` : ''}`);
  if (c.error) {
    console.log(`  error: ${c.error}`);
    continue;
  }
  console.log(`  answer: ${c.answer}${right}`);
  if (c.confidence !== null) console.log(`  confidence: ${c.confidence.toFixed(2)}${c.confidence_self_reported ? ' (self-reported by the LLM)' : ' (calibrated)'}`);
  if (c.probabilities) {
    // Jev only: every option, most likely first.
    const sorted = Object.entries(c.probabilities).sort((a, b) => b[1] - a[1]);
    console.log(`  probabilities: ${sorted.map(([k, v]) => `${k} ${pct(v)}`).join(' · ')}`);
    const [first, second] = sorted;
    // Less than 15 points between the top two: a close call, and a hint on what to fix.
    if (second && first[1] - second[1] < 0.15) {
      console.log(`  -> close call between "${first[0]}" and "${second[0]}": the question or the state doesn't separate them. Split the question or add the missing context.`);
    }
  }
  if (c.reason) console.log(`  LLM reason: ${c.reason}`);
  console.log(`  ${c.latency_ms} ms · ${c.input_tokens} in / ${c.output_tokens} out tokens · ${usd(c.cost_usd)}`);
}

// What the two kinds of confidence above mean.
console.log(`\n${CONFIDENCE_LEGEND}`);
