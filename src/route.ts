// A unique id per decision, to group its 1 or 2 calls together.
import { randomUUID } from 'node:crypto';
// decide() asks one model and records the call. runId() names the run.
import { decide, runId, type CallRecord } from './meter';
import { jev, modelByKey } from './models';
import { instruments, tracer } from './telemetry';
import type { ChoiceQuestion, DecisionModel } from './types';

/**
 * Project 1: the reusable cost-routing pattern.
 *
 *   Jev answers first (System One: ~100 ms, almost free).
 *   confidence >= act       -> use Jev's answer.                  path: "jev"
 *   escalate <= conf < act  -> ask the cheaper LLM.               path: "cheap"
 *   confidence < escalate   -> ask the strongest LLM.             path: "strong"
 *
 * Drop it in front of any "pick one of these options" call in your pipeline.
 */
/**
 * The four knobs of the router. All of them come from .env, so you tune without touching code.
 *   act       Jev at or above this confidence: trust it.
 *   escalate  between escalate and act: the cheap LLM. Below escalate: the strong LLM.
 */
export type RoutePolicy = {
  act: number;
  escalate: number;
  cheap: DecisionModel;
  strong: DecisionModel;
};

// Read the policy from .env (ROUTE_ACT, ROUTE_ESCALATE, ROUTE_CHEAP, ROUTE_STRONG), with sensible defaults.
export function policyFromEnv(): RoutePolicy {
  return {
    act: Number(process.env.ROUTE_ACT || 0.8),
    escalate: Number(process.env.ROUTE_ESCALATE || 0.5),
    cheap: modelByKey(process.env.ROUTE_CHEAP || 'grok'),
    strong: modelByKey(process.env.ROUTE_STRONG || 'opus'),
  };
}

/** What route() returns for one decision: the answer, who gave it, and what it cost in total. */
export type RouteResult = {
  label: string | null;
  path: 'jev' | 'cheap' | 'strong';
  jevConfidence: number | null;
  /** Every call made for this one decision (1 or 2). */
  calls: CallRecord[];
  costUsd: number;
  latencyMs: number;
  /** What the router itself cost when it had to escalate (the Jev call). 0 when Jev answered. */
  overheadUsd: number;
  overheadMs: number;
};

/**
 * Route one decision. `task` is what to decide (its state and question, and the right answer when known).
 * `experiment` tags the calls in calls.jsonl ("routed" by default), so reports can tell runs apart.
 */
export async function route(
  task: { id: string; state: string; question: ChoiceQuestion; expected?: string },
  policy: RoutePolicy = policyFromEnv(),
  experiment = 'routed',
): Promise<RouteResult> {
  // Every call made for this decision carries the same route_id.
  const routeId = randomUUID();
  // One parent span per decision: in Grafana the Jev span (and the LLM span, if any) sit inside it.
  return tracer.startActiveSpan('route', async (span) => {
    try {
      span.setAttributes({ 'jev_training.task_id': task.id, 'jev_training.run': runId() });
      // Labels shared by both calls of this decision.
      const meta = { experiment, taskId: task.id, expected: task.expected, routeId };

      // Step 1: Jev always answers first. Fast and almost free.
      const first = await decide(jev(), task.state, task.question, { ...meta, routePath: 'jev' });
      // No confidence (e.g. an unreadable answer) counts as 0: it escalates.
      const confidence = first.record.confidence ?? 0;

      // Default: Jev's answer is the final one.
      let path: RouteResult['path'] = 'jev';
      let final = first.record;
      // Step 2: Jev not sure enough (or no answer)? Escalate.
      if (confidence < policy.act || first.record.answer === null) {
        // A bit unsure: the cheap LLM. Lost: the strong one.
        path = confidence >= policy.escalate ? 'cheap' : 'strong';
        const model = path === 'cheap' ? policy.cheap : policy.strong;
        // Same state, same question, now to the LLM. Its answer replaces Jev's.
        final = (await decide(model, task.state, task.question, { ...meta, routePath: path })).record;
      }

      // Total cost and time include BOTH calls when we escalated: the router isn't free when it says "not sure".
      const calls = path === 'jev' ? [first.record] : [first.record, final];
      const result: RouteResult = {
        label: final.answer,
        path,
        jevConfidence: first.record.confidence,
        calls,
        costUsd: calls.reduce((sum, c) => sum + c.cost_usd, 0),
        latencyMs: calls.reduce((sum, c) => sum + c.latency_ms, 0),
        // The overhead: what the Jev call added on top of the LLM call, when it escalated.
        overheadUsd: path === 'jev' ? 0 : first.record.cost_usd,
        overheadMs: path === 'jev' ? 0 : first.record.latency_ms,
      };
      // Record the outcome on the span and in the "decisions by path" metric (Grafana).
      span.setAttributes({ 'jev_training.route.path': path, 'jev_training.cost_usd': result.costUsd });
      instruments().decisions.add(1, { path, model: final.model, experiment, run: runId() });
      return result;
    } finally {
      span.end();
    }
  });
}
