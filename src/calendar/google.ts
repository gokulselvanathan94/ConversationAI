import jwt from 'jsonwebtoken';
import type { GoogleCalendarConfig, SchedulingConfig } from '../config.js';
import type { BookingRequest, BookingResult, CalendarProvider, TimeSlot } from './types.js';
import { generateBusinessSlots, overlaps } from './slots.js';
import { createLogger } from '../logger.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

const log = createLogger('google-calendar');

interface BusyPeriod {
  start: string;
  end: string;
}

/**
 * Google Calendar via a service account.
 *
 * Setup: create a service account in Google Cloud, enable the Calendar API,
 * then share the CEO's calendar with the service account email (with
 * "Make changes to events" permission). No domain-wide delegation needed
 * for a shared calendar.
 */
export class GoogleCalendar implements CalendarProvider {
  readonly name = 'google';
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly sched: SchedulingConfig,
    private readonly cfg: GoogleCalendarConfig,
  ) {}

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) return this.accessToken;

    const iat = Math.floor(now / 1000);
    const assertion = jwt.sign(
      { iss: this.cfg.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 },
      this.cfg.privateKey,
      { algorithm: 'RS256' },
    );

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + data.expires_in * 1000;
    return this.accessToken;
  }

  private async getBusy(fromIso: string, toIso: string): Promise<BusyPeriod[]> {
    const token = await this.getAccessToken();
    const res = await fetch(`${CALENDAR_API}/freeBusy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        timeMin: fromIso,
        timeMax: toIso,
        items: [{ id: this.cfg.calendarId }],
      }),
    });
    if (!res.ok) {
      throw new Error(`freeBusy query failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      calendars: Record<string, { busy?: BusyPeriod[]; errors?: unknown[] }>;
    };
    const cal = data.calendars?.[this.cfg.calendarId];
    if (!cal || cal.errors?.length) {
      throw new Error(`freeBusy returned errors for calendar ${this.cfg.calendarId}`);
    }
    return cal.busy ?? [];
  }

  async findAvailableSlots(
    fromIso: string,
    toIso: string,
    durationMin: number,
    limit: number,
  ): Promise<TimeSlot[]> {
    const [candidates, busy] = await Promise.all([
      Promise.resolve(generateBusinessSlots(this.sched, fromIso, toIso, durationMin)),
      this.getBusy(fromIso, toIso),
    ]);
    const free = candidates.filter(
      (slot) => !busy.some((b) => overlaps(slot.start, slot.end, b.start, b.end)),
    );
    return free.slice(0, limit);
  }

  async bookMeeting(request: BookingRequest): Promise<BookingResult> {
    // Re-check the slot right before writing to narrow the race window.
    const busy = await this.getBusy(request.start, request.end);
    if (busy.some((b) => overlaps(request.start, request.end, b.start, b.end))) {
      return { ok: false, error: 'That time was just taken. Please pick another slot.' };
    }

    const token = await this.getAccessToken();
    const descriptionLines = [
      `Booked by the AI phone assistant.`,
      `Caller: ${request.callerName}`,
      request.callerCompany ? `Company: ${request.callerCompany}` : '',
      request.callerPhone ? `Phone: ${request.callerPhone}` : '',
      `Topic: ${request.topic}`,
    ].filter(Boolean);

    const params = new URLSearchParams();
    if (request.callerEmail) params.set('sendUpdates', 'all');
    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(this.cfg.calendarId)}/events${
      params.size ? `?${params}` : ''
    }`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        summary: `Call: ${request.callerName} — ${request.topic}`.slice(0, 250),
        description: descriptionLines.join('\n'),
        start: { dateTime: request.start },
        end: { dateTime: request.end },
        ...(request.callerEmail ? { attendees: [{ email: request.callerEmail }] } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      log.error('event insert failed', { status: res.status, body });
      return { ok: false, error: 'The calendar rejected the booking.' };
    }
    const event = (await res.json()) as { id: string };
    return { ok: true, eventId: event.id, start: request.start, end: request.end };
  }
}
