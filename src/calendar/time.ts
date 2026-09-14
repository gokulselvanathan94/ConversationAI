/**
 * Timezone helpers built on Intl only — no date library dependency.
 * Everything the scheduler needs: convert a wall-clock time in an IANA
 * timezone to a UTC instant, and format instants for speech.
 */

/** Milliseconds the given timezone is ahead of UTC at `date`. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads
 * `dateStr` (YYYY-MM-DD) `timeStr` (HH:mm).
 */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm);
  let offset = tzOffsetMs(new Date(utcGuess), timeZone);
  let ts = utcGuess - offset;
  // A DST transition between the guess and the result can shift the offset;
  // one correction pass settles it.
  const offset2 = tzOffsetMs(new Date(ts), timeZone);
  if (offset2 !== offset) ts = utcGuess - offset2;
  return new Date(ts);
}

/** "YYYY-MM-DD" of `date` as seen in `timeZone`. */
export function dateKeyInTz(date: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(date);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of `date` as seen in `timeZone`. */
export function isoWeekdayInTz(date: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[name] ?? 1;
}

/** Human, speech-friendly rendering: "Tuesday, September 15 at 2:30 PM". */
export function formatSpeakable(date: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  return `${day} at ${time}`;
}

/** Add `days` calendar days to a YYYY-MM-DD string. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
