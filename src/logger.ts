/** Minimal structured logger with per-call child loggers. No dependencies. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configured: Level = (['debug', 'info', 'warn', 'error'] as Level[]).includes(
  process.env.LOG_LEVEL as Level,
)
  ? (process.env.LOG_LEVEL as Level)
  : 'info';

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(context: string): Logger;
}

function emit(level: Level, context: string, msg: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configured]) return;
  const ts = new Date().toISOString();
  const prefix = context ? `[${ts}] ${level.toUpperCase()} (${context})` : `[${ts}] ${level.toUpperCase()}`;
  const line = extra !== undefined ? `${prefix} ${msg} ${safeStringify(extra)}` : `${prefix} ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(context = ''): Logger {
  return {
    debug: (msg, extra) => emit('debug', context, msg, extra),
    info: (msg, extra) => emit('info', context, msg, extra),
    warn: (msg, extra) => emit('warn', context, msg, extra),
    error: (msg, extra) => emit('error', context, msg, extra),
    child: (sub: string) => createLogger(context ? `${context}:${sub}` : sub),
  };
}

export const logger = createLogger();
