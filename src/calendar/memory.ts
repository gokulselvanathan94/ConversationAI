import type { SchedulingConfig } from '../config.js';
import type { BookingRequest, BookingResult, CalendarProvider, TimeSlot } from './types.js';
import { generateBusinessSlots, overlaps } from './slots.js';

interface StoredBooking extends BookingRequest {
  eventId: string;
}

/**
 * In-memory calendar for development and demos: every business-hours slot is
 * free until the bot books it. Swap for the Google provider in production.
 */
export class MemoryCalendar implements CalendarProvider {
  readonly name = 'memory';
  private readonly bookings: StoredBooking[] = [];
  private counter = 0;

  constructor(private readonly sched: SchedulingConfig, seed: BookingRequest[] = []) {
    for (const b of seed) this.store(b);
  }

  private store(request: BookingRequest): StoredBooking {
    const booking: StoredBooking = { ...request, eventId: `mem-${++this.counter}` };
    this.bookings.push(booking);
    return booking;
  }

  async findAvailableSlots(
    fromIso: string,
    toIso: string,
    durationMin: number,
    limit: number,
  ): Promise<TimeSlot[]> {
    const candidates = generateBusinessSlots(this.sched, fromIso, toIso, durationMin);
    const free = candidates.filter(
      (slot) => !this.bookings.some((b) => overlaps(slot.start, slot.end, b.start, b.end)),
    );
    return free.slice(0, limit);
  }

  async bookMeeting(request: BookingRequest): Promise<BookingResult> {
    const conflict = this.bookings.some((b) =>
      overlaps(request.start, request.end, b.start, b.end),
    );
    if (conflict) {
      return { ok: false, error: 'That time was just taken. Please pick another slot.' };
    }
    const stored = this.store(request);
    return { ok: true, eventId: stored.eventId, start: request.start, end: request.end };
  }

  /** For tests and inspection. */
  listBookings(): ReadonlyArray<StoredBooking> {
    return this.bookings;
  }
}
