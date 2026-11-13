/**
 * The numbers every report shows: latency (typical and slow, 1 in 20), tokens, cost per 1,000 decisions, accuracy.
 * In the code they're still called median and p95 (medianMs, p95Ms); on screen they're "typical" and "slow (1 in 20)".
 * Pure functions over the lines of calls.jsonl: no I/O here.
 */
import type { CallRecord } from '../meter';

// The middle value: half the calls were faster, half slower.
export function median(values: number[]): number {
  return percentile(values, 50);
}

// The value p% of the calls stay under (p95, shown as "slow (1 in 20)": 19 of 20 calls were faster). Nearest-rank method, no interpolation.
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  // Copy before sorting (don't reorder the caller's array), numerically (not as text).
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

// One row of the summary table.
export type ModelStats = {
  model: string;
  calls: number;
  errors: number;
  medianMs: number;
  p95Ms: number;
  avgInput: number;
  avgOutput: number;
  // Average cost per call x 1,000: easier to compare than fractions of a cent.
  costPer1k: number;
  // Share of right answers, only over calls where the right answer was known. null: nothing to grade.
  accuracy: number | null;
  parseFailures: number;
};

/**
 * Who a call was for, in words: "before · claude-opus-5-5", "after · jev-latest (every decision)"...
 * Used to label the per-model table so routed calls show up next to the baseline.
 */
export function roleLabel(r: CallRecord): string {
  // Project 1: "before" (the strong LLM alone), "alone" (other LLMs alone), "after" (the router).
  if (r.experiment === 'baseline') return `before · ${r.model}`;
  if (r.experiment === 'baseline-other') return `alone · ${r.model} (for the comparison)`;
  if (r.experiment === 'routed') {
    const role = r.route_path === 'jev' ? 'every decision, answers first' : r.route_path === 'cheap' ? 'medium-confidence cases Jev escalated' : 'low-confidence cases Jev escalated';
    return `after · ${r.model} (${role})`;
  }
  // Every other experiment: a short phase name and what the calls were for.
  const roles: Record<string, string> = {
    explore: 'explore · Jev reviews a page',
    'explore-escalation': 'explore · unsure pages escalated',
    'agent-hybrid': 'agent · hybrid, each step',
    'agent-llm': 'agent · LLM-only, each step',
    edges: 'edges · edge cases',
    race: 'race',
    bench: 'benchmark',
  };
  const role = roles[r.experiment];
  if (!role) return r.model;
  const [phase, what] = role.split(' · ');
  return what ? `${phase} · ${r.model} (${what})` : `${phase} · ${r.model}`;
}

/** One row per model (or per label): the table every demo prints. Errors are counted but left out of the averages. */
export function statsByModel(records: CallRecord[], label: (r: CallRecord) => string = (r) => r.model): ModelStats[] {
  // Group the calls by label (the model, or its role).
  const byModel = new Map<string, CallRecord[]>();
  for (const r of records) byModel.set(label(r), [...(byModel.get(label(r)) ?? []), r]);
  return [...byModel.entries()].map(([model, all]) => {
    // Failed calls are counted as errors but kept out of the averages.
    const ok = all.filter((r) => !r.error);
    // Only calls with a known right answer count for accuracy.
    const graded = ok.filter((r) => typeof r.correct === 'boolean');
    // Avoid dividing by zero when every call failed.
    const n = Math.max(ok.length, 1);
    return {
      model,
      calls: ok.length,
      errors: all.length - ok.length,
      medianMs: median(ok.map((r) => r.latency_ms)),
      p95Ms: percentile(ok.map((r) => r.latency_ms), 95),
      avgInput: ok.reduce((s, r) => s + r.input_tokens, 0) / n,
      avgOutput: ok.reduce((s, r) => s + r.output_tokens, 0) / n,
      costPer1k: (ok.reduce((s, r) => s + r.cost_usd, 0) / n) * 1000,
      accuracy: graded.length ? graded.filter((r) => r.correct).length / graded.length : null,
      parseFailures: ok.filter((r) => !r.parse_ok).length,
    };
  });
}

// Money for humans: "$0", "$0.000081", "$2.50".
export function usd(value: number): string {
  if (value === 0) return '$0';
  // Jev calls cost fractions of a cent: show two significant digits instead of $0.00000.
  if (value < 0.01) return `$${value.toFixed(Math.min(10, 1 - Math.floor(Math.log10(value))))}`;
  return `$${value.toFixed(2)}`;
}

// 0.9 -> "90%". null -> "n/a".
export function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

/**
 * What "(calibrated)" and "(self-reported)" mean next to a confidence. Printed under the race,
 * the edge cases and `npm run why`, so the audience reads the two numbers differently.
 */
export const CONFIDENCE_LEGEND = [
  'confidence (calibrated):    Jev\'s own probabilities. TypeSafe trains them to match reality: 0.8 should be right about 8 times in 10.',
  'confidence (self-reported): the LLM rated itself because we asked. Nothing trains that number to match how often it is right: an opinion, not a measurement.',
].join('\n');

/** A plain text table for the terminal. */
export function textTable(rows: ModelStats[]): string {
  const header = ['model', 'calls', 'typical', 'slow (1 in 20)', 'in tok', 'out tok', '$ / 1k decisions', 'accuracy', 'parse fails'];
  const lines = rows.map((r) => [
    r.model,
    String(r.calls) + (r.errors ? ` (+${r.errors} err)` : ''),
    `${r.medianMs} ms`,
    `${r.p95Ms} ms`,
    r.avgInput.toFixed(0),
    r.avgOutput.toFixed(0),
    usd(r.costPer1k),
    pct(r.accuracy),
    String(r.parseFailures),
  ]);
  // Each column is as wide as its longest cell, so the table lines up in the terminal.
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [
    fmt(header),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...lines.map(fmt),
    '',
    // Two lines under the table that explain the columns.
    'typical: half of the calls were faster than this, half slower · slow (1 in 20): 19 of 20 calls were faster, 1 in 20 slower',
    'tokens: from each vendor\'s usage field (output includes reasoning) · $ / 1k decisions: average cost per call x 1,000',
  ].join('\n');
}
