import Anthropic from '@anthropic-ai/sdk';
import type { ChoiceAnswer, ChoiceQuestion, DecisionModel, ModelCall } from '../types';
// The prompt, the JSON schema and the parser are shared with Astra and Grok, so all LLMs get the same question.
import { answerSchema, buildPrompt, parseAnswer } from './llm-prompt';

/**
 * Claude Opus 5.5 (Anthropic), System Two.
 * - Thinking can't be turned off on Opus 5.5. `effort` (CLAUDE_EFFORT in .env, default "medium",
 *   the model's own default) sets how much it thinks: low | medium | high | xhigh | max.
 *   Thinking tokens are billed as output tokens (they are inside usage.output_tokens).
 * - Structured output (JSON schema) so the answer is always one of our options.
 * - `fallbacks: "default"`: if a safety classifier declines, the API re-runs the request on
 *   Anthropic's recommended fallback model. We log `servedBy` so the numbers stay honest.
 */
export class ClaudeClient implements DecisionModel {
  readonly key = 'opus' as const;
  readonly label = 'Claude Opus 5.5';
  readonly provider = 'anthropic' as const;
  // The model ID can be overridden in .env, in case Anthropic renames it.
  readonly model = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
  readonly effort = (process.env.CLAUDE_EFFORT || 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  // Created on the first call, so a missing key only matters if Claude is actually used.
  private client?: Anthropic;

  /** Claude joins a demo only when ANTHROPIC_API_KEY is in .env. */
  available(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  /** Ask Claude one "pick an option" question about the state. */
  async choose(state: string, question: ChoiceQuestion, opts: { withReason?: boolean } = {}): Promise<ModelCall<ChoiceAnswer>> {
    // The SDK reads ANTHROPIC_API_KEY from the environment by itself.
    this.client ??= new Anthropic();
    const withReason = opts.withReason ?? false;

    // One request. The beta endpoint is needed for the server-side fallback feature.
    const response = await this.client.beta.messages.create({
      model: this.model,
      // Room for thinking plus the short JSON answer. The answer itself is tiny.
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: this.effort,
        // The JSON schema limits the answer to our option keys: no free text to parse.
        format: { type: 'json_schema', schema: answerSchema(question, withReason) },
      },
      messages: [{ role: 'user', content: buildPrompt(state, question, withReason) }],
    });

    // A refusal has no usable answer: count it as a parse failure instead of guessing.
    const refused = response.stop_reason === 'refusal';
    // The reply is a list of blocks (thinking, text...). Keep only the text blocks: that's the JSON.
    const text = response.content
      .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const { answer, parseOk } = refused ? { answer: { label: null, confidence: null }, parseOk: false } : parseAnswer(text, question);

    return {
      result: answer,
      parseOk,
      // The model that really answered: differs from this.model if the fallback kicked in.
      servedBy: response.model,
      usage: {
        // Cached tokens are still input tokens: count them all, so the cost isn't understated.
        inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
        reasoningTokens: 0, // Anthropic doesn't split thinking out; it is inside output_tokens
      },
    };
  }
}
