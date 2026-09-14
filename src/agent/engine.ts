import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config.js';
import type { CalendarProvider } from '../calendar/index.js';
import { buildGreeting, buildSystemPrompt, type CallContext } from './prompts.js';
import { buildTools, ToolExecutor, type CallOutcome } from './tools.js';
import { SentenceAssembler } from './sentences.js';
import type { ConversationEngine, TranscriptEntry } from './types.js';
import { createLogger, type Logger } from '../logger.js';

const MAX_LOOP_ITERATIONS = 8;

type MessageStreamT = ReturnType<Anthropic['messages']['stream']>;

/**
 * One CallAgent per phone call. Telephony-agnostic: feed it caller
 * transcripts, it yields sentences to speak. Supports mid-generation abort
 * for barge-in, and reports the call outcome (hang up / transfer) decided by
 * the model through the end_call tool.
 */
export class CallAgent implements ConversationEngine {
  private readonly client: Anthropic;
  private readonly system: string;
  private readonly tools: Anthropic.Tool[];
  private readonly executor: ToolExecutor;
  private readonly messages: Anthropic.MessageParam[] = [];
  private readonly log: Logger;

  private currentStream: MessageStreamT | null = null;
  private abortRequested = false;

  constructor(
    private readonly cfg: AppConfig,
    calendar: CalendarProvider,
    private readonly ctx: CallContext,
  ) {
    this.client = new Anthropic();
    this.system = buildSystemPrompt(cfg, ctx);
    this.tools = buildTools();
    this.executor = new ToolExecutor(cfg, calendar, ctx.callerNumber);
    this.log = createLogger('agent').child(ctx.callerNumber ?? 'unknown-caller');
  }

  /** Spoken immediately on answer, without a model round-trip. */
  greeting(): string {
    return buildGreeting(this.cfg);
  }

  /** What the model decided via end_call; 'in_progress' until then. */
  get outcome(): CallOutcome {
    return this.executor.outcome;
  }

  /** Flattened transcript so far (for logging / the UUI data dip). */
  transcript(): TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    for (const msg of this.messages) {
      if (typeof msg.content === 'string') {
        out.push({ role: msg.role, text: msg.content });
        continue;
      }
      for (const block of msg.content) {
        if (block.type === 'text') {
          out.push({ role: msg.role, text: block.text });
        } else if (block.type === 'tool_use') {
          out.push({ role: 'tool', text: `${block.name} ${JSON.stringify(block.input)}` });
        } else if (block.type === 'tool_result') {
          const content =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          out.push({ role: 'tool_result', text: content });
        }
      }
    }
    return out;
  }

  /** Barge-in: stop generating immediately. Safe to call at any time. */
  abort(): void {
    this.abortRequested = true;
    this.currentStream?.abort();
  }

  /**
   * Respond to one caller utterance. Yields speakable sentences as they
   * stream; runs calendar tools between model iterations. If the consumer
   * stops iterating (barge-in), generation is aborted and the partial reply
   * is kept in history so context stays truthful.
   */
  async *respond(userText: string): AsyncGenerator<string, void, void> {
    this.abortRequested = false;
    this.messages.push({ role: 'user', content: userText });
    let spokenThisTurn = '';
    let partialRecorded = false;

    const recordPartial = () => {
      if (partialRecorded) return;
      partialRecorded = true;
      if (spokenThisTurn) {
        this.messages.push({ role: 'assistant', content: spokenThisTurn });
      }
    };

    try {
      for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration++) {
        const assembler = new SentenceAssembler();
        const stream = this.client.messages.stream({
          model: this.cfg.anthropic.model,
          // Voice replies are deliberately short; tools keep inputs small.
          max_tokens: this.cfg.anthropic.maxTokens,
          output_config: { effort: this.cfg.anthropic.effort },
          system: [
            {
              type: 'text',
              text: this.system,
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: this.tools,
          messages: this.messages,
        });
        this.currentStream = stream;

        try {
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              for (const sentence of assembler.push(event.delta.text)) {
                spokenThisTurn += (spokenThisTurn ? ' ' : '') + sentence;
                yield sentence;
              }
            }
          }
        } finally {
          this.currentStream = null;
        }

        const tail = assembler.flush();
        if (tail) {
          spokenThisTurn += (spokenThisTurn ? ' ' : '') + tail;
          yield tail;
        }

        const message = await stream.finalMessage();
        this.messages.push({ role: 'assistant', content: message.content });
        partialRecorded = true; // full turn recorded

        if (message.stop_reason === 'pause_turn') {
          partialRecorded = false;
          continue;
        }

        if (message.stop_reason === 'tool_use') {
          const toolUses = message.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          );
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            this.log.info(`tool ${tu.name}`, tu.input);
            const result = await this.executor.execute(tu.name, tu.input);
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
          }
          this.messages.push({ role: 'user', content: results });

          // end_call decided: stop generating, the telephony layer acts on
          // `outcome` (hang up or transfer) once speech finishes.
          if (this.executor.outcome.type !== 'in_progress') return;
          partialRecorded = false;
          continue;
        }

        if (message.stop_reason === 'refusal') {
          this.log.warn('model refused', message.stop_details ?? undefined);
          yield "I'm sorry, I can't help with that over the phone. Is there anything else I can do for you?";
        }
        return; // end_turn, max_tokens, refusal
      }
      this.log.warn('tool loop hit iteration cap');
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || this.abortRequested) {
        this.log.info('generation aborted (barge-in)');
        recordPartial();
        return;
      }
      if (err instanceof Anthropic.RateLimitError) {
        this.log.error('rate limited', err);
      } else if (err instanceof Anthropic.APIConnectionError) {
        this.log.error('connection error to Anthropic', err);
      } else if (err instanceof Anthropic.APIError) {
        this.log.error(`API error ${err.status}`, err);
      } else {
        this.log.error('unexpected engine error', err);
      }
      recordPartial();
      yield "I'm sorry, I'm having a little trouble on my end. Could you say that once more?";
      return;
    } finally {
      // Consumer abandoned the generator mid-stream (barge-in via break).
      if (this.currentStream) {
        this.currentStream.abort();
        this.currentStream = null;
        recordPartial();
      }
    }
  }
}
