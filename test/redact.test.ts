/** Redaction canaries (handoff coverage 8: secret never reaches logs/status). */

import { describe, expect, it } from "vitest";
import { redact, RingBuffer } from "../src/redact.js";

describe("redact", () => {
  it("redacts Stripe live keys", () => {
    const out = redact("config had sk_live_ABCDEFGHijklmnop123456 in it");
    expect(out).not.toContain("sk_live_ABCDEFGH");
    expect(out).toContain("[STRIPE_LIVE_KEY]");
  });

  it("redacts GitHub tokens", () => {
    const out = redact("ghp_abcdefghijklmnopqrstuvwxyz1234567890 leaked");
    expect(out).toContain("[GITHUB_TOKEN]");
    expect(out).not.toContain("ghp_");
  });

  it("redacts Bearer headers", () => {
    const out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(out).toContain("[BEARER]");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts subscription-token headers", () => {
    const out = redact("X-Subscription-Token: supersecretvalue12345");
    expect(out).toContain("[SUBSCRIPTION_TOKEN]");
  });

  it("redacts key=value pairs", () => {
    const out = redact("api_key=supersecretvalue12345678");
    expect(out).toContain("[SECRET]");
  });

  it("redacts long opaque blobs", () => {
    const out = redact(`blob ${"A".repeat(64)} end`);
    expect(out).toContain("[TOKEN]");
    expect(out).not.toContain("A".repeat(64));
  });

  it("leaves ordinary text untouched", () => {
    const text = "artemis-mcp: starting artemis-mcp (sys.path[0]=/home/x/artemis2)";
    expect(redact(text)).toBe(text);
  });

  it("leaves research-style text with URLs untouched", () => {
    const text = "1. OpenClaw docs\n   URL: https://docs.openclaw.ai/concepts/compaction\n   Snippet: ok";
    expect(redact(text)).toBe(text);
  });
});

describe("RingBuffer", () => {
  it("keeps only the bounded tail", () => {
    const rb = new RingBuffer(100);
    rb.push("a".repeat(80));
    rb.push("b".repeat(80));
    rb.push("b".repeat(80)); // now the a's have fully fallen out
    const tail = rb.tail(200);
    expect(tail).toContain("bbb");
    expect(tail).not.toContain("aaa");
    expect(rb.length).toBeLessThanOrEqual(100 + 512);
  });

  it("tail respects maxChars", () => {
    const rb = new RingBuffer(1_000);
    rb.push("x".repeat(500));
    expect(rb.tail(10)).toBe("xxxxxxxxxx");
  });

  it("clear empties", () => {
    const rb = new RingBuffer(1_000);
    rb.push("data");
    rb.clear();
    expect(rb.tail(100)).toBe("");
  });
});