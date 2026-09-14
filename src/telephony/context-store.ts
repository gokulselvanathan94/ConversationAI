import { randomUUID } from 'node:crypto';

export interface TransferContext {
  callSid: string;
  callerNumber?: string;
  summary: string;
  urgency: 'normal' | 'urgent';
  bookedTime?: string;
  transcript: Array<{ role: string; text: string }>;
  createdAtIso: string;
}

interface Entry {
  context: TransferContext;
  expiresAt: number;
}

/**
 * Short-lived store of transfer context, keyed by the correlation token we
 * place in the UUI header. Genesys Architect data-dips
 * GET /context/:token on this server to retrieve the full context for
 * participant data and the agent screen pop.
 */
export class ContextStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs = 60 * 60 * 1000) {}

  put(context: TransferContext): string {
    this.prune();
    const token = randomUUID();
    this.entries.set(token, { context, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  get(token: string): TransferContext | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(token);
      return undefined;
    }
    return entry.context;
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(token);
    }
  }
}
