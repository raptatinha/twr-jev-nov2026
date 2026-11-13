import type { CallRecord } from '../meter';
import { median, percentile } from './stats';

/**
 * Project 1, step 4: COMPARE. Turns the JSON lines into the before/after numbers.
 * Used by the Playwright summary test and by `npm run dashboard`.
 */
// Totals for one setup (before or after): how many decisions, how right, how expensive, how fast.
export type Totals = {
  decisions: number;
  accuracy: number | null;
  costPer1k: number;
  medianMs: number;
  p95Ms: number;
};

// How many routed decisions ended at each tier: Jev alone, the cheap LLM, the strong LLM.
export type RouteSplit = { jev: number; cheap: number; strong: number };

/** The model that actually answered each route path in this run, read from the calls. */
export type PathModels = { jev: string | null; cheap: string | null; strong: string | null };

// One point of the threshold chart: at this threshold, what accuracy and cost would we get, and how much escalates.
export type SweepPoint = { threshold: number; accuracy: number; costPer1k: number; escalated: number };

/** One setup in the per-LLM comparison: an LLM alone, or the same LLM behind Jev. */
export type PairSetup = { accuracy: number; costPer1k: number; medianMs: number; p95Ms: number; escalated: number | null };
export type Pair = { model: string; tasks: number; alone: PairSetup; withJev: PairSetup };

// One bar of the calibration chart: answers with confidence between `from` and `to`, and how often they were right.
export type CalibrationBucket = { from: number; to: number; count: number; accuracy: number | null };

/** Everything the before/after page and the dashboard need, computed in one pass over the calls. */
export type Summary = {
  baseline: Totals | null;
  baselineModel: string | null;
  routed: Totals | null;
  split: RouteSplit;
  pathModels: PathModels;
  /** The model the threshold sweep escalates to (the replay's second tier). */
  sweepModel: string | null;
  /** Share of routed cost spent on Jev calls that ended up escalated anyway. */
  overheadUsdPer1k: number;
  sweep: SweepPoint[];
  calibrationJev: CalibrationBucket[];
  calibrationLlm: CalibrationBucket[];
  calibrationLlmModel: string | null;
  /** Each LLM alone vs. Jev in front of it, replayed from a run where every model answered every task (the benchmark). */
  pairs: Pair[];
  pairsThreshold: number;
};

/**
 * For each LLM: "alone" = its own answers; "with Jev" = Jev's answer when Jev's confidence >= act,
 * otherwise Jev's call + that LLM's call. Replayed from saved answers: no new API calls.
 */
export function pairs(records: CallRecord[], act: number): Pair[] {
  // Benchmark runs: every model answered every task. Project 1 runs: "alone" answers come from
  // baseline + baseline-other, and Jev's answer is the first call of each routed decision.
  // Which kind of run is this? It decides where the "alone" and "Jev" answers come from.
  const isBench = records.some((r) => r.experiment === 'bench');
  // Only successful calls from the relevant experiments.
  const ok = records.filter((r) => !r.error && (isBench ? r.experiment === 'bench' : ['baseline', 'baseline-other', 'routed'].includes(r.experiment)));
  // Jev's answer per task, and every LLM call that wasn't part of a routed decision.
  const jevByTask = byTask(ok.filter((r) => r.model_key === 'jev'));
  const aloneCalls = ok.filter((r) => r.model_key !== 'jev' && r.experiment !== 'routed');
  const llms = [...new Set(aloneCalls.map((r) => r.model))];
  return llms.flatMap((model) => {
    const llmByTask = byTask(aloneCalls.filter((r) => r.model === model));
    // Compare only tasks both Jev and this LLM answered: a fair, like-for-like comparison.
    const tasks = [...llmByTask.keys()].filter((id) => jevByTask.has(id));
    if (tasks.length === 0) return [];
    // Turns a list of per-task outcomes into accuracy, cost per 1,000, typical and slow (1 in 20) latency, and escalation rate.
    const setup = (items: { correct: boolean; cost: number; ms: number; escalated: boolean }[], withEscalation: boolean): PairSetup => ({
      accuracy: items.filter((i) => i.correct).length / items.length,
      costPer1k: (items.reduce((s, i) => s + i.cost, 0) / items.length) * 1000,
      medianMs: median(items.map((i) => i.ms)),
      p95Ms: percentile(items.map((i) => i.ms), 95),
      escalated: withEscalation ? items.filter((i) => i.escalated).length / items.length : null,
    });
    // "Alone": the LLM's own answer, cost and time for every task.
    const alone = tasks.map((id) => {
      const l = llmByTask.get(id)!;
      return { correct: Boolean(l.correct), cost: l.cost_usd, ms: l.latency_ms, escalated: true };
    });
    // "With Jev": Jev's answer when it's sure enough. Otherwise BOTH calls are paid (Jev's, then the LLM's).
    const withJev = tasks.map((id) => {
      const j = jevByTask.get(id)!;
      const l = llmByTask.get(id)!;
      const jevAlone = (j.confidence ?? 0) >= act && j.answer !== null;
      return jevAlone
        ? { correct: Boolean(j.correct), cost: j.cost_usd, ms: j.latency_ms, escalated: false }
        : { correct: Boolean(l.correct), cost: j.cost_usd + l.cost_usd, ms: j.latency_ms + l.latency_ms, escalated: true };
    });
    return [{ model, tasks: tasks.length, alone: setup(alone, false), withJev: setup(withJev, true) }];
  });
}

// Shared math for the before/after totals.
function totals(items: { correct: boolean | null | undefined; cost: number; ms: number }[]): Totals | null {
  if (items.length === 0) return null;
  const graded = items.filter((i) => typeof i.correct === 'boolean');
  return {
    decisions: items.length,
    accuracy: graded.length ? graded.filter((i) => i.correct).length / graded.length : null,
    costPer1k: (items.reduce((s, i) => s + i.cost, 0) / items.length) * 1000,
    medianMs: median(items.map((i) => i.ms)),
    p95Ms: percentile(items.map((i) => i.ms), 95),
  };
}

/** First successful record per task id. */
function byTask(records: CallRecord[]): Map<string, CallRecord> {
  const map = new Map<string, CallRecord>();
  for (const r of records) if (!r.error && !map.has(r.task_id)) map.set(r.task_id, r);
  return map;
}

/**
 * The threshold sweep, computed from calls we already made (no extra API spend):
 * for each threshold, use Jev's answer when its confidence clears it, otherwise the escalation model's.
 */
export function sweep(jevRecords: CallRecord[], strongRecords: CallRecord[]): SweepPoint[] {
  const jevByTask = byTask(jevRecords);
  const strongByTask = byTask(strongRecords);
  const tasks = [...jevByTask.keys()].filter((id) => strongByTask.has(id));
  if (tasks.length === 0) return [];
  const points: SweepPoint[] = [];
  // Try every threshold from 0 to 1 in steps of 0.05 (the 0.0001 avoids floating-point skipping 1.0).
  for (let t = 0; t <= 1.0001; t += 0.05) {
    let correct = 0;
    let cost = 0;
    let escalated = 0;
    for (const id of tasks) {
      const j = jevByTask.get(id)!;
      const s = strongByTask.get(id)!;
      const useJev = (j.confidence ?? 0) >= t && j.answer !== null;
      // Jev is always paid; the escalation model only when Jev wasn't sure enough.
      cost += j.cost_usd + (useJev ? 0 : s.cost_usd);
      if (!useJev) escalated++;
      if ((useJev ? j : s).correct) correct++;
    }
    points.push({ threshold: Math.round(t * 100) / 100, accuracy: correct / tasks.length, costPer1k: (cost / tasks.length) * 1000, escalated: escalated / tasks.length });
  }
  return points;
}

/** Calibration: when the model says 0.8, is it right about 80% of the time? */
export function calibration(records: CallRecord[], score: (r: CallRecord) => number | null): CalibrationBucket[] {
  // Buckets: below 0.5, 0.5-0.6, ..., 0.9-1.0. A well-calibrated model is right about as often as its bucket says.
  const edges = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
  return edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1];
    const inBucket = records.filter((r) => {
      const s = score(r);
      return !r.error && typeof r.correct === 'boolean' && s !== null && s >= from && s < to;
    });
    return {
      from,
      to: Math.min(to, 1),
      count: inBucket.length,
      accuracy: inBucket.length ? inBucket.filter((r) => r.correct).length / inBucket.length : null,
    };
  });
}

/** Top probability = how sure Jev is of the option it picked. Falls back to confidence. */
export const jevTopProbability = (r: CallRecord): number | null =>
  r.probabilities && r.answer && r.answer in r.probabilities ? r.probabilities[r.answer] : r.confidence;

/**
 * Build the whole Summary from one run's calls.
 * act: the router threshold used for the "each LLM alone vs. with Jev" replay.
 */
export function summarize(records: CallRecord[], act = Number(process.env.ROUTE_ACT || 0.8)): Summary {
  // "Before": the strong LLM alone. "After": every call made by route().
  const baselineCalls = records.filter((r) => r.experiment === 'baseline' && !r.error);
  const routedCalls = records.filter((r) => r.experiment === 'routed' && !r.error);

  // Group routed calls into decisions.
  const decisions = new Map<string, CallRecord[]>();
  for (const r of routedCalls) decisions.set(r.route_id ?? r.task_id, [...(decisions.get(r.route_id ?? r.task_id) ?? []), r]);
  // One item per decision: the LAST call gave the final answer; cost and time add up all its calls.
  const routedItems = [...decisions.values()].map((calls) => {
    const final = calls[calls.length - 1];
    return { correct: final.correct, cost: calls.reduce((s, c) => s + c.cost_usd, 0), ms: calls.reduce((s, c) => s + c.latency_ms, 0), path: final.route_path ?? 'jev', calls };
  });
  // Count where each decision ended.
  const split: RouteSplit = { jev: 0, cheap: 0, strong: 0 };
  for (const item of routedItems) split[item.path as keyof RouteSplit]++;
  // Overhead: what the Jev call cost on decisions that escalated anyway.
  const overhead = routedItems.filter((i) => i.path !== 'jev').reduce((s, i) => s + i.calls[0].cost_usd, 0);

  // Sweep + calibration: prefer this run's routed/baseline pair, fall back to the benchmark.
  const strongModel = baselineCalls[0]?.model ?? null;
  let jevForSweep = routedCalls.filter((r) => r.model_key === 'jev');
  let strongForSweep = baselineCalls;
  // No before/after pair in this run (e.g. a bench run): use the benchmark's Jev and strong-LLM answers.
  if (jevForSweep.length === 0 || strongForSweep.length === 0) {
    const bench = records.filter((r) => r.experiment === 'bench');
    jevForSweep = bench.filter((r) => r.model_key === 'jev');
    strongForSweep = bench.filter((r) => r.model_key === (process.env.ROUTE_STRONG || 'opus'));
  }
  const llmForCalibration = strongForSweep;

  return {
    // Assemble the summary. Everything is computed from saved calls: no new API spend.
    baseline: totals(baselineCalls.map((r) => ({ correct: r.correct, cost: r.cost_usd, ms: r.latency_ms }))),
    baselineModel: strongModel,
    routed: totals(routedItems),
    split,
    pathModels: {
      jev: routedCalls.find((r) => r.route_path === 'jev')?.model ?? null,
      cheap: routedCalls.find((r) => r.route_path === 'cheap')?.model ?? null,
      strong: routedCalls.find((r) => r.route_path === 'strong')?.model ?? null,
    },
    sweepModel: strongForSweep[0]?.model ?? null,
    overheadUsdPer1k: routedItems.length ? (overhead / routedItems.length) * 1000 : 0,
    sweep: sweep(jevForSweep, strongForSweep),
    calibrationJev: calibration(jevForSweep, jevTopProbability),
    calibrationLlm: calibration(llmForCalibration, (r) => r.confidence),
    calibrationLlmModel: llmForCalibration[0]?.model ?? null,
    pairs: pairs(records, act),
    pairsThreshold: act,
  };
}
