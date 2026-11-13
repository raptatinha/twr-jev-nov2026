// OpenTelemetry: marks a span as failed when a call throws.
import { SpanStatusCode } from '@opentelemetry/api';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Tokens -> dollars (the price table).
import { costUsd } from './prices';
// Names the run: date, time and what ran.
import { makeRunId } from './run-id';
// Level 3: spans and metrics for Grafana. No-ops unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { instruments, startTelemetry, tracer } from './telemetry';
import type { ChoiceAnswer, ChoiceQuestion, DecisionModel, ModelCall } from './types';

/**
 * "You can't cut what you don't measure."
 * Every model call in this project goes through `track()`. It:
 *   1. times the call (wall clock, so it includes the network, like your users feel it),
 *   2. reads the tokens from the vendor's own `usage` field,
 *   3. turns tokens into dollars with the price table (src/prices.ts),
 *   4. writes one JSON line to runs/<run id>/calls.jsonl,
 *   5. sends an OpenTelemetry span + metrics when telemetry is on.
 */
/**
 * One line of runs/<run id>/calls.jsonl: everything we know about ONE model call.
 * The dashboard, the Playwright report, `npm run why` and Grafana all read these lines.
 */
export type CallRecord = {
  // When the call started (ISO time).
  ts: string;
  // Which run this call belongs to (same id as the folder name).
  run_id: string;
  /** Which demo produced this line: race, bench, baseline, routed, explore, agent-hybrid, agent-llm... */
  experiment: string;
  // What was asked about: a failure id (F37), a page title (P2) or an agent step (P3).
  task_id: string;
  // Short name (jev, opus, astra, grok), the requested model ID, and who really answered.
  model_key: string;
  model: string;
  served_by: string;
  provider: string;
  // Wall-clock time of the call, network included.
  latency_ms: number;
  // Tokens as the vendor reported them. reasoning_tokens is already inside output_tokens.
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  // input and output tokens priced with src/prices.ts.
  cost_usd: number;
  // The model's answer, the right answer (when known) and whether they match.
  answer: string | null;
  expected?: string;
  correct?: boolean | null;
  // Jev: calibrated. LLMs: what the model said about itself (see the next field).
  confidence: number | null;
  /** True for LLMs: the confidence is the model's own guess about itself, not calibrated. */
  confidence_self_reported: boolean;
  probabilities?: Record<string, number>;
  reason?: string;
  // False when the answer couldn't be read as one of the options.
  parse_ok: boolean;
  /** Groups the calls that served one routed decision. */
  route_id?: string;
  /** jev | cheap | strong: who gave the final answer for this decision. */
  route_path?: string;
  /** The exact state the model was given. Lets you debug a wrong answer later (`npm run why`). */
  state?: string;
  // Set when the call failed: the error message (and the tokens/cost are 0).
  error?: string;
};

// Every run writes under ./runs (ignored by git).
export const RUNS_DIR = join(process.cwd(), 'runs');

/** One id per run. Playwright workers inherit it from the main process (set in playwright.config.ts). */
export function runId(): string {
  process.env.RUN_ID ??= makeRunId(process.env.RUN_LABEL);
  return process.env.RUN_ID;
}

// Where a run's calls live: runs/<id>/calls.jsonl.
export function callsFile(id = runId()): string {
  return join(RUNS_DIR, id, 'calls.jsonl');
}

// Append one call to its run's file, and remember this run as the latest one.
function write(record: CallRecord): void {
  const file = callsFile(record.run_id);
  mkdirSync(join(RUNS_DIR, record.run_id), { recursive: true });
  // JSON Lines: one object per line. Appending is safe even with several Playwright workers.
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  // runs/LATEST holds the newest run id, so `npm run why` and the dashboard know where to look by default.
  writeFileSync(join(RUNS_DIR, 'LATEST'), record.run_id);
}

// Read every call of a run back. No id: the latest run. No file yet: an empty list.
export function readCalls(id?: string): CallRecord[] {
  const chosen = id ?? (existsSync(join(RUNS_DIR, 'LATEST')) ? readFileSync(join(RUNS_DIR, 'LATEST'), 'utf8').trim() : '');
  const file = callsFile(chosen);
  if (!chosen || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    // One JSON object per non-empty line.
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CallRecord);
}

// The only model fields the meter needs: no SDK client, just names.
type ModelInfo = Pick<DecisionModel, 'key' | 'model' | 'provider'>;

/**
 * Spending cap: at most BUDGET_USD_PER_MODEL (default $5) per model, per run.
 * A run is one command (`npm run p1`, `npm run bench`...). The total is read from the run's
 * calls.jsonl, so every Playwright worker sees the same number.
 * The cost of a call is only known after it returns, so calls already in flight can go a few
 * cents over. For a hard guarantee, also set a spend limit in each vendor's console.
 */
export class BudgetExceededError extends Error {}

// The cap from .env. Anything invalid (empty, 0, text) falls back to $5.
export function budgetUsd(): number {
  const value = Number(process.env.BUDGET_USD_PER_MODEL || 5);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

// What this model has cost so far in this run, summed from the calls already written.
export function spentThisRun(model: string): number {
  return readCalls(runId())
    .filter((c) => c.model === model)
    .reduce((sum, c) => sum + c.cost_usd, 0);
}

// Called before every call: stops (throws) instead of spending past the cap.
function checkBudget(model: string): void {
  const spent = spentThisRun(model);
  if (spent >= budgetUsd()) {
    throw new BudgetExceededError(
      `Budget reached for ${model}: $${spent.toFixed(2)} spent in run ${runId()} (limit $${budgetUsd()} per model per run, BUDGET_USD_PER_MODEL in .env). Call skipped.`,
    );
  }
}

/** Labels attached to a call: which demo, which task, the right answer, and the routing info. */
export type TrackMeta = {
  experiment: string;
  taskId: string;
  expected?: string;
  routeId?: string;
  routePath?: string;
  /** The input the model saw, saved with the call for debugging. */
  state?: string;
};

// The answer fields every call is reduced to, whatever the model returned.
type Readout = { answer: string | null; confidence: number | null; probabilities?: Record<string, number>; reason?: string };

/** Measure any model call. `readout` says how to read the answer out of the result. */
export async function track<T>(
  model: ModelInfo,
  meta: TrackMeta,
  call: () => Promise<ModelCall<T>>,
  readout: (result: T) => Readout,
): Promise<{ call: ModelCall<T>; record: CallRecord }> {
  // 1. Refuse the call if this model already hit its budget in this run.
  checkBudget(model.model);
  // 2. Start OpenTelemetry on first use (does nothing when it's off).
  startTelemetry();
  // 3. Wrap the call in a span named after the model, so Grafana shows one bar per call.
  return tracer.startActiveSpan(`chat ${model.model}`, async (span) => {
    span.setAttributes({
      // GenAI conventions: what was called and how. Jev "decides", the LLMs "chat".
      'gen_ai.operation.name': model.provider === 'typesafe' ? 'decide' : 'chat',
      'gen_ai.provider.name': model.provider,
      'gen_ai.request.model': model.model,
      'jev_training.experiment': meta.experiment,
      'jev_training.task_id': meta.taskId,
      'jev_training.run': runId(),
    });

    // 4. Start the clock.
    const started = performance.now();
    // Fields known before the call: they go in the record whether it succeeds or fails.
    const base = {
      ts: new Date().toISOString(),
      run_id: runId(),
      experiment: meta.experiment,
      task_id: meta.taskId,
      model_key: model.key,
      model: model.model,
      provider: model.provider,
      expected: meta.expected,
      route_id: meta.routeId,
      route_path: meta.routePath,
      state: meta.state,
      // Only Jev (provider typesafe) has a calibrated confidence.
      confidence_self_reported: model.provider !== 'typesafe',
    };

    try {
      // 5. Make the actual call (whatever function the caller passed in).
      const result = await call();
      const latency = Math.round(performance.now() - started);
      // Price by the requested model: that's what your contract is for.
      const cost = costUsd(model.model, result.usage.inputTokens, result.usage.outputTokens);
      // Pull answer, confidence and probabilities out of the model-specific result.
      const out = readout(result.result);
      const record: CallRecord = {
        ...base,
        served_by: result.servedBy,
        latency_ms: latency,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        reasoning_tokens: result.usage.reasoningTokens,
        cost_usd: cost,
        answer: out.answer,
        // Accuracy: only when the right answer is known.
        correct: meta.expected === undefined ? undefined : out.answer === meta.expected,
        confidence: out.confidence,
        probabilities: out.probabilities,
        reason: out.reason,
        parse_ok: result.parseOk,
      };
      // 6. Save the line to calls.jsonl.
      write(record);

      span.setAttributes({
        // 7. Add the results to the span: who answered, tokens, cost, answer, confidence, correct.
        'gen_ai.response.model': result.servedBy,
        'gen_ai.usage.input_tokens': result.usage.inputTokens,
        'gen_ai.usage.output_tokens': result.usage.outputTokens,
        'jev_training.cost_usd': cost,
        'jev_training.answer': out.answer ?? '',
        ...(out.confidence !== null ? { 'jev_training.confidence': out.confidence } : {}),
        ...(record.correct !== undefined ? { 'jev_training.correct': Boolean(record.correct) } : {}),
      });
      // run: lets the Grafana dashboard show one run at a time.
      const labels = { model: model.model, experiment: meta.experiment, run: runId() };
      // 8. Metrics for the Grafana dashboard: tokens in and out, cost, latency.
      instruments().tokens.add(result.usage.inputTokens, { ...labels, direction: 'input' });
      instruments().tokens.add(result.usage.outputTokens, { ...labels, direction: 'output' });
      instruments().cost.add(cost, labels);
      instruments().latency.record(latency, labels);
      // Return both: the raw result (for the caller) and the record (for the reports).
      return { call: result, record };
    // A failed call is still recorded, with the error message and zero cost, then re-thrown.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write({
        ...base,
        served_by: model.model,
        latency_ms: Math.round(performance.now() - started),
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: 0,
        answer: null,
        confidence: null,
        parse_ok: false,
        error: message,
      });
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw error;
    // The span always ends, success or failure.
    } finally {
      span.end();
    }
  });
}

/** The common case: ask one model one "pick an option" question, measured. */
export function decide(
  model: DecisionModel,
  state: string,
  question: ChoiceQuestion,
  meta: TrackMeta,
  opts: { withReason?: boolean } = {},
): Promise<{ call: ModelCall<ChoiceAnswer>; record: CallRecord }> {
  // track() around the model's standard choose() call. The state is saved too, for `npm run why`.
  return track(model, { ...meta, state }, () => model.choose(state, question, opts), (r) => ({
    answer: r.label,
    confidence: r.confidence,
    probabilities: r.probabilities,
    reason: r.reason,
  }));
}
