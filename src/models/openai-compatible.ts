import OpenAI from 'openai';
import type { ChoiceAnswer, ChoiceQuestion, DecisionModel, ModelCall } from '../types';
// The prompt, the JSON schema and the parser are shared with Claude, so all LLMs get the same question.
import { answerSchema, buildPrompt, parseAnswer } from './llm-prompt';

/**
 * GPT-6 Astra (OpenAI) and Grok 4.7 (xAI), both System Two.
 * xAI's API is OpenAI-compatible, so one adapter covers both (only the base URL and key change).
 * Structured output via `response_format: json_schema`.
 * completion_tokens already includes reasoning tokens; we also log the reasoning part on its own.
 */

/** What differs between Astra and Grok. Everything else is the same code. */
type Config = {
  key: 'astra' | 'grok';
  label: string;
  provider: 'openai' | 'xai';
  model: string;
  /** The name of the env variable that holds the key (not the key itself). */
  apiKeyEnv: string;
  /** Empty for OpenAI (the SDK default). xAI needs its own URL. */
  baseURL?: string;
};

export class OpenAICompatibleClient implements DecisionModel {
  readonly key: Config['key'];
  readonly label: string;
  readonly provider: Config['provider'];
  readonly model: string;
  // Created on the first call, so a missing key only matters if this model is actually used.
  private client?: OpenAI;

  constructor(private readonly config: Config) {
    this.key = config.key;
    this.label = config.label;
    this.provider = config.provider;
    this.model = config.model;
  }

  /** This model joins a demo only when its key (OPENAI_API_KEY or XAI_API_KEY) is in .env. */
  available(): boolean {
    return Boolean(process.env[this.config.apiKeyEnv]);
  }

  /** Ask one "pick an option" question about the state. */
  async choose(state: string, question: ChoiceQuestion, opts: { withReason?: boolean } = {}): Promise<ModelCall<ChoiceAnswer>> {
    // Same SDK for both vendors: only the key and the base URL change.
    this.client ??= new OpenAI({ apiKey: process.env[this.config.apiKeyEnv], baseURL: this.config.baseURL });
    const withReason = opts.withReason ?? false;

    const response = await this.client.chat.completions.create({
      model: this.model,
      // Room for reasoning plus the short JSON answer.
      max_completion_tokens: 4096,
      // strict: true makes the API enforce the schema, so the answer is always one of our option keys.
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'decision', strict: true, schema: answerSchema(question, withReason) },
      },
      messages: [{ role: 'user', content: buildPrompt(state, question, withReason) }],
    });

    // The JSON answer is the text of the first (and only) choice.
    const text = response.choices[0]?.message?.content ?? '';
    const { answer, parseOk } = parseAnswer(text, question);
    return {
      result: answer,
      parseOk,
      // The model that really answered, as the API reports it.
      servedBy: response.model,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        // completion_tokens already includes the reasoning tokens: this is what gets billed as output.
        outputTokens: response.usage?.completion_tokens ?? 0,
        // The reasoning part on its own, so the report can show how much was "thinking".
        reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  }
}

/** GPT-6 Astra: OpenAI's own endpoint, so no base URL. */
export function astra(): OpenAICompatibleClient {
  return new OpenAICompatibleClient({
    key: 'astra',
    label: 'GPT-6 Astra',
    provider: 'openai',
    model: process.env.OPENAI_MODEL || 'gpt-6-astra',
    apiKeyEnv: 'OPENAI_API_KEY',
  });
}

/** Grok 4.7: xAI's OpenAI-compatible endpoint. XAI_BASE_URL can point elsewhere if needed. */
export function grok(): OpenAICompatibleClient {
  return new OpenAICompatibleClient({
    key: 'grok',
    label: 'Grok 4.7',
    provider: 'xai',
    model: process.env.XAI_MODEL || 'grok-4.7',
    apiKeyEnv: 'XAI_API_KEY',
    baseURL: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
  });
}
