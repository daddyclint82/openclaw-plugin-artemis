/** MCP child ownership: spawn, readiness, calls, and bounded-close escalation.
 *
 * Uses the maintained Node MCP client SDK (StdioClientTransport) — no
 * hand-rolled JSON-RPC. The child is an owned process: we track its pid,
 * pipe its stderr (redacted), and escalate termination only if it survives
 * the SDK's normal close.
 */

import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RingBuffer, redact } from "./redact.js";
import { DeadlineMarker, IncompatibleServer, StartupFailure } from "./errors.js";
import type { LoggerLike, ResolvedConfig } from "./types.js";

/** Tools the plugin itself calls — must exist at readiness. */
export const REQUIRED_TOOLS = ["artemis_research", "artemis_brave_search"] as const;

export interface ArtemisChild {
  client: Client;
  transport: StdioClientTransport;
  pid: number | null;
  generation: number;
  startedAt: number;
  closed: boolean;
  stderrRing: RingBuffer;
  serverVersion: string;
}

/** Explicit, non-secret child environment (config → child). */
export function buildChildEnv(cfg: ResolvedConfig): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: os.homedir(),
    PYTHONUNBUFFERED: "1",
    ARTEMIS_PATH: cfg.artemisPath,
    OLLAMA_BASE_URL: cfg.ollamaBaseUrl,
    CHECKPOINT_DB: cfg.checkpointDb,
  };
}

export async function startChild(
  cfg: ResolvedConfig,
  generation: number,
  log: LoggerLike,
): Promise<ArtemisChild> {
  // Ensure the isolated checkpoint store's directory exists (never OpenCode's).
  await mkdir(path.dirname(cfg.checkpointDb), { recursive: true });

  const transport = new StdioClientTransport({
    command: cfg.pythonPath,
    args: [cfg.serverPath],
    env: buildChildEnv(cfg),
    stderr: "pipe",
  });

  const stderrRing = new RingBuffer(32 * 1024);
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk: Buffer) => stderrRing.push(redact(chunk.toString("utf8"))));
  }

  const client = new Client({ name: "openclaw-artemis-plugin", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: cfg.readinessTimeoutMs });
  } catch (err) {
    await closeQuietly(client, transport);
    throw new StartupFailure(`child failed to initialize within ${cfg.readinessTimeoutMs}ms: ${errText(err)}`);
  }

  let toolNames: string[];
  try {
    const { tools } = await client.listTools(undefined, { timeout: 10_000 });
    toolNames = tools.map((t) => t.name);
  } catch (err) {
    await closeQuietly(client, transport);
    throw new StartupFailure(`tools/list failed during readiness: ${errText(err)}`);
  }

  for (const required of REQUIRED_TOOLS) {
    if (!toolNames.includes(required)) {
      await closeQuietly(client, transport);
      throw new IncompatibleServer(
        `server exposes [${toolNames.join(", ")}] but not "${required}"`,
      );
    }
  }

  const sv = client.getServerVersion();
  const serverVersion = `${sv?.name ?? "unknown"} ${sv?.version ?? ""}`.trim();
  log.info?.(`artemis: child ready (generation ${generation}, pid ${transport.pid}, server "${serverVersion}")`);

  return {
    client,
    transport,
    pid: transport.pid,
    generation,
    startedAt: Date.now(),
    closed: false,
    stderrRing,
    serverVersion,
  };
}

export interface CallOutcome {
  /** MCP protocol-level error flag (the Artemis wrapper never sets it, but
   *  a future server might — both paths normalize the same way). */
  isError: boolean;
  text: string;
}

/** Call a child tool with a hard deadline and optional cancellation.
 *  The deadline is passed to the SDK (which otherwise applies its own 60s
 *  default request timeout) and enforced by a local race as belt-and-braces. */
export async function callTool(
  child: ArtemisChild,
  name: string,
  args: Record<string, unknown>,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<CallOutcome> {
  if (child.closed) {
    throw new StartupFailure("child already closed");
  }
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineMarker(opts.timeoutMs)), opts.timeoutMs);
  });
  try {
    const res = await Promise.race([
      child.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: opts.timeoutMs, signal: opts.signal },
      ),
      deadline,
    ]);
    const isError = res.isError === true;
    const text = extractText(res.content);
    return { isError, text };
  } catch (err) {
    // SDK timeout (McpError -32001) normalizes to our deadline marker — but
    // the SDK also rejects aborted requests with the same error class. A
    // genuinely aborted signal is cancellation, not a deadline: let the raw
    // error through so the manager classifies via signal.aborted.
    const e = err as { code?: number; message?: string };
    if (e?.code === -32001 || /timed?\s*out/i.test(e?.message ?? "")) {
      if (opts.signal?.aborted) throw err;
      throw new DeadlineMarker(opts.timeoutMs);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Close the child: SDK close first (SIGTERM + wait), then bounded SIGKILL
 *  escalation for owned survivors. */
export async function closeChild(child: ArtemisChild, graceMs: number): Promise<void> {
  if (child.closed) return;
  child.closed = true;
  await closeQuietly(child.client, child.transport);
  const pid = child.transport.pid;
  if (pid != null) {
    const exited = await waitForExit(pid, graceMs);
    if (!exited) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await waitForExit(pid, 2_000);
    }
  }
}

async function closeQuietly(client: Client, transport: StdioClientTransport): Promise<void> {
  try {
    await client.close();
  } catch {
    try {
      transport.close();
    } catch {
      /* best effort */
    }
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      parts.push(String((block as { text?: string }).text ?? ""));
    }
  }
  return parts.join("\n");
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}