import type { CallOutcome } from './tools.js';

export interface TranscriptEntry {
  role: string;
  text: string;
}

/**
 * Provider-neutral contract between the telephony layer and whatever AI
 * drives the conversation. Implementations: engine.ts (Anthropic/Claude),
 * engine-openai.ts (OpenAI API and any OpenAI-compatible server: Ollama,
 * vLLM, Groq, Mistral, self-hosted open-weight models, ...).
 */
export interface ConversationEngine {
  /** Spoken immediately on answer, without a model round-trip. */
  greeting(): string;
  /**
   * Respond to one caller utterance, yielding speakable sentences as they
   * stream. Implementations must tolerate the consumer stopping early
   * (barge-in) and keep their internal history truthful.
   */
  respond(userText: string): AsyncGenerator<string, void, void>;
  /** Barge-in: stop generating immediately. Safe to call at any time. */
  abort(): void;
  /** What the model decided via end_call; 'in_progress' until then. */
  readonly outcome: CallOutcome;
  /** Flattened, readable conversation so far (for logs and hand-off). */
  transcript(): TranscriptEntry[];
}
