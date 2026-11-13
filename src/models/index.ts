/**
 * The model registry: one place that knows every model in the project.
 * Everything else asks here: "which models can run?", "give me Jev", "give me the one called opus".
 */

// Loads .env into process.env as soon as any code touches the models (API keys, model IDs).
import 'dotenv/config';
import type { DecisionModel, ModelKey } from '../types';
import { ClaudeClient } from './claude';
import { JevClient } from './jev';
import { astra, grok } from './openai-compatible';

// Re-exported so callers can import the Jev class from '../models' too.
export { JevClient } from './jev';

/** One instance of each model. Read lazily so .env is loaded first. */
let registry: Record<ModelKey, DecisionModel> | undefined;

/** All four models, keyed by short name. Created on the first call, then reused. */
export function models(): Record<ModelKey, DecisionModel> {
  registry ??= { jev: new JevClient(), opus: new ClaudeClient(), astra: astra(), grok: grok() };
  return registry;
}

/** Jev with its full type, for code that needs Jev-only features (ask() with several questions). */
export function jev(): JevClient {
  return models().jev as JevClient;
}

/** The models whose API key is set, in a stable order. */
export function availableModels(): DecisionModel[] {
  return Object.values(models()).filter((m) => m.available());
}

/** Look up a model by its short name (from .env or the CLI). A typo fails loudly with the valid names. */
export function modelByKey(key: string): DecisionModel {
  const model = models()[key as ModelKey];
  if (!model) throw new Error(`Unknown model "${key}". Use one of: ${Object.keys(models()).join(', ')}`);
  return model;
}
