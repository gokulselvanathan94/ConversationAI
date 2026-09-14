# ConversationAI — CEO Phone Assistant (bot-first, Genesys BYOC hand-off)

A self-hosted conversational AI that answers the CEO's phone line, asks the
caller who they are and why they're calling, offers open slots on the CEO's
calendar and books a meeting — and only when a human is genuinely needed
hands the live call into **Genesys Cloud** through your **BYOC Cloud trunk**
(with the caller's real number and a context screen pop for the agent).

It deliberately does **not** use Genesys' native bot or the Audio Connector:
calls the bot fully handles never enter Genesys, so they accrue **zero
Genesys per-minute fees** (the Audio Connector meter alone is $0.10/min at
2026 list rates). See [docs/architecture.md](docs/architecture.md) for the
verified cost breakdown and design rationale.

```
Caller ──carrier──► jambonz (self-hosted) ──► STT ─► Claude ─► TTS
                        │                      (screen, schedule, book)
                        └── on escalation: SIP dial into Genesys BYOC trunk
                            (real caller ANI + UUI context token)
```

## Components

| Path | What it is |
|---|---|
| `src/agent/` | Claude conversation engine: streaming tool loop, sentence chunking for low-latency TTS, barge-in abort, `end_call` outcome (hang up / transfer) |
| `src/calendar/` | Availability + booking: in-memory provider (dev) or Google Calendar service account (prod); timezone-correct business-hours slotting |
| `src/telephony/` | jambonz WebSocket app (gather/say loop, silence handling, Genesys `dial` hand-off), UUI encoding, transfer-context store, call transcript log |
| `src/index.ts` | HTTP server: jambonz WS endpoint, `GET /health`, `GET /context/:token` (Genesys data action) |
| `scripts/chat.ts` | Terminal harness — talk to the assistant with no telephony |
| `docs/` | [Architecture & costs](docs/architecture.md) · [Full setup guide](docs/genesys-byoc-setup.md) |

## Quick start (no telephony needed)

```bash
npm install
cp .env.example .env       # set ANTHROPIC_API_KEY, CEO_NAME, COMPANY_NAME
npm run chat               # talk to the assistant in your terminal
npm test                   # unit tests
```

Example session: the assistant greets, asks why you're calling, checks the
(in-memory) calendar, books a slot, and ends the call via its `end_call`
tool — or reports `transfer_to_human`, which on a real call triggers the
Genesys bridge.

## Running for real calls

1. Install **jambonz** on a host with a public IP and point your carrier's
   DID at it (guide: [docs/genesys-byoc-setup.md](docs/genesys-byoc-setup.md)).
2. In the jambonz portal: add STT/TTS vendor keys (e.g. Deepgram), create an
   application pointing at `wss://<this-server>/assistant`, attach the DID.
3. Configure a **BYOC Cloud trunk** in Genesys with your jambonz IP
   allowlisted, UUI passthrough (Hex, PD `00`), a DID range + call route to
   an Architect flow that reads `Call.UUIData` and data-dips
   `GET /context/{token}` here.
4. `npm run build && npm start` behind TLS.

Every call writes a JSONL transcript to `call-logs/` (bot-handled legs are
invisible to Genesys, so this is the system of record).

## Configuration

All via environment variables — see [.env.example](.env.example). Highlights:

- `ANTHROPIC_MODEL` (default `claude-opus-5`) and `CLAUDE_EFFORT` (default
  `low` for voice latency; raise for more deliberate reasoning).
- `CEO_NAME`, `COMPANY_NAME`, `BOT_NAME`, business hours, timezone, meeting
  length.
- `CALENDAR_PROVIDER=memory|google` (+ Google service-account credentials).
- `GENESYS_TRANSFER_SIP_URI` — e.g.
  `sip:+15551230000@ceobot.byoc.usw2.pure.cloud`. If unset, the assistant
  takes a message instead of transferring.
- `CONTEXT_API_KEY` — shared secret for the Genesys data action.

## Development

```bash
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit
npm test           # node:test suite (no network needed)
```
