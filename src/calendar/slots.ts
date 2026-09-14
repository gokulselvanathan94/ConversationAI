import type { SchedulingConfig } from '../config.js';
import type { TimeSlot } from './types.js';
import { addDays, dateKeyInTz, isoWeekdayInTz, zonedTimeToUtc } from './time.js';

/**
 * All candidate slots of `durationMin` minutes that lie inside business
 * hours/work days (in the configured timezone) and inside [fromIso, toIso].
 * Providers subtract busy periods from this set.
 */
export function generateBusinessSlots(
  sched: SchedulingConfig,
  fromIso: string,
  toIso: string,
  durationMin: number,
): TimeSlot[] {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (!(from.getTime() < to.getTime())) return [];

  const slots: TimeSlot[] = [];
  const durationMs = durationMin * 60_000;

  let day = dateKeyInTz(from, sched.timezone);
  const lastDay = dateKeyInTz(to, sched.timezone);

  // Iterate calendar days in the scheduling timezone.
  for (let guard = 0; guard < 400; guard++) {
    const dayStart = zonedTimeToUtc(day, sched.businessStart, sched.timezone);
    const dayEnd = zonedTimeToUtc(day, sched.businessEnd, sched.timezone);

    if (sched.workDays.includes(isoWeekdayInTz(dayStart, sched.timezone))) {
      for (
        let start = dayStart.getTime();
        start + durationMs <= dayEnd.getTime();
        start += durationMs
      ) {
        const end = start + durationMs;
        if (start >= from.getTime() && end <= to.getTime()) {
          slots.push({
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
          });
        }
      }
    }

    if (day === lastDay) break;
    day = addDays(day, 1);
  }
  return slots;
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart).getTime() < new Date(bEnd).getTime() &&
    new Date(bStart).getTime() < new Date(aEnd).getTime();
}
