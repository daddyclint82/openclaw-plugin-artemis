/** LIVE smoke — spends real provider credits. Never run in normal CI.
 *  Enable with: ARTEMIS_LIVE_SMOKE=1 npm run test:live
 *  Covers: one real Brave lookup, one bounded real research run, same-thread
 *  resume semantics (coverage 10 + 7), and checkpoint file isolation.
 */

import { describe, expect, it } from "vitest";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { expandTilde, DEFAULT_CONFIG, resolveConfig } from "../src/types.js";
import { ArtemisManager } from "../src/manager.js";

const live = process.env.ARTEMIS_LIVE_SMOKE === "1";

describe.skipIf(!live)("live smoke (spends real credits)", () => {
  it("one actual brave lookup returns usable results", async () => {
    const manager = new ArtemisManager(resolveConfig({}, homedir()), console);
    try {
      const r = await manager.brave("OpenClaw agent framework", 5);
      console.log("LIVE brave:", JSON.stringify({ ok: r.ok, elapsedMs: r.details.elapsedMs, resultCount: r.details.resultCount, errorCode: r.details.errorCode }));
      if (r.ok) {
        expect(r.text).toMatch(/^1\. /m);
        expect(r.text).toContain("http");
        expect(r.details.resultCount).toBeGreaterThan(0);
      } else {
        // Categorized failure is an acceptable, honest outcome (e.g., key absent).
        console.log("LIVE brave failed honestly:", r.text);
        expect(typeof r.details.errorCode).toBe("string");
      }
    } finally {
      await manager.stop();
    }
  });

  it(
    "one bounded research run + same-thread resume + isolated checkpoint file",
    { timeout: 420_000 },
    async () => {
      const manager = new ArtemisManager(
        resolveConfig({ researchTimeoutMs: 300_000 }, homedir()),
        console,
      );
      try {
        const question = "What is the Model Context Protocol (MCP) and which organizations maintain it? Cite sources.";
        const r1 = await manager.research(question, undefined);
        console.log("LIVE research r1:", JSON.stringify({ ok: r1.ok, elapsedMs: r1.details.elapsedMs, errorCode: r1.details.errorCode }));
        if (!r1.ok) {
          // Handoff acceptance: usable citations OR an explicit categorized
          // provider failure (honest outcome, never a fake pass).
          console.log("LIVE research r1 categorized failure:", r1.text);
          expect(typeof r1.details.errorCode).toBe("string");
          expect(r1.text.length).toBeGreaterThan(0);
          return;
        }
        console.log("LIVE research r1 answer (first 500 chars):", r1.text.slice(0, 500));
        expect(r1.text.length).toBeGreaterThan(500);
        // Citations: the answer should reference http(s) URLs from tool results.
        expect(r1.text).toMatch(/https?:\/\//);

        const threadId = String(r1.details.threadId);
        expect(threadId).toMatch(/^openclaw-/);

        // Same-thread rerun: LangGraph resumes/replays from the checkpoint —
        // must NOT re-run the whole graph (fast + no new spend).
        const t0 = Date.now();
        const r2 = await manager.research(question, threadId);
        const wall = Date.now() - t0;
        console.log("LIVE research r2 (same thread):", JSON.stringify({ ok: r2.ok, elapsedMs: r2.details.elapsedMs, wallMs: wall }));
        expect(r2.ok).toBe(true);
        expect(r2.details.elapsedMs).toBeLessThan(120_000);

        // Checkpoint isolation: OUR store got the run; it is not OpenCode's DB.
        const ourDb = expandTilde(DEFAULT_CONFIG.checkpointDb, homedir());
        const s = await stat(ourDb);
        expect(s.size).toBeGreaterThan(0);
        console.log("LIVE checkpoint store:", ourDb, `${s.size} bytes`);
      } finally {
        await manager.stop();
      }
    },
  );
});