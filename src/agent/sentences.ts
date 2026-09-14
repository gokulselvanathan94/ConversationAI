/**
 * Assembles streamed text deltas into sentence-sized chunks so TTS can start
 * speaking before the model finishes its full reply.
 */

const MIN_CHUNK_CHARS = 12;

// Common abbreviations we must not split after.
const ABBREVIATIONS = /(?:\b(?:mr|mrs|ms|dr|prof|st|vs|etc|inc|ltd|co|jr|sr)\.|\b[a-z]\.)$/i;

export class SentenceAssembler {
  private buffer = '';

  /** Feed a delta; returns zero or more complete sentences ready to speak. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];

    for (;;) {
      const idx = this.findBoundary();
      if (idx === -1) break;
      const sentence = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /** Whatever remains at end of stream. */
  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest;
  }

  private findBoundary(): number {
    // A boundary is . ! ? followed by whitespace, or a newline — provided the
    // preceding text isn't an abbreviation/decimal and the chunk isn't tiny.
    for (let i = 0; i < this.buffer.length - 1; i++) {
      const ch = this.buffer[i];
      const next = this.buffer[i + 1];
      if (ch === '\n') {
        if (i >= 1) return i + 1;
        continue;
      }
      if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(next)) {
        if (i + 1 < MIN_CHUNK_CHARS) continue;
        const before = this.buffer.slice(0, i + 1);
        if (ch === '.' && ABBREVIATIONS.test(before)) continue;
        // Decimal like "2.30" has a digit right after the dot, so the
        // whitespace test above already excludes it.
        return i + 1;
      }
    }
    return -1;
  }
}
