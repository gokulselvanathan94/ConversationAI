import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeUuiHex, decodeUuiHex } from '../src/telephony/uui.js';

test('round-trips a token through hex UUI encoding', () => {
  const token = 'ab12cd34-5678-90ef-abcd-1234567890ab';
  const encoded = encodeUuiHex(token, '00');
  assert.match(encoded, /^00[0-9a-f]+;encoding=hex$/);
  assert.equal(decodeUuiHex(encoded), token);
});

test('protocol discriminator is prefixed and validated', () => {
  const encoded = encodeUuiHex('hi', '5a');
  assert.ok(encoded.startsWith('5a'));
  assert.equal(decodeUuiHex(encoded), 'hi');
  assert.throws(() => encodeUuiHex('hi', 'xyz'));
  assert.throws(() => encodeUuiHex('hi', '0'));
});

test('decode rejects non-hex payloads', () => {
  assert.throws(() => decodeUuiHex('nothex;encoding=hex'));
  assert.throws(() => decodeUuiHex('abc')); // odd length
});

test('stays within the 128-char interop budget for a UUID token', () => {
  const encoded = encodeUuiHex('ab12cd34-5678-90ef-abcd-1234567890ab');
  assert.ok(encoded.length <= 128, `UUI too long: ${encoded.length}`);
});
