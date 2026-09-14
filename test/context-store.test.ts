import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextStore, type TransferContext } from '../src/telephony/context-store.js';

const sample: TransferContext = {
  callSid: 'abc',
  callerNumber: '+15550100999',
  summary: 'Wants to discuss partnership',
  urgency: 'normal',
  transcript: [{ role: 'user', text: 'hello' }],
  createdAtIso: new Date().toISOString(),
};

test('stores and retrieves context by token', () => {
  const store = new ContextStore();
  const token = store.put(sample);
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(store.get(token), sample);
});

test('unknown tokens return undefined', () => {
  const store = new ContextStore();
  assert.equal(store.get('00000000-0000-0000-0000-000000000000'), undefined);
});

test('entries expire after the TTL', async () => {
  const store = new ContextStore(10); // 10 ms TTL
  const token = store.put(sample);
  assert.ok(store.get(token));
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(store.get(token), undefined);
  assert.equal(store.size, 0);
});
