/**
 * Central configuration, loaded from environment variables.
 * See .env.example for documentation of every variable.
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SchedulingConfig {
  /** IANA timezone the CEO's calendar operates in, e.g. "America/New_York". */
  timezone: string;
  /** Business-day start, 24h "HH:mm" local to `timezone`. */
  businessStart: string;
  /** Business-day end, 24h "HH:mm" local to `timezone`. */
  businessEnd: string;
  /** ISO weekday numbers that are bookable (1 = Monday ... 7 = Sunday). */
  workDays: number[];
  /** Meeting length offered to callers, minutes. */
  meetingDurationMin: number;
  /** How far ahead the bot may book, days. */
  bookingWindowDays: number;
  /** Minimum notice before the earliest offered slot, hours. */
  minNoticeHours: number;
}

export interface GoogleCalendarConfig {
  clientEmail: string;
  privateKey: string;
  calendarId: string;
}

export interface AppConfig {
  anthropic: {
    model: string;
    effort: EffortLevel;
    maxTokens: number;
  };
  bot: {
    /** Name the assistant introduces itself with. */
    botName: string;
    /** Who the assistant works for, e.g. "Jane Smith". */
    ceoName: string;
    companyName: string;
    /** Optional fully custom greeting; overrides the generated one. */
    greetingOverride?: string;
  };
  scheduling: SchedulingConfig;
  calendar: {
    provider: 'memory' | 'google';
    google?: GoogleCalendarConfig;
  };
  server: {
    port: number;
    /** WebSocket path the jambonz application connects to. */
    wsPath: string;
    /** Shared secret for GET /context/:token (Genesys data action). */
    contextApiKey?: string;
    /** Directory where per-call transcript records are appended (JSONL). */
    callLogDir: string;
  };
  genesys: {
    /**
     * SIP URI for handing a call into Genesys Cloud via the BYOC
     * Cloud trunk, e.g. "sip:+15551230000@example.byoc.mypurecloud.com".
     */
    transferSipUri: string;
    /** 2-hex-digit UUI protocol discriminator; must match the trunk setting. */
    uuiProtocolDiscriminator: string;
  };
}

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function parseWorkDays(raw: string | undefined): number[] {
  if (!raw) return [1, 2, 3, 4, 5];
  const days = raw
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return days.length > 0 ? days : [1, 2, 3, 4, 5];
}

function parseTime(raw: string | undefined, fallback: string): string {
  if (raw && /^\d{2}:\d{2}$/.test(raw)) return raw;
  return fallback;
}

function parseIntWithDefault(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const effortRaw = (env.CLAUDE_EFFORT ?? 'low') as EffortLevel;
  const effort = EFFORT_LEVELS.includes(effortRaw) ? effortRaw : 'low';

  const provider = env.CALENDAR_PROVIDER === 'google' ? 'google' : 'memory';
  let google: GoogleCalendarConfig | undefined;
  if (provider === 'google') {
    const clientEmail = env.GOOGLE_CLIENT_EMAIL;
    const privateKey = env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const calendarId = env.GOOGLE_CALENDAR_ID;
    if (!clientEmail || !privateKey || !calendarId) {
      throw new Error(
        'CALENDAR_PROVIDER=google requires GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY and GOOGLE_CALENDAR_ID',
      );
    }
    google = { clientEmail, privateKey, calendarId };
  }

  return {
    anthropic: {
      model: env.ANTHROPIC_MODEL ?? 'claude-opus-5',
      effort,
      maxTokens: parseIntWithDefault(env.CLAUDE_MAX_TOKENS, 2048),
    },
    bot: {
      botName: env.BOT_NAME ?? 'Riley',
      ceoName: env.CEO_NAME ?? 'the CEO',
      companyName: env.COMPANY_NAME ?? 'our company',
      greetingOverride: env.GREETING_TEXT,
    },
    scheduling: {
      timezone: env.TIMEZONE ?? 'America/New_York',
      businessStart: parseTime(env.BUSINESS_START, '09:00'),
      businessEnd: parseTime(env.BUSINESS_END, '17:00'),
      workDays: parseWorkDays(env.WORK_DAYS),
      meetingDurationMin: parseIntWithDefault(env.MEETING_DURATION_MIN, 30),
      bookingWindowDays: parseIntWithDefault(env.BOOKING_WINDOW_DAYS, 14),
      minNoticeHours: parseIntWithDefault(env.MIN_NOTICE_HOURS, 2),
    },
    calendar: { provider, google },
    server: {
      port: parseIntWithDefault(env.PORT, 3000),
      wsPath: env.JAMBONZ_WS_PATH ?? '/assistant',
      contextApiKey: env.CONTEXT_API_KEY || undefined,
      callLogDir: env.CALL_LOG_DIR ?? 'call-logs',
    },
    genesys: {
      transferSipUri: env.GENESYS_TRANSFER_SIP_URI ?? '',
      uuiProtocolDiscriminator: /^[0-9a-fA-F]{2}$/.test(env.UUI_PROTOCOL_DISCRIMINATOR ?? '')
        ? (env.UUI_PROTOCOL_DISCRIMINATOR as string).toLowerCase()
        : '00',
    },
  };
}
