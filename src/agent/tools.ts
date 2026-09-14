import type Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config.js';
import type { BookingResult, CalendarProvider } from '../calendar/index.js';
import { formatSpeakable } from '../calendar/time.js';
import { createLogger } from '../logger.js';

const log = createLogger('tools');

export type CallOutcome =
  | { type: 'in_progress' }
  | {
      type: 'completed' | 'transfer_to_human';
      summary: string;
      urgency: 'normal' | 'urgent';
      booking?: BookingResult & { speakableTime?: string };
    };

/** Stable tool list — order and content never change, so it caches well. */
export function buildTools(): Anthropic.Tool[] {
  return [
    {
      name: 'check_availability',
      description:
        "Look up open meeting slots on the CEO's calendar. Always call this before offering any time to the caller. Returns numbered options with exact start times.",
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          from_date: {
            type: 'string',
            description:
              "First day to consider, formatted YYYY-MM-DD in the office timezone. Use today's date unless the caller asked for a later week.",
          },
          days: {
            type: 'integer',
            description: 'How many days ahead of from_date to search, between 1 and 14.',
          },
          max_results: {
            type: 'integer',
            description: 'Maximum number of slots to return, between 1 and 6.',
          },
        },
        required: ['from_date', 'days', 'max_results'],
        additionalProperties: false,
      },
    },
    {
      name: 'book_meeting',
      description:
        'Book a meeting on a slot previously returned by check_availability, after the caller has confirmed the time out loud. Returns confirmation or an error.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          start: {
            type: 'string',
            description:
              'Exact ISO-8601 UTC start of the chosen slot, copied verbatim from a check_availability result.',
          },
          caller_name: { type: 'string', description: "The caller's full name." },
          caller_company: {
            type: 'string',
            description: "The caller's company, or an empty string if not applicable.",
          },
          caller_email: {
            type: 'string',
            description:
              "The caller's email address for the calendar invite, or an empty string if they did not provide one.",
          },
          topic: {
            type: 'string',
            description: 'Short description of what the meeting is about, from the caller.',
          },
        },
        required: ['start', 'caller_name', 'caller_company', 'caller_email', 'topic'],
        additionalProperties: false,
      },
    },
    {
      name: 'end_call',
      description:
        'Finish the call after you have said goodbye (or told the caller you are transferring them). Nothing you write after calling this will be spoken.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['completed', 'transfer_to_human'],
            description:
              'completed = hang up normally. transfer_to_human = connect the caller to a human agent now.',
          },
          summary: {
            type: 'string',
            description:
              'Concise handoff summary: caller name, company, reason for calling, and the result (meeting time booked, why they need a human, or why declined).',
          },
          urgency: {
            type: 'string',
            enum: ['normal', 'urgent'],
            description: 'urgent only when the matter needs immediate human attention.',
          },
        },
        required: ['outcome', 'summary', 'urgency'],
        additionalProperties: false,
      },
    },
  ];
}

/** Executes tool calls against the calendar and records the call outcome. */
export class ToolExecutor {
  outcome: CallOutcome = { type: 'in_progress' };

  constructor(
    private readonly cfg: AppConfig,
    private readonly calendar: CalendarProvider,
    private readonly callerNumber?: string,
  ) {}

  async execute(name: string, input: unknown): Promise<string> {
    try {
      switch (name) {
        case 'check_availability':
          return await this.checkAvailability(input as {
            from_date: string;
            days: number;
            max_results: number;
          });
        case 'book_meeting':
          return await this.bookMeeting(input as {
            start: string;
            caller_name: string;
            caller_company: string;
            caller_email: string;
            topic: string;
          });
        case 'end_call':
          return this.endCall(input as {
            outcome: 'completed' | 'transfer_to_human';
            summary: string;
            urgency: 'normal' | 'urgent';
          });
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      log.error(`tool ${name} failed`, err);
      return 'The tool failed with an internal error. Apologize briefly and offer to have someone follow up.';
    }
  }

  private async checkAvailability(input: {
    from_date: string;
    days: number;
    max_results: number;
  }): Promise<string> {
    const sched = this.cfg.scheduling;
    const days = Math.min(Math.max(input.days, 1), sched.bookingWindowDays);
    const max = Math.min(Math.max(input.max_results, 1), 6);

    const earliest = new Date(Date.now() + sched.minNoticeHours * 3_600_000);
    let from = new Date(`${input.from_date}T00:00:00Z`);
    if (Number.isNaN(from.getTime()) || from < earliest) from = earliest;
    const to = new Date(from.getTime() + days * 86_400_000);

    const slots = await this.calendar.findAvailableSlots(
      from.toISOString(),
      to.toISOString(),
      sched.meetingDurationMin,
      max,
    );

    if (slots.length === 0) {
      return `No open slots in that window. Try a later from_date or more days (booking window is ${sched.bookingWindowDays} days).`;
    }
    const lines = slots.map(
      (s, i) =>
        `${i + 1}. start=${s.start} — say it as "${formatSpeakable(new Date(s.start), sched.timezone)}"`,
    );
    return `Open ${sched.meetingDurationMin}-minute slots (office timezone ${sched.timezone}):\n${lines.join('\n')}\nOffer two or three; pass the chosen start verbatim to book_meeting.`;
  }

  private async bookMeeting(input: {
    start: string;
    caller_name: string;
    caller_company: string;
    caller_email: string;
    topic: string;
  }): Promise<string> {
    const sched = this.cfg.scheduling;
    const start = new Date(input.start);
    if (Number.isNaN(start.getTime())) {
      return 'Invalid start time. Use the exact ISO start from check_availability.';
    }
    const end = new Date(start.getTime() + sched.meetingDurationMin * 60_000);

    const result = await this.calendar.bookMeeting({
      start: start.toISOString(),
      end: end.toISOString(),
      callerName: input.caller_name,
      callerCompany: input.caller_company || undefined,
      callerEmail: input.caller_email || undefined,
      callerPhone: this.callerNumber,
      topic: input.topic,
    });

    if (!result.ok) {
      return `Booking failed: ${result.error ?? 'unknown error'}. Re-run check_availability and offer fresh options.`;
    }
    const speakable = formatSpeakable(start, sched.timezone);
    this.lastBooking = { ...result, speakableTime: speakable };
    return `Booked. Event ${result.eventId} on ${speakable} (${sched.timezone}). Confirm this to the caller in words.`;
  }

  private lastBooking?: BookingResult & { speakableTime?: string };

  private endCall(input: {
    outcome: 'completed' | 'transfer_to_human';
    summary: string;
    urgency: 'normal' | 'urgent';
  }): string {
    this.outcome = {
      type: input.outcome,
      summary: input.summary,
      urgency: input.urgency,
      booking: this.lastBooking,
    };
    return 'Acknowledged. The call will now end; do not write anything else.';
  }
}
