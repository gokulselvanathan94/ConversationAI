/**
 * Local text harness: talk to the CEO assistant in your terminal, no
 * telephony needed. Requires ANTHROPIC_API_KEY (or `ant auth login`).
 *
 *   npm run chat
 */
import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../src/config.js';
import { createCalendar } from '../src/calendar/index.js';
import { CallAgent } from '../src/agent/engine.js';

const cfg = loadConfig();
const calendar = createCalendar(cfg);
const agent = new CallAgent(cfg, calendar, {
  callerNumber: '+15550100999',
  startedAtIso: new Date().toISOString(),
});

const rl = readline.createInterface({ input: stdin, output: stdout });

console.log(`\n[call answered — calendar provider: ${calendar.name}]\n`);
console.log(`${cfg.bot.botName}: ${agent.greeting()}\n`);

for (;;) {
  const line = await rl.question('caller: ');
  if (!line.trim()) continue;
  process.stdout.write(`${cfg.bot.botName}: `);
  for await (const sentence of agent.respond(line.trim())) {
    process.stdout.write(sentence + ' ');
  }
  process.stdout.write('\n\n');

  const outcome = agent.outcome;
  if (outcome.type !== 'in_progress') {
    console.log(`[call ended — outcome: ${outcome.type}, urgency: ${outcome.urgency}]`);
    console.log(`[summary: ${outcome.summary}]`);
    if (outcome.booking?.ok) {
      console.log(`[booked: ${outcome.booking.speakableTime} (event ${outcome.booking.eventId})]`);
    }
    break;
  }
}
rl.close();
