/** Manager lifecycle tests against the fixture MCP child (handoff coverage 1-8). */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ArtemisManager } from "../src/manager.js";
import { resolveConfig, type ResolvedConfig } from "../src/types.js";

const FIXTURE = new URL("./fixture-child.mjs", import.meta.url).pathname;
const MODE_FILE = `${FIXTURE}.mode`;
const LATCH = `${FIXTURE}.latch`;
const LOG = `${FIXTURE}.log`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noopLog = {};

async function setMode(mode: string): Promise<void> {
  await writeFile(MODE_FILE, mode);
}

async function makeConfig(overrides: Record<string, unknown> = {}): Promise<{ cfg: ResolvedConfig; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "artemis-test-"));
  const cfg = resolveConfig(
    {
      pythonPath: process.execPath,
      serverPath: FIXTURE,
      artemisPath: "/tmp/artemis-fixture-path",
      ollamaBaseUrl: "http://sentinel-ok.example",
      checkpointDb: join(dir, "checkpoints.sqlite"),
      readinessTimeoutMs: 10_000,
      researchTimeoutMs: 5_000,
      braveTimeoutMs: 5_000,
      queueMaxDepth: 2,
      queueTimeoutMs: 2_000,
      braveConcurrency: 4,
      pingIntervalMs: 500,
      pingTimeoutMs: 300,
      maxRestarts: 3,
      restartWindowMs: 60_000,
      stableResetMs: 300_000,
      eagerStart: false,
      ...overrides,
    },
    homedir(),
  );
  return { cfg, dir };
}

async function expectPidGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await sleep(50);
  }
}

let manager: ArtemisManager | null = null;
let dir: string | null = null;

beforeEach(async () => {
  await rm(LATCH, { force: true });
  await rm(LOG, { force: true });
});

afterEach(async () => {
  if (manager) {
    await manager.stop();
    manager = null;
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
  await rm(LATCH, { force: true });
  await rm(LOG, { force: true });
});

describe("normal operation (coverage 1)", () => {
  it("readiness, brave, and research return normal results", async () => {
    await setMode("echo");
    const made = await makeConfig();
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const b = await manager.brave("hello world", 3);
    expect(b.ok).toBe(true);
    expect(b.text).toContain("1. Fake Result");
    expect(b.details.resultCount).toBe(3);

    const r = await manager.research("what is x", undefined);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("FAKE_RESEARCH_ANSWER");
    expect(String(r.details.threadId)).toMatch(/^openclaw-[0-9a-f-]{36}$/);

    const st = manager.status();
    expect(st.state).toBe("ready");
    expect(st.generation).toBe(1);
    expect(st.pid).not.toBeNull();
    expect(st.serverVersion).toContain("artemis-fixture");
  });

  it("NO_RESULTS is a valid empty result, not an error", async () => {
    await setMode("no_results");
    const made = await makeConfig();
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const b = await manager.brave("obscure query", 5);
    expect(b.ok).toBe(true);
    expect(b.text).toBe("NO_RESULTS");
    expect(b.details.resultCount).toBe(0);
  });

  it("sentinel env reaches the child through the real launch path (coverage 8)", async () => {
    await setMode("echo");
    const made = await makeConfig();
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r = await manager.research("env probe", undefined);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('"OLLAMA_BASE_URL":"http://sentinel-ok.example"');
    expect(r.text).toContain('"ARTEMIS_PATH":"/tmp/artemis-fixture-path"');
    expect(r.text).toContain(`"CHECKPOINT_DB":"${made.cfg.checkpointDb}"`);
  });
});

describe("error normalization (coverage 2)", () => {
  it("TOOL_ERROR text: brave missing key -> MISSING_CREDENTIAL", async () => {
    await setMode("error_text");
    const made = await makeConfig();
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const b = await manager.brave("anything", 3);
    expect(b.ok).toBe(false);
    expect(b.details.errorCode).toBe("MISSING_CREDENTIAL");
    expect(b.details.retryable).toBe(false);
    expect(b.text).toContain("BRAVE_API_KEY");
  });

  it("TOOL_ERROR text: research budget exhausted -> BUDGET_EXHAUSTED", async () => {
    await setMode("error_text");
    const made = await makeConfig();
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r = await manager.research("anything", undefined);
    expect(r.ok).toBe(false);
    expect(r.details.errorCode).toBe("BUDGET_EXHAUSTED");
    expect(r.details.retryable).toBe(false);
  });

  it("protocol isError flag -> PROVIDER_ERROR classification", async () => {
    await setMode("is_error");
    const made = await makeConfig();
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r = await manager.research("anything", undefined);
    expect(r.ok).toBe(false);
    expect(r.details.errorCode).toBe("PROVIDER_ERROR");
    expect(r.details.retryable).toBe(true);
  });
});

describe("incompatible server (coverage 2)", () => {
  it("missing contracted tool at readiness -> INCOMPATIBLE_SERVER, degraded", async () => {
    await setMode("unknown_tools");
    const made = await makeConfig();
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r = await manager.research("anything", undefined);
    expect(r.ok).toBe(false);
    expect(r.details.errorCode).toBe("INCOMPATIBLE_SERVER");
    expect(r.details.retryable).toBe(false);

    const st = manager.status();
    expect(st.state).toBe("degraded");
    expect(st.circuitOpen).toBe(false);
  });
});

describe("startup failures and circuit (coverage 3)", () => {
  it("slow start -> STARTUP_FAILED, then recovers when fast", async () => {
    await setMode("slow_init 3000");
    const made = await makeConfig({ readinessTimeoutMs: 1_500 });
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r1 = await manager.research("q", undefined);
    expect(r1.ok).toBe(false);
    expect(r1.details.errorCode).toBe("STARTUP_FAILED");
    expect(r1.details.retryable).toBe(true);
    expect(manager.status().state).toBe("degraded");

    await setMode("echo");
    const r2 = await manager.research("q2", undefined);
    expect(r2.ok).toBe(true);
    expect(manager.status().state).toBe("ready");
  });

  it("crash on init -> bounded restarts -> circuit-open -> manual reset (coverage 3)", async () => {
    await setMode("crash_init");
    const made = await makeConfig({ maxRestarts: 2, readinessTimeoutMs: 3_000 });
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r1 = await manager.research("q", undefined);
    expect(r1.details.errorCode).toBe("STARTUP_FAILED");

    const r2 = await manager.research("q", undefined);
    expect(r2.details.errorCode).toBe("STARTUP_FAILED");
    expect(manager.status().circuitOpen).toBe(true);

    const r3 = await manager.research("q", undefined);
    expect(r3.details.errorCode).toBe("CIRCUIT_OPEN");
    expect(r3.details.retryable).toBe(false);

    manager.status("reset-circuit");
    expect(manager.status().circuitOpen).toBe(false);

    // Still crash_init: attempts again and fails, but the circuit was manually re-armed.
    const r4 = await manager.research("q", undefined);
    expect(r4.details.errorCode).toBe("STARTUP_FAILED");
  });

  it("crash mid-call -> TRANSPORT_EXIT, no auto-replay, recovery on next call", async () => {
    await setMode("crash_call");
    const made = await makeConfig();
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r1 = await manager.research("q", undefined);
    expect(r1.ok).toBe(false);
    expect(r1.details.errorCode).toBe("TRANSPORT_EXIT");
    expect(r1.details.retryable).toBe(true);
    // The plugin must NOT silently retry the research call itself.
    expect(manager.status().generation).toBe(1);

    await setMode("echo");
    const r2 = await manager.research("q2", undefined);
    expect(r2.ok).toBe(true);
    expect(manager.status().generation).toBe(2);
  });

  it("clean unload: child exits, no orphans", async () => {
    await setMode("echo");
    const made = await makeConfig();
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r = await manager.research("q", undefined);
    expect(r.ok).toBe(true);
    const pid = manager.status().pid;
    expect(pid).not.toBeNull();

    await manager.stop();
    await expectPidGone(pid as number);
    expect(manager.status().state).toBe("stopped");
    expect(manager.status().pid).toBeNull();
  });
});

describe("queue admission (coverage 4)", () => {
  it("overflow is immediate; queue wait times out explicitly", async () => {
    await setMode("hang");
    const made = await makeConfig({ queueMaxDepth: 1, queueTimeoutMs: 1_000, researchTimeoutMs: 60_000 });
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const p1 = manager.research("first", undefined);
    p1.catch(() => {});
    await sleep(600); // first research in-flight (hangs)

    const p2 = manager.research("second", undefined);
    const p3 = await manager.research("third", undefined); // queue full -> immediate
    expect(p3.ok).toBe(false);
    expect(p3.details.errorCode).toBe("QUEUE_OVERFLOW");
    expect(p3.details.retryable).toBe(true);

    const r2 = await p2; // waits 1s then times out
    expect(r2.ok).toBe(false);
    expect(r2.details.errorCode).toBe("QUEUE_TIMEOUT");
  });
});

describe("cancellation and deadlines (coverage 4)", () => {
  it("cancellation -> OUTCOME_UNKNOWN, child replaced, slot freed", async () => {
    await setMode("hang");
    const made = await makeConfig({ researchTimeoutMs: 60_000 });
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const ac = new AbortController();
    const p1 = manager.research("slow one", undefined, ac.signal);
    await sleep(600); // in-flight
    ac.abort();

    const r1 = await p1;
    expect(r1.ok).toBe(false);
    expect(r1.details.errorCode).toBe("OUTCOME_UNKNOWN");
    expect(r1.details.retryable).toBe(false);
    // Replacement awaited before the slot freed: child already dead.
    expect(manager.status().pid).toBeNull();
    expect(manager.status().state).toBe("stopped");

    // Next research lazily starts a fresh child and succeeds.
    await setMode("echo");
    const r2 = await manager.research("after cancel", undefined);
    expect(r2.ok).toBe(true);
    expect(manager.status().generation).toBe(2);
  });

  it("execution deadline -> DEADLINE_EXCEEDED + deliberate replacement (no circuit count)", async () => {
    await setMode("hang");
    const made = await makeConfig({ researchTimeoutMs: 1_200, pingIntervalMs: 300, pingTimeoutMs: 200 });
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r = await manager.research("too slow", undefined);
    expect(r.ok).toBe(false);
    expect(r.details.errorCode).toBe("DEADLINE_EXCEEDED");
    expect(r.details.retryable).toBe(false);
    expect(String(r.details.threadId)).toMatch(/^openclaw-/);

    const st = manager.status();
    expect(st.pid).toBeNull(); // replaced
    expect(st.restartsInWindow).toBe(0); // deliberate: not counted as crash
  });
});

describe("watchdog (coverage 5)", () => {
  it("healthy long-running work never trips replacement", async () => {
    await setMode("hang");
    const made = await makeConfig({ researchTimeoutMs: 60_000, pingIntervalMs: 250, pingTimeoutMs: 200 });
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const p1 = manager.research("long work", undefined);
    p1.catch(() => {});
    await sleep(1_500); // ~6 ping cycles while in-flight

    const st = manager.status();
    expect(st.inFlight).toBe(1);
    expect(st.restartsInWindow).toBe(0);
    expect(st.generation).toBe(1);
    expect(st.state).toBe("ready");
  });

  it("idle crash -> watchdog failure counted toward restart budget, then recovers", async () => {
    await setMode("echo");
    const made = await makeConfig({ pingIntervalMs: 400, pingTimeoutMs: 300 });
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const r0 = await manager.research("warm", undefined);
    expect(r0.ok).toBe(true);
    const pid = manager.status().pid;
    process.kill(pid as number, "SIGKILL"); // simulated idle crash

    await sleep(1_100); // ping cycle detects
    const st = manager.status();
    expect(st.restartsInWindow).toBeGreaterThanOrEqual(1);
    expect(st.state).not.toBe("ready");

    // Next call lazily recovers.
    const r1 = await manager.research("after crash", undefined);
    expect(r1.ok).toBe(true);
    expect(manager.status().generation).toBe(2);
  });
});

describe("research serialization (coverage 6)", () => {
  it("research runs are strictly serialized; brave overlaps freely", async () => {
    await setMode("serial_latch");
    const made = await makeConfig({ researchTimeoutMs: 60_000 });
    manager = new ArtemisManager(made.cfg, noopLog);
    dir = made.dir;

    const pA = manager.research("A", "openclaw-00000000-0000-0000-0000-000000000001");
    const pB = manager.research("B", "openclaw-00000000-0000-0000-0000-000000000002");
    await sleep(700); // A started and latched; B queued

    const st = manager.status();
    expect(st.researchQueued).toBe(1);
    expect(st.inFlight).toBe(1);

    // Brave does not queue behind latched research.
    const bb = await manager.brave("concurrent", 2);
    expect(bb.ok).toBe(true);

    await writeFile(LATCH, "1"); // release A
    const rA = await pA;
    const rB = await pB;
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);

    const log = await readFile(LOG, "utf8");
    const lines = log.trim().split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toMatch(/^start /);
    expect(lines[1]).toMatch(/^end /);
    expect(lines[2]).toMatch(/^start /);
    expect(lines[3]).toMatch(/^end /);
  });
});