export interface TimeSlot {
  /** ISO-8601 UTC instant the slot starts. */
  start: string;
  /** ISO-8601 UTC instant the slot ends. */
  end: string;
}

export interface BookingRequest {
  /** ISO-8601 UTC start; must be a slot previously returned as available. */
  start: string;
  /** ISO-8601 UTC end. */
  end: string;
  callerName: string;
  callerCompany?: string;
  callerPhone?: string;
  callerEmail?: string;
  topic: string;
}

export interface BookingResult {
  ok: boolean;
  eventId?: string;
  error?: string;
  start?: string;
  end?: string;
}

export interface CalendarProvider {
  readonly name: string;
  /**
   * Free slots of `durationMin` minutes between the two UTC instants,
   * respecting business hours/work days. Returns at most `limit` slots,
   * earliest first.
   */
  findAvailableSlots(
    fromIso: string,
    toIso: string,
    durationMin: number,
    limit: number,
  ): Promise<TimeSlot[]>;
  bookMeeting(request: BookingRequest): Promise<BookingResult>;
}
