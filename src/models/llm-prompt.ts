import type { ChoiceAnswer, ChoiceQuestion } from '../types';

/**
 * The same question, written for an LLM (System Two).
 * We give the LLMs their best shot: structured output (a JSON schema), so they can't
 * ramble or invent a label. They still can't give a CALIBRATED probability, so we ask
 * them to rate their own confidence and later compare it with Jev's.
 */
export function buildPrompt(state: string, question: ChoiceQuestion, withReason: boolean): string {
  // One line per option: "- flaky: Non-deterministic: the same code sometimes passes...".
  const options = Object.entries(question.options)
    .map(([key, description]) => `- ${key}: ${description}`)
    .join('\n');
  // The prompt, top to bottom: the question, the options, the state, then what to answer with.
  return [
    question.instructions,
    '',
    'Options:',
    options,
    '',
    'State:',
    state,
    '',
    `Answer with the option key, your confidence from 0 to 1${withReason ? ', and a reason of at most 20 words' : ''}.`,
  ].join('\n');
}

/**
 * The JSON schema the LLM must follow: { answer, confidence } (+ reason when asked).
 * `answer` is an enum of our option keys, so the API itself rejects any invented label.
 */
export function answerSchema(question: ChoiceQuestion, withReason: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    answer: { type: 'string', enum: Object.keys(question.options) },
    confidence: { type: 'number' },
  };
  if (withReason) properties.reason = { type: 'string' };
  return {
    type: 'object',
    properties,
    // Every field is required and no extra fields are allowed: what strict structured output expects.
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** Turn the model's JSON text into a ChoiceAnswer. Never throws: a bad answer is counted as a parse failure. */
export function parseAnswer(text: string, question: ChoiceQuestion): { answer: ChoiceAnswer; parseOk: boolean } {
  try {
    const json = JSON.parse(text) as { answer?: string; confidence?: number; reason?: string };
    // Double-check the label even with a schema: an unknown key becomes null, not a silent wrong answer.
    const label = json.answer && json.answer in question.options ? json.answer : null;
    // Clamp the self-reported confidence to 0..1, in case the model wrote 1.2 or -0.1.
    const confidence = typeof json.confidence === 'number' ? Math.min(1, Math.max(0, json.confidence)) : null;
    return { answer: { label, confidence, reason: json.reason }, parseOk: label !== null };
  } catch {
    // Not valid JSON at all: no answer, and the report counts it as a parse failure.
    return { answer: { label: null, confidence: null }, parseOk: false };
  }
}
