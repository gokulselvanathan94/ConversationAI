import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('defaults are sane with an empty environment', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.anthropic.model, 'claude-opus-5');
  assert.equal(cfg.anthropic.effort, 'low');
  assert.equal(cfg.calendar.provider, 'memory');
  assert.equal(cfg.scheduling.timezone, 'America/New_York');
  assert.deepEqual(cfg.scheduling.workDays, [1, 2, 3, 4, 5]);
  assert.equal(cfg.scheduling.meetingDurationMin, 30);
});

test('environment overrides are applied and validated', () => {
  const cfg = loadConfig({
    ANTHROPIC_MODEL: 'claude-sonnet-5',
    CLAUDE_EFFORT: 'medium',
    TIMEZONE: 'Europe/London',
    BUSINESS_START: '08:30',
    BUSINESS_END: '18:00',
    WORK_DAYS: '1,2,3',
    MEETING_DURATION_MIN: '45',
    CEO_NAME: 'Jane Smith',
  });
  assert.equal(cfg.anthropic.model, 'claude-sonnet-5');
  assert.equal(cfg.anthropic.effort, 'medium');
  assert.equal(cfg.scheduling.timezone, 'Europe/London');
  assert.equal(cfg.scheduling.businessStart, '08:30');
  assert.deepEqual(cfg.scheduling.workDays, [1, 2, 3]);
  assert.equal(cfg.scheduling.meetingDurationMin, 45);
  assert.equal(cfg.bot.ceoName, 'Jane Smith');
});

test('invalid effort falls back to low; invalid times fall back to defaults', () => {
  const cfg = loadConfig({ CLAUDE_EFFORT: 'turbo', BUSINESS_START: '9am' });
  assert.equal(cfg.anthropic.effort, 'low');
  assert.equal(cfg.scheduling.businessStart, '09:00');
});

test('llm provider defaults to anthropic; openai requires a model', () => {
  assert.equal(loadConfig({}).llmProvider, 'anthropic');
  assert.throws(() => loadConfig({ LLM_PROVIDER: 'openai' }));
  const cfg = loadConfig({ LLM_PROVIDER: 'openai', OPENAI_MODEL: 'qwen2.5:32b' });
  assert.equal(cfg.llmProvider, 'openai');
  assert.equal(cfg.openai?.model, 'qwen2.5:32b');
  assert.equal(cfg.openai?.baseUrl, 'https://api.openai.com/v1');
  const local = loadConfig({
    LLM_PROVIDER: 'openai',
    OPENAI_MODEL: 'llama3.3:70b',
    OPENAI_BASE_URL: 'http://gpu-box:11434/v1',
  });
  assert.equal(local.openai?.baseUrl, 'http://gpu-box:11434/v1');
  assert.equal(local.openai?.apiKey, 'not-needed');
});

test('google provider requires credentials', () => {
  assert.throws(() => loadConfig({ CALENDAR_PROVIDER: 'google' }));
  const cfg = loadConfig({
    CALENDAR_PROVIDER: 'google',
    GOOGLE_CLIENT_EMAIL: 'svc@project.iam.gserviceaccount.com',
    GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    GOOGLE_CALENDAR_ID: 'ceo@example.com',
  });
  assert.equal(cfg.calendar.provider, 'google');
  assert.ok(cfg.calendar.google?.privateKey.includes('\n'));
});
