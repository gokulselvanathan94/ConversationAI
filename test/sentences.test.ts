import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentenceAssembler } from '../src/agent/sentences.js';

test('emits sentences as deltas arrive', () => {
  const a = new SentenceAssembler();
  const out: string[] = [];
  out.push(...a.push('Hello there. How can '));
  out.push(...a.push('I help you today? Let me check.'));
  const tail = a.flush();

  assert.deepEqual(out, ['Hello there.', 'How can I help you today?']);
  assert.equal(tail, 'Let me check.');
});

test('does not split decimals or short fragments', () => {
  const a = new SentenceAssembler();
  const out = a.push('The price is 2.30 dollars today. Next sentence here.');
  const tail = a.flush();
  assert.deepEqual(out, ['The price is 2.30 dollars today.']);
  assert.equal(tail, 'Next sentence here.');
});

test('does not split after common abbreviations', () => {
  const a = new SentenceAssembler();
  const out = a.push('You can meet with Dr. Smith on Tuesday. Sound good?');
  const tail = a.flush();
  assert.deepEqual(out, ['You can meet with Dr. Smith on Tuesday.']);
  assert.equal(tail, 'Sound good?');
});

test('newlines force a flush', () => {
  const a = new SentenceAssembler();
  const out = a.push('First line\nsecond line continues');
  assert.deepEqual(out, ['First line']);
  assert.equal(a.flush(), 'second line continues');
});

test('flush on empty buffer returns empty string', () => {
  const a = new SentenceAssembler();
  assert.equal(a.flush(), '');
});
