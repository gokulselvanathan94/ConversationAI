import type { AppConfig } from '../config.js';
import type { CalendarProvider } from '../calendar/index.js';
import type { CallContext } from './prompts.js';
import type { ConversationEngine } from './types.js';
import { CallAgent } from './engine.js';
import { OpenAICallAgent } from './engine-openai.js';

/** Pick the conversation engine from config (LLM_PROVIDER). */
export function createEngine(
  cfg: AppConfig,
  calendar: CalendarProvider,
  ctx: CallContext,
): ConversationEngine {
  if (cfg.llmProvider === 'openai') return new OpenAICallAgent(cfg, calendar, ctx);
  return new CallAgent(cfg, calendar, ctx);
}

export type { ConversationEngine, TranscriptEntry } from './types.js';
export type { CallOutcome } from './tools.js';
export type { CallContext } from './prompts.js';
