import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedTimeToUtc,
  dateKeyInTz,
  isoWeekdayInTz,
  formatSpeakable,
  addDays,
} from '../src/calendar/time.js';

test('zonedTimeToUtc handles New York standard time (UTC-5)', () => {
  const d = zonedTimeToUtc('2026-01-15', '09:00', 'America/New_York');
  assert.equal(d.toISOString(), '2026-01-15T14:00:00.000Z');
});

test('zonedTimeToUtc handles New York daylight time (UTC-4)', () => {
  const d = zonedTimeToUtc('2026-07-15', '09:00', 'America/New_York');
  assert.equal(d.toISOString(), '2026-07-15T13:00:00.000Z');
});

test('zonedTimeToUtc handles UTC and eastward zones', () => {
  assert.equal(
    zonedTimeToUtc('2026-03-01', '12:00', 'UTC').toISOString(),
    '2026-03-01T12:00:00.000Z',
  );
  // Kolkata is UTC+5:30 year-round.
  assert.equal(
    zonedTimeToUtc('2026-03-01', '09:00', 'Asia/Kolkata').toISOString(),
    '2026-03-01T03:30:00.000Z',
  );
});

test('dateKeyInTz and isoWeekdayInTz agree with the zone, not UTC', () => {
  // 2026-01-16 01:00 UTC is still Jan 15 (Thursday) in New York.
  const d = new Date('2026-01-16T01:00:00Z');
  assert.equal(dateKeyInTz(d, 'America/New_York'), '2026-01-15');
  assert.equal(isoWeekdayInTz(d, 'America/New_York'), 4);
});

test('formatSpeakable renders a natural phrase', () => {
  const d = new Date('2026-09-15T18:30:00Z'); // 2:30 PM EDT
  const s = formatSpeakable(d, 'America/New_York');
  assert.match(s, /Tuesday, September 15 at 2:30/);
});

test('addDays crosses month boundaries', () => {
  assert.equal(addDays('2026-01-30', 3), '2026-02-02');
});
