/**
 * Shared types. Every model adapter (Jev, Claude, Astra, Grok) speaks these shapes,
 * so the rest of the code (meter, router, reports) never cares which vendor answered.
 */

/** Token counts as reported by each vendor's own `usage` field. */
export type Usage = {
  /** Tokens sent to the model: the prompt, the state, the question. */
  inputTokens: number;
  /** Includes reasoning/thinking tokens: vendors bill them as output. */
  outputTokens: number;
  /** Reasoning/thinking tokens, when the vendor reports them separately (already inside outputTokens). */
  reasoningTokens: number;
};

/** One "pick an option" question. The same shape is sent to Jev and to every LLM. */
export type ChoiceQuestion = {
  /** The question in plain English, e.g. "What is the most likely root cause of this failure?" */
  instructions: string;
  /** key -> description. Keys are what the code branches on. */
  options: Record<string, string>;
};

/** The answer to a ChoiceQuestion, normalised so Jev and the LLMs can be compared 1:1. */
export type ChoiceAnswer = {
  /** The chosen option key, or null when the answer couldn't be read. */
  label: string | null;
  /**
   * Jev: calibrated confidence from the API.
   * LLMs: the number the model wrote about itself (self-reported, not calibrated).
   */
  confidence: number | null;
  /** Jev only: probability for every option. */
  probabilities?: Record<string, number>;
  /** LLMs only, when asked: a short reason. */
  reason?: string;
};

/** What a model adapter returns: the answer plus the raw facts the meter needs. */
export type ModelCall<T> = {
  /** The answer itself (a ChoiceAnswer for choose(), the raw answers for Jev's ask()). */
  result: T;
  /** Tokens, as the vendor counted them. The meter turns these into dollars. */
  usage: Usage;
  /** The model that actually answered (can differ from the requested one, e.g. a refusal fallback). */
  servedBy: string;
  /** False when the answer couldn't be parsed into one of the allowed options. */
  parseOk: boolean;
};

/** Short names used in .env, the CLI and the reports: ROUTE_CHEAP=grok, --models jev,opus, ... */
export type ModelKey = 'jev' | 'opus' | 'astra' | 'grok';

/**
 * The one interface every model implements. Anything that takes a DecisionModel
 * (the race, the router, the agent) works with all four vendors.
 */
export interface DecisionModel {
  /** Short name, see ModelKey. */
  key: ModelKey;
  /** Display name for the terminal and the reports, e.g. "Claude Opus 5.5". */
  label: string;
  /** The model ID sent to the API. */
  model: string;
  /** Who runs it. "typesafe" is the only one with calibrated confidence. */
  provider: 'typesafe' | 'anthropic' | 'openai' | 'xai';
  /** True when this model's API key is in .env. Models without a key are skipped. */
  available(): boolean;
  /** Ask one "pick an option" question about one state. withReason: LLMs also return a short reason. */
  choose(state: string, question: ChoiceQuestion, opts?: { withReason?: boolean }): Promise<ModelCall<ChoiceAnswer>>;
}
