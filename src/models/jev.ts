import type { ChoiceAnswer, ChoiceQuestion, DecisionModel, ModelCall, Usage } from '../types';

/**
 * Jev (TypeSafe AI), the first System One model.
 * You send a state plus typed questions; every question is answered in ONE parallel pass.
 *
 *   choice -> { choice, probabilities, confidence }
 *   score  -> { score, probabilities, confidence }   (score = probability-weighted expected value)
 *   noul   -> { noul }                                (probability that the answer is "yes", 0-1)
 *
 * Docs: https://docs.typesafe.ai
 *
 * No SDK here on purpose: one plain fetch to the REST endpoint, so there's no extra dependency
 * and you can see the whole request. The body is the same as the SDK's: model, state, questions.
 */
const ENDPOINT = process.env.JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone';

/** The three question types we use. Each one names its type, the question, and (for choice/score) the options. */
export type JevQuestion =
  // choice: pick one key. criteria maps each key to what it means.
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  // score: rate on an ordered scale. criteria lists the levels, lowest first.
  | { type: 'score'; instructions: string; criteria: string[] }
  // noul: yes or no. No options: the answer is the probability of "yes".
  | { type: 'noul'; instructions: string };

/** One answer from Jev. Which fields are filled depends on the question type. */
export type JevAnswer = {
  type: string;
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
};

/** The API response: one answer per question name, plus the model that served it and the token usage. */
type JevResponse = {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export class JevClient implements DecisionModel {
  readonly key = 'jev' as const;
  readonly label = 'Jev';
  // "typesafe" is how the meter knows this confidence is calibrated, not self-reported.
  readonly provider = 'typesafe' as const;
  // jev-latest follows the newest version (1.14 in Nov 2026). Pin a version in .env for repeatable runs.
  readonly model = process.env.JEV_MODEL || 'jev-latest';

  /** Jev joins a demo only when JEV_API_KEY is in .env. */
  available(): boolean {
    return Boolean(process.env.JEV_API_KEY);
  }

  /** Ask any mix of choice / score / noul questions about one state, in one call. */
  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<ModelCall<Record<string, JevAnswer>>> {
    const key = process.env.JEV_API_KEY;
    if (!key) throw new Error('JEV_API_KEY is not set (see .env.example)');

    // The whole API call: POST the model, the state and the questions as JSON.
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, state, questions }),
    });
    if (!response.ok) {
      // Never log the key; the body only has the API's error message.
      throw new Error(`Jev request failed: HTTP ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as JevResponse;
    // Tokens as TypeSafe counts them. Jev doesn't "think" in text, so there are no reasoning tokens.
    const usage: Usage = {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0, // reported, but not billed
      reasoningTokens: 0,
    };
    // Typed answers need no parsing, so parseOk is always true here.
    return { result: body.answers, usage, servedBy: body.model ?? this.model, parseOk: true };
  }

  /** The common "pick one option" shape, so Jev can be compared 1:1 with the LLMs. */
  async choose(state: string, question: ChoiceQuestion): Promise<ModelCall<ChoiceAnswer>> {
    // One choice question, named "answer". The options become Jev's criteria.
    const call = await this.ask(state, {
      answer: { type: 'choice', instructions: question.instructions, criteria: question.options },
    });
    const a = call.result.answer;
    // Safety net: only accept a label that is one of our options.
    const label = a?.choice && a.choice in question.options ? a.choice : null;
    // Reshape Jev's answer into the shared ChoiceAnswer: label, calibrated confidence, every probability.
    return {
      ...call,
      parseOk: label !== null,
      result: { label, confidence: a?.confidence ?? null, probabilities: a?.probabilities },
    };
  }
}
