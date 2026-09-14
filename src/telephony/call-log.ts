import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';

const log = createLogger('call-log');

export interface CallRecord {
  callSid: string;
  from: string;
  to: string;
  startedAtIso: string;
  endedAtIso: string;
  outcome: string;
  summary?: string;
  bookedTime?: string;
  transcript: Array<{ role: string; text: string }>;
}

/**
 * Flatten the agent's Anthropic message history into a readable transcript.
 * Bot-handled call legs never touch Genesys, so this file is the only call
 * record — keep it.
 */
export function flattenHistory(
  history: ReadonlyArray<Anthropic.MessageParam>,
): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  for (const msg of history) {
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

/** Append one JSON line per call to <dir>/YYYY-MM-DD.jsonl. */
export async function appendCallRecord(dir: string, record: CallRecord): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${record.endedAtIso.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log.error('failed to write call record', err);
  }
}
