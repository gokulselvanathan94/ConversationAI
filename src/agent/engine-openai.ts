import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config.js';
import type { CalendarProvider } from '../calendar/index.js';
import { buildGreeting, buildSystemPrompt, type CallContext } from './prompts.js';
import { buildTools, ToolExecutor, type CallOutcome } from './tools.js';
import { SentenceAssembler } from './sentences.js';
import type { ConversationEngine, TranscriptEntry } from './types.js';
import { createLogger, type Logger } from '../logger.js';

const MAX_LOOP_ITERATIONS = 8;

/**
 * Convert the (JSON Schema) tool definitions shared with the Claude engine
 * into OpenAI function-calling format. Same schemas, different envelope.
 */
export function toOpenAiTools(
  tools: Anthropic.Tool[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema as Record<string, unknown>,
      strict: true,
    },
  }));
}

/**
 * ConversationEngine backed by the OpenAI Chat Completions API — which is
 * also the de-facto standard for self-hosted and third-party models. Point
 * OPENAI_BASE_URL at:
 *   - https://api.openai.com/v1            (OpenAI GPT models)
 *   - http://your-gpu-host:11434/v1        (Ollama — Llama, Qwen, gpt-oss, ...)
 *   - http://your-gpu-host:8000/v1         (vLLM serving an open-weight model)
 *   - https://api.groq.com/openai/v1  etc. (hosted open-weight providers)
 */
export class OpenAICallAgent implements ConversationEngine {
  private readonly client: OpenAI;
  private readonly executor: ToolExecutor;
  private readonly tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  private readonly messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private readonly log: Logger;
  private readonly model: string;
  private readonly maxTokens: number;

  private currentAbort: AbortController | null = null;
  private abortRequested = false;

  constructor(
    private readonly cfg: AppConfig,
    calendar: CalendarProvider,
    ctx: CallContext,
  ) {
    if (!cfg.openai) throw new Error('openai engine selected but OPENAI_MODEL is not configured');
    this.client = new OpenAI({
      baseURL: cfg.openai.baseUrl,
      apiKey: cfg.openai.apiKey,
    });
    this.model = cfg.openai.model;
    this.maxTokens = cfg.anthropic.maxTokens;
    this.tools = toOpenAiTools(buildTools());
    this.executor = new ToolExecutor(cfg, calendar, ctx.callerNumber);
    this.messages.push({ role: 'system', content: buildSystemPrompt(cfg, ctx) });
    this.log = createLogger('agent-openai').child(ctx.callerNumber ?? 'unknown-caller');
  }

  greeting(): string {
    return buildGreeting(this.cfg);
  }

  get outcome(): CallOutcome {
    return this.executor.outcome;
  }

  transcript(): TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    for (const msg of this.messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'tool') {
        out.push({ role: 'tool_result', text: String(msg.content) });
        continue;
      }
      if (typeof msg.content === 'string' && msg.content) {
        out.push({ role: msg.role, text: msg.content });
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === 'function') {
            out.push({ role: 'tool', text: `${tc.function.name} ${tc.function.arguments}` });
          }
        }
      }
    }
    return out;
  }

  abort(): void {
    this.abortRequested = true;
    this.currentAbort?.abort();
  }

  async *respond(userText: string): AsyncGenerator<string, void, void> {
    this.abortRequested = false;
    this.messages.push({ role: 'user', content: userText });
    let spokenThisTurn = '';
    let partialRecorded = false;

    const recordPartial = () => {
      if (partialRecorded) return;
      partialRecorded = true;
      if (spokenThisTurn) this.messages.push({ role: 'assistant', content: spokenThisTurn });
    };

    try {
      for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration++) {
        const assembler = new SentenceAssembler();
        const controller = new AbortController();
        this.currentAbort = controller;

        let text = '';
        // Assembled from streamed deltas, keyed by tool_call index.
        const toolCalls = new Map<number, { id: string; name: string; args: string }>();
        let finishReason: string | null = null;

        try {
          const stream = await this.client.chat.completions.create(
            {
              model: this.model,
              max_tokens: this.maxTokens,
              stream: true,
              tools: this.tools,
              messages: this.messages,
            },
            { signal: controller.signal },
          );

          for await (const chunk of stream) {
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;

            const delta = choice.delta;
            if (delta?.content) {
              text += delta.content;
              for (const sentence of assembler.push(delta.content)) {
                spokenThisTurn += (spokenThisTurn ? ' ' : '') + sentence;
                yield sentence;
              }
            }
            for (const tc of delta?.tool_calls ?? []) {
              const entry = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
              toolCalls.set(tc.index, entry);
            }
          }
        } finally {
          this.currentAbort = null;
        }

        const tail = assembler.flush();
        if (tail) {
          spokenThisTurn += (spokenThisTurn ? ' ' : '') + tail;
          yield tail;
        }

        const assembledCalls = [...toolCalls.values()].filter((c) => c.id && c.name);
        this.messages.push({
          role: 'assistant',
          content: text || null,
          ...(assembledCalls.length > 0
            ? {
                tool_calls: assembledCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.args },
                })),
              }
            : {}),
        });
        partialRecorded = true;

        if (finishReason === 'tool_calls' || assembledCalls.length > 0) {
          for (const call of assembledCalls) {
            let input: unknown = {};
            try {
              input = call.args ? JSON.parse(call.args) : {};
            } catch {
              this.log.warn('tool call arguments were not valid JSON', { call });
            }
            this.log.info(`tool ${call.name}`, input);
            const result = await this.executor.execute(call.name, input);
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
          }
          if (this.executor.outcome.type !== 'in_progress') return;
          partialRecorded = false;
          continue;
        }
        return; // stop / length
      }
      this.log.warn('tool loop hit iteration cap');
    } catch (err) {
      if (err instanceof OpenAI.APIUserAbortError || this.abortRequested) {
        this.log.info('generation aborted (barge-in)');
        recordPartial();
        return;
      }
      if (err instanceof OpenAI.RateLimitError) {
        this.log.error('rate limited', err);
      } else if (err instanceof OpenAI.APIConnectionError) {
        this.log.error(`connection error to ${this.cfg.openai?.baseUrl}`, err);
      } else if (err instanceof OpenAI.APIError) {
        this.log.error(`API error ${err.status}`, err);
      } else {
        this.log.error('unexpected engine error', err);
      }
      recordPartial();
      yield "I'm sorry, I'm having a little trouble on my end. Could you say that once more?";
      return;
    } finally {
      if (this.currentAbort) {
        this.currentAbort.abort();
        this.currentAbort = null;
        recordPartial();
      }
    }
  }
}
