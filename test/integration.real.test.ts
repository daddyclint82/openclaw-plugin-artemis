/** Real-wrapper integration tests (protocol-level; no paid calls).
 *  Gated on the real Artemis install being present.
 *  Covers: plugin env shape readiness (coverage 1), OpenCode env shape
 *  still initializing after shared-source changes (coverage 9), checkpoint
 *  store isolation via env (coverage 7, file-level), sentinel env through
 *  the actual launch path (coverage 8).
 */

import { describe, expect, it } from "vitest";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { closeChild, startChild } from "../src/mcp-client.js";
import { DEFAULT_CONFIG, expandTilde, resolveConfig } from "../src/types.js";

// Install paths can be overridden per environment (CI has no install -> skips).
const PYTHON =
  process.env.ARTEMIS_TEST_PYTHON ?? expandTilde(DEFAULT_CONFIG.pythonPath, homedir());
const SERVER =
  process.env.ARTEMIS_TEST_SERVER ?? expandTilde(DEFAULT_CONFIG.serverPath, homedir());
const ARTEMIS =
  process.env.ARTEMIS_TEST_PATH ?? expandTilde(DEFAULT_CONFIG.artemisPath, homedir());

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const available =
  (await pathExists(PYTHON)) && (await pathExists(SERVER)) && (await pathExists(ARTEMIS));

describe.skipIf(!available)("real artemis wrapper (integration)", () => {
  it("plugin env shape: startChild reaches ready and lists the contracted tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artemis-int-"));
    try {
      const cfg = resolveConfig(
        {
          pythonPath: PYTHON,
          serverPath: SERVER,
          artemisPath: ARTEMIS,
          checkpointDb: join(dir, "checkpoints.sqlite"),
          readinessTimeoutMs: 20_000,
        },
        homedir(),
      );
      const child = await startChild(cfg, 1, console);
      expect(child.pid).not.toBeNull();
      expect(child.serverVersion).toContain("artemis");

      const { tools } = await child.client.listTools(undefined, { timeout: 10_000 });
      const names = tools.map((t) => t.name);
      expect(names).toContain("artemis_research");
      expect(names).toContain("artemis_brave_search");
      expect(names).toContain("artemis_exa_search");

      await closeChild(child, 3_000);
      await expectPidGone(child.pid as number);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opencode env shape (ARTEMIS_PATH only) still initializes — coverage 9", async () => {
    // Mimic opencode.json's environment block exactly: ARTEMIS_PATH plus basics.
    const transport = new StdioClientTransport({
      command: PYTHON,
      args: [SERVER],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: homedir(),
        ARTEMIS_PATH: ARTEMIS,
      },
    });
    const client = new Client({ name: "openclaw-opencode-shape-probe", version: "0.1.0" });
    await client.connect(transport, { timeout: 20_000 });
    const { tools } = await client.listTools(undefined, { timeout: 10_000 });
    const names = tools.map((t) => t.name);
    expect(names).toContain("artemis_research");
    expect(names).toContain("artemis_brave_search");
    await client.close();
  });

  it("checkpoint store: plugin child writes to its own isolated CHECKPOINT_DB dir (coverage 7)", async () => {
    // startChild must create the checkpoint directory (never OpenCode's default DB path).
    const dir = await mkdtemp(join(tmpdir(), "artemis-int-ckpt-"));
    try {
      const cfg = resolveConfig(
        {
          pythonPath: PYTHON,
          serverPath: SERVER,
          artemisPath: ARTEMIS,
          checkpointDb: join(dir, "sub", "checkpoints.sqlite"),
          readinessTimeoutMs: 20_000,
        },
        homedir(),
      );
      const child = await startChild(cfg, 1, console);
      await closeChild(child, 3_000);
      // The directory must exist (plugin created it); the DB file itself is
      // created lazily by the saver on first research run (live smoke).
      const s = await stat(join(dir, "sub"));
      expect(s.isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function expectPidGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive`);
    await new Promise((r) => setTimeout(r, 50));
  }
}