/** Credential-shape redaction and a bounded stderr ring buffer.
 *
 * Redaction applies ONLY to logs and the child stderr tail surfaced by
 * artemis_status — never to tool result content delivered to the model.
 */

const KEY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsk_live_[A-Za-z0-9]{8,}/g, label: "[STRIPE_LIVE_KEY]" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, label: "[ANTHROPIC_KEY]" },
  { re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{8,}\b/g, label: "[GITHUB_TOKEN]" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{8,}/g, label: "[GITHUB_TOKEN]" },
  { re: /\bBearer\s+[A-Za-z0-9._+=-]{8,}/g, label: "[BEARER]" },
  { re: /\bX-Subscription-Token[:=]\s*\S+/gi, label: "[SUBSCRIPTION_TOKEN]" },
  { re: /\b(?:api[_-]?key|token|password|secret)[:=]\s*\S{8,}/gi, label: "[SECRET]" },
  // Long opaque blobs (base64/hex runs) — catches leaked key material that
  // does not match a known prefix.
  { re: /\b[A-Za-z0-9+/=_-]{40,}\b/g, label: "[TOKEN]" },
];

export function redact(text: string): string {
  let out = text;
  for (const { re, label } of KEY_PATTERNS) {
    out = out.replace(re, label);
  }
  return out;
}

/** Bounded byte-oriented ring buffer keeping the most recent tail. */
export class RingBuffer {
  private buf = "";
  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.maxBytes) {
      // Drop from the front; try to start at a line boundary for readability.
      let cut = this.buf.length - this.maxBytes;
      const nl = this.buf.indexOf("\n", cut);
      if (nl > 0 && nl < cut + 512) cut = nl + 1;
      this.buf = this.buf.slice(cut);
    }
  }

  /** Most recent `maxChars` characters (already redacted upstream). */
  tail(maxChars: number): string {
    return this.buf.slice(Math.max(0, this.buf.length - maxChars));
  }

  clear(): void {
    this.buf = "";
  }

  get length(): number {
    return this.buf.length;
  }
}