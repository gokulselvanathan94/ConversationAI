import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '../src/agent/tools.js';
import { toOpenAiTools } from '../src/agent/engine-openai.js';

test('maps shared tool schemas to OpenAI function format', () => {
  const tools = toOpenAiTools(buildTools());
  assert.equal(tools.length, 3);
  assert.deepEqual(
    tools.map((t) => t.type === 'function' && t.function.name),
    ['check_availability', 'book_meeting', 'end_call'],
  );
  for (const t of tools) {
    assert.equal(t.type, 'function');
    if (t.type !== 'function') continue;
    assert.ok(t.function.description && t.function.description.length > 0);
    const params = t.function.parameters as { type: string; required: string[] };
    assert.equal(params.type, 'object');
    assert.ok(Array.isArray(params.required));
  }
});
