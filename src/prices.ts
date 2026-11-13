/**
 * Price table: USD per 1 million tokens. The ONLY place prices live.
 * Prices change: update the date and the source when you change a number.
 *
 * Note: Jev output tokens are free (TypeSafe reports them in `usage` but does not bill them).
 * Reasoning/thinking tokens are billed as output tokens by every LLM vendor here.
 */

/** Shown in the reports next to every cost, so nobody mistakes old prices for current ones. */
export const PRICES_CHECKED_ON = '2026-11-08';

/** input / output: USD per 1M tokens. source: where the number came from, to re-check it. */
export type Price = { input: number; output: number; source: string };

/** Keyed by the exact model ID sent to the API (the same IDs as in .env). */
export const PRICES: Record<string, Price> = {
  'jev-latest': { input: 0.042, output: 0, source: 'https://typesafe.ai (Jev pricing: $0.042/MTok input, output free)' },
  'claude-opus-5-5': { input: 4, output: 20, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  'gpt-6-astra': { input: 10, output: 50, source: 'https://openai.com/api/pricing (standard tier, prompts under 272K)' },
  'grok-4.7': { input: 2, output: 6, source: 'https://x.ai/api (prompts under 200K)' },
};

/** Cost of one call in USD. Unknown models cost 0 and are flagged in the report. */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  // First try the exact ID. If the API answered with a versioned ID (e.g. "jev-1.14.0"),
  // strip the version and fall back to the "-latest" price ("jev-latest").
  const price = PRICES[model] ?? PRICES[model.replace(/-\d+(\.\d+)*$/, '-latest')];
  if (!price) return 0;
  // Prices are per million tokens, so divide by 1,000,000 to get the cost of this call.
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** True when the exact model ID is in the table. The reports use it to flag "no price" rows. */
export function hasPrice(model: string): boolean {
  return model in PRICES;
}
