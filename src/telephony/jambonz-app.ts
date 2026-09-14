import type { Session, WsClient } from '@jambonz/sdk/websocket';
import type { AppConfig } from '../config.js';
import type { CalendarProvider } from '../calendar/index.js';
import { createEngine, type ConversationEngine } from '../agent/index.js';
import { createLogger, type Logger } from '../logger.js';
import { ContextStore } from './context-store.js';
import { encodeUuiHex } from './uui.js';
import { appendCallRecord } from './call-log.js';

/** Seconds of caller silence before we re-prompt. */
const NO_INPUT_TIMEOUT_S = 10;
/** Re-prompts before giving up on a silent line. */
const MAX_SILENCE_PROMPTS = 2;

interface GatherResultEvent {
  reason?: string;
  digits?: string;
  speech?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
}

interface DialResultEvent {
  dial_call_status?: string;
  dial_sip_status?: number;
}

/**
 * Wire the jambonz WebSocket application to the Claude call agent.
 *
 * Per call: greet via TTS, gather caller speech (jambonz runs the STT/TTS
 * vendors configured in its portal), feed transcripts to the agent, speak
 * its reply, and loop — until the agent's end_call tool reports an outcome:
 * hang up, or bridge the call into Genesys Cloud through the BYOC trunk
 * with a UUI correlation token + context headers.
 */
export function attachAssistant(
  svc: WsClient,
  cfg: AppConfig,
  calendar: CalendarProvider,
  contextStore: ContextStore,
): void {
  const log = createLogger('jambonz');
  svc.on('session:new', (session: Session) => {
    try {
      new AssistantCall(session, cfg, calendar, contextStore).start();
    } catch (err) {
      log.error('failed to start call session', err);
      session.say({ text: 'I am sorry, something went wrong. Please call again later.' });
      session.hangup().send();
    }
  });
}

class AssistantCall {
  private readonly agent: ConversationEngine;
  private readonly log: Logger;
  private readonly callerNumber?: string;
  private readonly startedAtIso = new Date().toISOString();

  private turnSeq = 0;
  private currentTurn: Promise<void> | null = null;
  private silenceCount = 0;
  private transferStarted = false;
  private recordWritten = false;

  constructor(
    private readonly session: Session,
    private readonly cfg: AppConfig,
    calendar: CalendarProvider,
    private readonly contextStore: ContextStore,
  ) {
    this.callerNumber = session.data.sip?.callingNumber || session.from || undefined;
    this.log = createLogger('call').child(session.callSid);
    this.agent = createEngine(cfg, calendar, {
      callerNumber: this.callerNumber,
      startedAtIso: this.startedAtIso,
    });
  }

  start(): void {
    const { session } = this;
    this.log.info('incoming call', { from: session.from, to: session.to });

    session
      .on('/turn', (evt: GatherResultEvent) => {
        void this.onTurn(evt);
      })
      .on('/transfer-result', (evt: DialResultEvent) => {
        this.onTransferResult(evt);
      })
      .on('close', () => {
        void this.onClose();
      })
      .on('error', (err: unknown) => this.log.error('session error', err));

    // Answer with the greeting, then listen. bargein lets the caller talk
    // over any prompt; jambonz kills the TTS audio and returns their speech.
    this.gatherWithPrompt(this.agent.greeting()).send();
  }

  /** Build a gather (optionally preceded by a spoken prompt) — one turn. */
  private gatherWithPrompt(text?: string): Session {
    return this.session.gather({
      input: ['speech'],
      actionHook: '/turn',
      timeout: NO_INPUT_TIMEOUT_S,
      bargein: true,
      ...(text ? { say: { text } } : {}),
    });
  }

  private async onTurn(evt: GatherResultEvent): Promise<void> {
    if (this.transferStarted) return;
    const seq = ++this.turnSeq;

    const transcript = evt.speech?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) {
      this.onSilence(evt);
      return;
    }
    this.silenceCount = 0;
    this.log.info('caller said', { transcript });

    // Cancel any in-flight generation (caller barged in over the reply),
    // then wait for that turn to unwind so history stays ordered.
    this.agent.abort();
    if (this.currentTurn) await this.currentTurn.catch(() => undefined);
    if (seq !== this.turnSeq) return; // an even newer turn arrived

    this.currentTurn = this.runTurn(seq, transcript);
    await this.currentTurn;
  }

  private async runTurn(seq: number, transcript: string): Promise<void> {
    const sentences: string[] = [];
    try {
      for await (const sentence of this.agent.respond(transcript)) {
        if (seq !== this.turnSeq) return; // superseded by a newer turn
        sentences.push(sentence);
      }
    } catch (err) {
      this.log.error('agent turn failed', err);
    }
    if (seq !== this.turnSeq || this.transferStarted) return;

    const reply = sentences.join(' ');
    const outcome = this.agent.outcome;
    this.log.info('assistant reply', { reply, outcome: outcome.type });

    if (outcome.type === 'in_progress') {
      this.gatherWithPrompt(reply || 'Sorry, could you repeat that?').reply();
      return;
    }

    if (outcome.type === 'transfer_to_human') {
      this.startTransfer(reply, outcome.summary, outcome.urgency, outcome.booking?.speakableTime);
      return;
    }

    // completed — say the goodbye the model produced and hang up.
    this.session.say({ text: reply || 'Thank you for calling. Goodbye.' }).hangup().reply();
  }

  private onSilence(evt: GatherResultEvent): void {
    this.silenceCount++;
    this.log.info('no caller input', { reason: evt.reason, count: this.silenceCount });
    if (this.silenceCount <= MAX_SILENCE_PROMPTS) {
      this.gatherWithPrompt(
        this.silenceCount === 1
          ? 'Sorry, I did not catch that. Are you still there?'
          : 'Are you still there? I can help you book a meeting or take a message.',
      ).reply();
    } else {
      this.session
        .say({ text: 'It seems we may have lost you. Please call back any time. Goodbye.' })
        .hangup()
        .reply();
    }
  }

  /**
   * Bridge the caller into Genesys Cloud over the BYOC trunk. Context
   * travels as a UUI correlation token (plus X- headers); Genesys data-dips
   * GET /context/:token on this server for the full summary/transcript.
   */
  private startTransfer(
    reply: string,
    summary: string,
    urgency: 'normal' | 'urgent',
    bookedTime?: string,
  ): void {
    const target = this.cfg.genesys.transferSipUri;
    if (!target) {
      this.log.warn('transfer requested but GENESYS_TRANSFER_SIP_URI is not set');
      this.session
        .say({
          text:
            (reply ? reply + ' ' : '') +
            'I am sorry, I cannot connect you to a person right now, but I have noted your message and someone will call you back soon. Goodbye.',
        })
        .hangup()
        .reply();
      return;
    }

    this.transferStarted = true;
    const token = this.contextStore.put({
      callSid: this.session.callSid,
      callerNumber: this.callerNumber,
      summary,
      urgency,
      bookedTime,
      transcript: this.agent.transcript(),
      createdAtIso: new Date().toISOString(),
    });
    const uui = encodeUuiHex(token, this.cfg.genesys.uuiProtocolDiscriminator);
    this.log.info('transferring to Genesys', { target, token, urgency });

    const useTls = target.startsWith('sips:') || /transport=tls/i.test(target);
    this.session
      .say({ text: reply || 'One moment while I connect you.' })
      .dial({
        answerOnBridge: true,
        // Present the original caller's number so agents see the real ANI.
        callerId: this.callerNumber,
        forwardPAI: true,
        timeLimit: 3600,
        actionHook: '/transfer-result',
        headers: {
          'User-to-User': uui,
          'X-Assistant-Context-Token': token,
          'X-Assistant-Urgency': urgency,
        },
        target: [{ type: 'sip', sipUri: target }],
        ...(useTls ? { srtpEncryption: 'sdes' as const } : {}),
      })
      .reply();
  }

  private onTransferResult(evt: DialResultEvent): void {
    this.log.info('transfer leg finished', evt);
    if (evt.dial_call_status && evt.dial_call_status !== 'completed') {
      // Genesys leg failed (busy / no answer / failed): recover gracefully.
      this.transferStarted = false;
      this.session
        .say({
          text: 'I was not able to reach anyone right now. I have noted your details and someone will call you back as soon as possible. Goodbye.',
        })
        .hangup()
        .reply();
      return;
    }
    this.session.hangup().reply();
  }

  private async onClose(): Promise<void> {
    if (this.recordWritten) return;
    this.recordWritten = true;
    this.agent.abort();

    const outcome = this.agent.outcome;
    const record = {
      callSid: this.session.callSid,
      from: this.session.from,
      to: this.session.to,
      startedAtIso: this.startedAtIso,
      endedAtIso: new Date().toISOString(),
      outcome: this.transferStarted
        ? 'transferred_to_genesys'
        : outcome.type === 'in_progress'
          ? 'caller_hung_up'
          : outcome.type,
      summary: outcome.type !== 'in_progress' ? outcome.summary : undefined,
      bookedTime: outcome.type !== 'in_progress' ? outcome.booking?.speakableTime : undefined,
      transcript: this.agent.transcript(),
    };
    this.log.info('call ended', { outcome: record.outcome });
    await appendCallRecord(this.cfg.server.callLogDir, record);
  }
}
