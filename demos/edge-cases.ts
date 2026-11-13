/**
 * Where it breaks: numbers, double negatives, no right option, adversarial input.
 * Each edge case goes to Jev and to the strong LLM. Read the results one by one.
 *
 *   npm run edges
 */
// Name this run "..._edges". The run id itself is built on the first measured call.
process.env.RUN_LABEL ??= 'edges';
import { buildDashboard } from '../src/report/dashboard';
import { decide } from '../src/meter';
import { jev, modelByKey } from '../src/models';
import { CONFIDENCE_LEGEND, pct } from '../src/report/stats';
import { stopTelemetry } from '../src/telemetry';
import { EDGE_CASES } from '../src/triage/edge-cases';
import { TRIAGE_QUESTION, failureState } from '../src/triage/question';

// The router's threshold: at or above it, Project 1 would trust Jev's answer without escalating.
const ACT = Number(process.env.ROUTE_ACT || 0.8);
// Two contestants: Jev and the strong LLM (whichever have a key). Jev is required.
const strong = modelByKey(process.env.ROUTE_STRONG || 'opus');
const models = [jev(), strong].filter((m) => m.available());
if (!jev().available()) {
  console.error('JEV_API_KEY is not set (see .env.example).');
  process.exit(1);
}

// One block per edge case: what it is, the right answer, then each model's answer and a verdict.
for (const edge of EDGE_CASES) {
  // Same state format as the dataset. The label is only there to satisfy the type: failureState never uses it.
  const state = failureState({ ...edge, label: edge.label ?? 'flaky' });
  console.log(`\n${edge.id} · ${edge.kind} · expected: ${edge.label ?? 'none of the options (should be unsure)'}`);
  console.log(`  ${edge.why}`);
  // Both models at once. allSettled: one failing model doesn't stop the other.
  const results = await Promise.allSettled(
    models.map((m) => decide(m, state, TRIAGE_QUESTION, { experiment: 'edges', taskId: edge.id, expected: edge.label ?? undefined })),
  );
  for (const [i, r] of results.entries()) {
    const name = models[i].label.padEnd(16);
    if (r.status === 'rejected') {
      console.log(`  ${name} ERROR ${(r.reason as Error).message}`);
      continue;
    }
    const c = r.value.record;
    // No confidence counts as 0 (unsure).
    const conf = c.confidence ?? 0;
    // What the answer means for the router:
    //   no right option  -> sure is bad (it would be trusted), unsure is good (it would escalate)
    //   right            -> fine (for Jev, below the threshold it would still escalate)
    //   wrong            -> sure is the dangerous case; unsure is fine, it escalates
    const verdict =
      edge.label === null
        ? conf >= ACT
          ? 'TOO SURE: would be trusted, but no option is right'
          : 'ok: unsure, would escalate'
        : c.correct
          ? conf >= ACT || c.model_key !== 'jev'
            ? 'right'
            : 'right, but would escalate'
          : conf >= ACT
            ? 'WRONG AND SURE: the dangerous case'
            : 'wrong, but unsure: would escalate';
    // Jev only: its two most likely options, to show how close the call was.
    const probs = c.probabilities
      ? ' · ' + Object.entries(c.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${pct(v)}`).join(', ')
      : '';
    console.log(`  ${name} ${String(c.answer).padEnd(12)} conf ${conf.toFixed(2)}${c.confidence_self_reported ? ' (self)' : ''}${probs}  -> ${verdict}`);
  }
}

console.log(`\nThresholds: Jev answers alone at confidence >= ${ACT}. Debug any case with: npm run why -- <id>`);
// "(self)" in the lines above is short for self-reported: explain both kinds once.
console.log(`\n${CONFIDENCE_LEGEND}`);
console.log(`Dashboard: ${buildDashboard(process.env.RUN_ID)}`);
await stopTelemetry();
