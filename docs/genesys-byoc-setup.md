# Setup Guide: Carrier → jambonz → Genesys Cloud (BYOC)

End-to-end configuration for the bot-first architecture. Three sides to set
up: your carrier, the bot host (jambonz + this app), and Genesys Cloud.
Facts below were verified against official Genesys/jambonz documentation in
September 2026; items marked *(verify)* could not be fully confirmed against
a primary source — test them in your org.

---

## 1. Carrier side

1. Have your carrier route the CEO's DID(s) to your jambonz server's static
   public IP (SIP over UDP/TCP 5060 or TLS 5061). jambonz supports three
   carrier trunk styles: **IP allowlist**, **auth trunk** (carrier digest-
   auths to you), or **registration trunk** (jambonz registers to carrier).
2. In the jambonz portal, create the Carrier and allowlist the carrier's
   signaling IPs.
3. Codec: keep **G.711 (PCMU/PCMA)** end-to-end — it's also Genesys'
   recommendation for carrier traffic on the BYOC trunk.

## 2. Bot host side

### 2a. Install jambonz

Single-host install on Debian 12 (≥4 vCPU / 8 GB RAM / 100 GB disk, public
IPv4). Open: 5060/udp+tcp, 5061/tcp, 8443/tcp, 80+443/tcp, RTP
40000–60000/udp. There is no supported docker-compose path; options are the
`jambonz-mini` apt package (below), cloud images, Kubernetes, or hosted
jambonz.cloud (free trial).

```bash
sudo install -d /etc/apt/keyrings
curl -fsSL https://jambonz-debian-packages.s3.us-east-2.amazonaws.com/jambonz.gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/jambonz.gpg
echo "deb [signed-by=/etc/apt/keyrings/jambonz.gpg] https://jambonz-debian-packages.s3.us-east-2.amazonaws.com/debian bookworm main" \
  | sudo tee /etc/apt/sources.list.d/jambonz.list
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get update
sudo apt-get install -y linux-headers-cloud-$(dpkg --print-architecture) \
  || sudo apt-get install -y linux-headers-$(uname -r)
sudo -E JAMBONES_PORTAL_DOMAIN=portal.example.com DEBIAN_FRONTEND=noninteractive \
  apt-get install -y jambonz-mini
# then: DNS A records (portal., api.portal., grafana.portal.), certbot,
# log in (admin/admin), install the license key.
jambonz health
```

**Licensing:** jambonz v10 ("jambonz Commercial") self-hosting needs a
license key from licensing.jambonz.org — 30-day free trial (10 concurrent
sessions); extended free licenses for non-commercial/pre-revenue use via
support@jambonz.org. This app deliberately uses only the classic verbs
(`gather`/`say`/`dial`/`hangup`), which also exist in the MIT-licensed
0.9.x line, so either line works.

A jambonz-mini host handles roughly 50–75 concurrent calls — far more than
a single executive line needs.

### 2b. Configure jambonz

1. **Speech** → add your STT and TTS vendor credentials (e.g. Deepgram for
   STT, Deepgram/ElevenLabs for TTS) and set them as the application's
   default recognizer/synthesizer. This app is vendor-neutral: jambonz owns
   STT/TTS; Claude (Anthropic API) is called from this app directly.
2. **Applications** → create an application; set the calling webhook to
   this server's WebSocket URL: `wss://<bot-app-host>/assistant`
   (path = `JAMBONZ_WS_PATH`).
3. **Phone numbers** → attach the CEO's DID (from the carrier) to that
   application.
4. **Carriers** → optionally add Genesys as an *outbound* carrier (SIP
   gateway = your Genesys trunk FQDN, port 5061/TLS), so jambonz manages
   TLS/OPTIONS toward Genesys. This app dials a raw `sip:` URI by default,
   which also works.

### 2c. Run this app

```bash
cp .env.example .env    # fill in ANTHROPIC_API_KEY, persona, calendar, GENESYS_TRANSFER_SIP_URI
npm install
npm run build && npm start        # or: npm run dev
```

Put it behind TLS (nginx/caddy/ALB) so jambonz can reach
`wss://bot-app-host/assistant` and Genesys' data action can reach
`https://bot-app-host/context/{token}`. Set `CONTEXT_API_KEY` and configure
the same key in the Genesys data action's headers.

## 3. Genesys Cloud side

### 3a. BYOC Cloud trunk (your bot server is the "carrier")

Prerequisite: the BYOC Cloud capability enabled on your org. Genesys
supports premises-based SBCs as BYOC peers — your jambonz server does not
need to be a telco.

1. **Admin → Telephony → Trunks → External Trunks → Create New**
   (newer UI may group this under "Digital and Telephony").
2. Type: **BYOC Carrier**, subtype **Generic BYOC Carrier**.
3. **SIP Routing → Inbound SIP Termination Identifier**: pick a unique
   label, e.g. `ceobot`. This mints your trunk's FQDN:
   `{identifier}.{regional-byoc-domain}` — e.g.
   `ceobot.byoc.mypurecloud.com` (us-east-1 legacy core) or
   `ceobot.byoc.usw2.pure.cloud`. **The UI shows an "Inbound Request-URI
   Reference" panel with your org's exact regional value — treat that as
   authoritative** and use it as the host part of
   `GENESYS_TRANSFER_SIP_URI`.
4. **SIP Servers or Proxies**: add your jambonz server's public signaling
   IP(s). These populate the SIP Access Control allow list (up to 150
   CIDRs). Calls from unlisted IPs are rejected.
5. Optional hardening: **Inbound Digest Authentication** — and note the
   default challenges only REGISTER; add INVITE to Authorization Methods
   *(verify this setting is exposed for your trunk type)*.
6. Recommended: **TLS on 5061 + SRTP** (TLS 1.2; public-CA certs both
   sides — DigiCert/Amazon Trust/ISRG all accepted). If you enable this,
   use `sips:`/`;transport=tls` in `GENESYS_TRANSFER_SIP_URI`; the app then
   requests SDES SRTP automatically.
7. **Protocol → UUI Passthrough**: enable, with
   - Header Type: `User-to-User`
   - Encoding: **Hex**
   - Protocol Discriminator: `00` (must equal `UUI_PROTOCOL_DISCRIMINATOR`)
   A mismatch fails silently: the header shows in SIP traces but
   `Call.UUIData` comes back empty.
8. **Media**: preferred codec list with G.711 first.
9. If inbound calls 404: the DNIS isn't matching — check the DID range
   below and the trunk's **Number Plan Site** setting (Inbound section).

### 3b. Route the escalation DID to a flow

1. Pick an E.164 number to represent "escalations from the bot" (it can be
   a number you own outside Genesys; nothing is ported).
2. **Admin → Telephony → DID Numbers → DID Ranges** → add it.
3. Build + **publish** an Architect inbound call flow (below).
4. **Admin → Routing → Call Routing** → new route → select the flow → add
   the DID under Inbound Numbers.
5. Put that full E.164 as the user part of `GENESYS_TRANSFER_SIP_URI`:
   `sip:+15551230000@ceobot.byoc.usw2.pure.cloud`.

### 3c. Architect inbound flow

The app sends: `User-to-User` = hex(token) with PD `00`, plus
`X-Assistant-Context-Token` (same token, plaintext) and
`X-Assistant-Urgency` headers. Flow outline:

1. **Read the token**: `Call.UUIData` (built-in String variable — PD
   stripped, hex decoded per the trunk setting). Fallback: the **Get SIP
   Headers** action (BYOC only, initial INVITE) to read
   `X-Assistant-Context-Token` into a JSON variable.
2. **Data action** (Web Services Data Actions integration):
   `GET https://<bot-app-host>/context/{token}` with header
   `x-api-key: <CONTEXT_API_KEY>`. Response JSON:

   ```json
   {
     "callSid": "...",
     "callerNumber": "+15550100999",
     "summary": "Sarah Chen of Acme wants to discuss a partnership; urgent pricing question",
     "urgency": "urgent",
     "bookedTime": "Tuesday, September 15 at 2:30 PM",
     "transcript": [{ "role": "user", "text": "..." }, ...],
     "createdAtIso": "2026-09-14T16:20:00.000Z"
   }
   ```

3. **Set Participant Data** with `summary`, `urgency`, `callerNumber` (names
   are case-sensitive; these auto-fill same-named script variables).
4. **Set Screen Pop** (must come *before* Transfer to ACD) with a published
   script showing the summary. Scripts can also read `{{UUI.UUIData}}` if
   UUI is enabled in Script Properties. Avoid raw PII in screen-pop
   variables (they are not GDPR-deletable).
5. Branch on `urgency` if you want priority routing, then **Transfer to
   ACD** queue.
6. The caller's real number shows as ANI because the app sets the outbound
   `callerId` to the original caller (and forwards P-Asserted-Identity).
   Genesys' precedence among PAI/From is not formally documented — both are
   set to sidestep it *(verify with a test call)*.

Useful accessors, verified:

| What | How |
|---|---|
| UUI payload | `Call.UUIData` (not available in secure flows — use `Flow.InvocationData` there) |
| Caller ANI | `Call.Ani` — returns `tel:+1555…`; wrap with `ToPhoneNumber(Call.Ani)` |
| Custom X- headers | **Get SIP Headers** action (up to 10 named, or all, initial INVITE only); **Get Raw SIP Headers** for the whole block (max 3 calls/flow) |
| Forward UUI onward | **Set UUI Data** action on a subsequent transfer |
| Persist for the agent | **Set Participant Data**, or `PATCH /api/v2/conversations/{id}/participants/{pid}/attributes` |

## 4. Test plan

1. `npm run chat` — conversation logic alone (no telephony).
2. Call the DID → bot answers (contained call): book a meeting; check the
   calendar event and `call-logs/*.jsonl`.
3. Say "I need to speak to a person" → verify: Genesys agent rings, sees
   the real caller ANI, screen pop shows the summary.
4. Check `Call.UUIData` in flow logs; if empty, compare trunk UUI encoding
   (Hex) and PD (`00`) with the app's settings — this is the most common
   silent failure.
5. Kill the bot app mid-bot-call and confirm your carrier's failover (e.g.
   a fallback forward to the Genesys DID directly).

## 5. Cost sanity check

See `docs/architecture.md` for the verified fee table. Summary: bot-inside-
Genesys (Audio Connector) ≈ $0.111/min marginal at 2026 list rates; bot-
first ≈ $0 for contained calls, pennies for escalations. Confirm your
contract's actual rates — committed-volume Rate E pricing as low as
$0.07/min exists, and allotments vary by license tier.
