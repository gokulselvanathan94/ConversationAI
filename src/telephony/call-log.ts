import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptEntry } from '../agent/types.js';
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
  /**
   * Bot-handled call legs never touch Genesys, so this transcript is the
   * only call record — keep it.
   */
  transcript: TranscriptEntry[];
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
