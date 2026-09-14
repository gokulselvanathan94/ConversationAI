import type { AppConfig } from '../config.js';
import type { CalendarProvider } from './types.js';
import { MemoryCalendar } from './memory.js';
import { GoogleCalendar } from './google.js';

export function createCalendar(cfg: AppConfig): CalendarProvider {
  if (cfg.calendar.provider === 'google' && cfg.calendar.google) {
    return new GoogleCalendar(cfg.scheduling, cfg.calendar.google);
  }
  return new MemoryCalendar(cfg.scheduling);
}

export type { CalendarProvider, TimeSlot, BookingRequest, BookingResult } from './types.js';
