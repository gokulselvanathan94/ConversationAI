# Architecture: Bot-First with Genesys BYOC Hand-off

## Why not Genesys Audio Connector?

Genesys' supported way to attach your own voice bot to a Genesys-anchored
call is the **Audio Connector** (AudioHook protocol). It works, but every
bot minute is metered by Genesys — and on **January 1, 2026 the BYOT Rate E
meter for third-party audio connectors was raised ~10x to $0.10/min (US
list)**. While a bot conversation runs inside Genesys you pay, per minute
(list prices, allotments exhausted):

| Meter (bot INSIDE Genesys via Audio Connector) | $/min |
|---|---|
| BYOT Rate E — audio streaming to your bot | **$0.100** |
| Platform IVR usage (bot/flow time counts as IVR time) | $0.010 |
| BYOC Cloud usage (bot answer counts as answered call) | $0.0012 |
| **Marginal total per bot-minute** | **≈ $0.111** |

With the bot **outside** Genesys, contained calls (caller never needs a
human) cost **$0 in Genesys fees** — Genesys never sees them. Only
escalated calls touch Genesys, at ordinary BYOC rates (≈$0.0012/min beyond
the pooled allotment plus $0.01/min IVR overage for Architect flow
execution time; queue wait time does **not** count as IVR usage).

Notes on those numbers: verified against official Genesys pricing articles
as of September 2026; Rate E is published as a range starting at $0.07/min
for committed volume, so budget at the $0.10 list rate. The "three meters
stack" total is an inference from three independently confirmed billing
rules, not one official statement. Always confirm against your contract —
regional uplifts and negotiated rates differ. In both designs you also pay
your own carrier, STT/TTS/LLM, and hosting.

## The design

"BYOC" by itself is only trunking — it is not a bot audio interface. Once a
call is anchored in Genesys, the only supported real-time audio API is
AudioHook/Audio Connector. So the way to avoid those fees is to keep the
call **outside Genesys while the bot talks**, and use your BYOC Cloud trunk
in the *inbound* direction — your bot server acts as the "carrier" — only
when a human is needed.

```
                     CONTAINED CALL (never touches Genesys, $0)

  Caller (PSTN)
      │
      ▼
┌──────────────┐  SIP INVITE (DID)  ┌────────────────────────────────┐
│   Company    │ ─────────────────► │  jambonz (self-hosted SBC +    │
│   carrier    │                    │  media server + feature server)│
│  (SIP trunk) │                    │                                │
└──────────────┘                    │  gather/say loop:              │
                                    │   STT ─► Claude (this repo) ─► │
                                    │   TTS, barge-in, tools:        │
                                    │   check_availability,          │
                                    │   book_meeting, end_call       │
                                    └───────────────┬────────────────┘
                                                    │ escalation only:
                                                    │ fresh INVITE (B2BUA dial)
                                                    │ From = original caller ANI
                                                    │ User-to-User + X- headers
                                                    ▼
                        ┌──────────────────────────────────────────────┐
                        │  Genesys Cloud — BYOC Cloud trunk            │
                        │  sip:+DID@{identifier}.{regional-byoc-domain}│
                        │                                              │
                        │  DID → Call Route → Architect inbound flow   │
                        │  → Call.UUIData (token) → Data Action        │
                        │    GET https://bot-host/context/{token}      │
                        │  → Set Participant Data → Set Screen Pop     │
                        │  → Transfer to ACD queue → human agent       │
                        └──────────────────────────────────────────────┘
```

### Call flow

1. The carrier points the CEO's DID at the jambonz server (IP allowlist,
   digest auth, or registration trunk — jambonz supports all three).
2. jambonz answers and runs the conversation loop: `gather` (streaming STT)
   → this app's Claude agent (screening + calendar tools) → `say` (TTS),
   with barge-in. Genesys sees nothing.
3. Most calls end here: meeting booked or message taken; the transcript is
   written to `call-logs/` and the calendar invite is on the CEO's calendar.
4. If the agent decides a human is needed (`end_call` with
   `transfer_to_human`), this app bridges the call into Genesys with a
   fresh INVITE (`dial` verb) toward the BYOC trunk FQDN:
   - `callerId` = the original caller's number, so agents see the real ANI;
   - `User-to-User` header = hex-encoded correlation token (+ PD prefix);
   - `X-Assistant-Context-Token` / `X-Assistant-Urgency` as backup headers.
5. The Architect flow reads `Call.UUIData`, data-dips
   `GET /context/{token}` on this server for the summary + transcript,
   writes participant data, sets a screen pop, and queues to an agent.
6. jambonz stays in the signaling path for the rest of the call (B2BUA).
   Media can be released with the dial verb's `exitMediaPath` option if the
   extra hop matters.

### Transfer mechanics: why bridge, not REFER

- **B2BUA bridge (`dial`) — what this app does.** Carrier-agnostic, full
  control of ANI and headers, and the only path with guaranteed UUI
  delivery on the INVITE Genesys receives. Cost: your server carries the
  escalated call for its duration (~87 kbps per G.711 stream each way) and
  is a mid-call single point of failure.
- **Carrier-side `sip:refer` — an optimization, only if your carrier
  supports it.** Your server REFERs the caller back toward the carrier and
  drops out. Twilio Elastic SIP Trunking explicitly supports consuming
  REFER (including SIP destinations, with `TransferCallerId=from-transferee`
  to keep the caller's ANI); many other retail trunks reject or mishandle
  REFER, and header/UUI propagation onto the carrier's new INVITE is
  carrier-dependent. If you use this, allowlist the *carrier's* signaling
  IPs on the Genesys trunk too.
- Genesys "Take Back and Transfer" (inbound REFER to Genesys) only applies
  to calls Genesys previously transferred out — not relevant to bot-first.

### What you give up vs. Audio Connector (and how this repo compensates)

| Loss | Mitigation here |
|---|---|
| No Genesys recording/transcription/analytics of the bot leg | Per-call JSONL transcripts in `call-logs/`; full transcript also served to Genesys via `/context/:token` on escalation |
| No unified interaction timeline (Genesys history starts at transfer) | Correlation token in UUI + participant data carries the bot context to the agent |
| Genesys-managed HA for the bot leg | Yours to own: jambonz-mini is single-host (fine for one CEO's line, ~50–75 concurrent calls); an HA SBC pair is the upgrade path |
| Warm-transfer whisper tooling spanning the bot leg | Blind bridge with screen pop + summary; jambonz warm-transfer choreography exists if needed |

### Known sharp edges (verified)

- **UUI encoding mismatch fails silently**: header visible in the SIP trace
  but `Call.UUIData` empty. Trunk encoding (Hex) and PD (`00`) must match
  what this app sends exactly.
- Duplicate `User-to-User` headers ⇒ Genesys discards all UUI.
- Unmatched or badly normalized DNIS ⇒ SIP 404 from Genesys. Fix with the
  DID range + the trunk's Number Plan Site setting.
- Genesys inbound digest auth challenges only REGISTER by default — add
  INVITE to Authorization Methods if you rely on digest instead of the IP
  allowlist.
- TLS toward Genesys BYOC is TLS 1.2 (no 1.3 as of Sept 2026), public-CA
  certs on both sides.
- `Call.UUIData` is not available in secure call flows (use
  `Flow.InvocationData` there).
