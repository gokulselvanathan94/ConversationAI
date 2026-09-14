import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCalendar } from '../src/calendar/memory.js';
import type { SchedulingConfig } from '../src/config.js';

const sched: SchedulingConfig = {
  timezone: 'America/New_York',
  businessStart: '09:00',
  businessEnd: '17:00',
  workDays: [1, 2, 3, 4, 5],
  meetingDurationMin: 30,
  bookingWindowDays: 14,
  minNoticeHours: 2,
};

// Mon Sep 14 2026 through Fri Sep 18 2026, expressed in UTC (EDT = UTC-4).
const MON_9AM_UTC = '2026-09-14T13:00:00.000Z';
const FRI_5PM_UTC = '2026-09-18T21:00:00.000Z';

test('slots fall inside business hours on work days only', async () => {
  const cal = new MemoryCalendar(sched);
  const slots = await cal.findAvailableSlots(MON_9AM_UTC, FRI_5PM_UTC, 30, 1000);

  assert.ok(slots.length > 0);
  // 8h day / 30min = 16 slots x 5 weekdays
  assert.equal(slots.length, 16 * 5);
  assert.equal(slots[0].start, MON_9AM_UTC);
  for (const s of slots) {
    const day = new Date(s.start).toLocaleDateString('en-US', {
      timeZone: sched.timezone,
      weekday: 'short',
    });
    assert.ok(!['Sat', 'Sun'].includes(day), `slot on weekend: ${s.start}`);
  }
});

test('weekend window yields no slots', async () => {
  const cal = new MemoryCalendar(sched);
  const slots = await cal.findAvailableSlots(
    '2026-09-12T00:00:00.000Z', // Saturday
    '2026-09-13T23:59:00.000Z', // Sunday
    30,
    10,
  );
  assert.equal(slots.length, 0);
});

test('booking removes the slot and double-booking fails', async () => {
  const cal = new MemoryCalendar(sched);
  const [first] = await cal.findAvailableSlots(MON_9AM_UTC, FRI_5PM_UTC, 30, 1);

  const ok = await cal.bookMeeting({
    start: first.start,
    end: first.end,
    callerName: 'Ada Lovelace',
    topic: 'Partnership',
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.eventId);

  const after = await cal.findAvailableSlots(MON_9AM_UTC, FRI_5PM_UTC, 30, 5);
  assert.ok(!after.some((s) => s.start === first.start), 'booked slot still offered');

  const dup = await cal.bookMeeting({
    start: first.start,
    end: first.end,
    callerName: 'Grace Hopper',
    topic: 'Overlap',
  });
  assert.equal(dup.ok, false);
});

test('respects the limit parameter', async () => {
  const cal = new MemoryCalendar(sched);
  const slots = await cal.findAvailableSlots(MON_9AM_UTC, FRI_5PM_UTC, 30, 3);
  assert.equal(slots.length, 3);
});
