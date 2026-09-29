/** ArtemisManager: one supervised, long-lived MCP child per gateway.
 *
 * Owns lifecycle states, bounded admission (research serialized), a
 * ping watchdog that never replaces during in-flight work, bounded
 * auto-recovery with a circuit breaker, and normalized results.
 *
 * Deliberate replacements (deadline/cancel/config change) do NOT count
 * toward the crash-restart budget; only startup failures and watchdog
 * failures do. Research is never auto-replayed after ambiguous failure —
 * the caller must retry (optionally resuming with the same thread_id).
 */

import { randomUUID } from "node:crypto";
import { callTool, closeChild, startChild, type ArtemisChild, type CallOutcome } from "./mcp-client.js";
import { BoundedSemaphore, CancelledError, QueueOverflowError, QueueTimeoutError } from "./queue.js";
import {
  ArtemisFailure,
  DeadlineMarker,
  IncompatibleServer,
  StartupFailure,
  classifyToolText,
  formatFailure,
  isNoResults,
  type ErrorCode,
} from "./errors.js";
import type { LoggerLike, ResolvedConfig } from "./types.js";

export type ManagerState =
  | "stopped"
  | "starting"
  | "ready"
  | "degraded"
  | "circuit-open"
  | "stopping";

export interface ToolOutcome {
  ok: boolean;
  text: string;
  details: Record<string, unknown>;
}

export interface StatusReport {
  state: ManagerState;
  generation: number;
  pid: number | null;
  uptimeMs: number | null;
  lastHandshakeAt: number | null;
  serverVersion: string | null;
  inFlight: number;
  researchQueued: number;
  braveActive: number;
  restartsInWindow: number;
  circuitOpen: boolean;
  lastError: { code: string; at: number; requestId?: string } | null;
  childStderrTail: string;
  limits: {
    researchTimeoutMs: number;
    braveTimeoutMs: number;
    queueMaxDepth: number;
    queueTimeoutMs: number;
    braveConcurrency: number;
    maxRestarts: number;
    restartWindowMs: number;
    readinessTimeoutMs: number;
  };
}

/** How many brave requests may wait beyond the active concurrency. */
const BRAVE_MAX_WAITING = 8;

export class ArtemisManager {
  private cfg: ResolvedConfig;
  private readonly log: LoggerLike;
  private child: ArtemisChild | null = null;
  private state: ManagerState = "stopped";
  private startPromise: Promise<void> | null = null;
  private generation = 0;
  private inFlight = 0;
  private researchSem: BoundedSemaphore;
  private braveSem: BoundedSemaphore;
  private restartEvents: number[] = [];
  private circuitOpen = false;
  private nextStartNotBefore = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastHandshakeAt: number | null = null;
  private lastError: { code: string; at: number; requestId?: string } | null = null;
  private readySince: number | null = null;
  private stopping = false;
  private pendingReplace = false;

  constructor(cfg: ResolvedConfig, log: LoggerLike) {
    this.cfg = cfg;
    this.log = log;
    this.researchSem = new BoundedSemaphore(cfg.queueMaxDepth, 1);
    this.braveSem = new BoundedSemaphore(BRAVE_MAX_WAITING, cfg.braveConcurrency);
  }

  /** Apply a refreshed config. Timeouts/limits take effect immediately;
   *  path changes apply at the next child start (idle replace when safe). */
  updateConfig(cfg: ResolvedConfig): void {
    const semChanged =
      cfg.queueMaxDepth !== this.cfg.queueMaxDepth ||
      cfg.braveConcurrency !== this.cfg.braveConcurrency;
    const pathsChanged =
      cfg.pythonPath !== this.cfg.pythonPath ||
      cfg.serverPath !== this.cfg.serverPath ||
      cfg.artemisPath !== this.cfg.artemisPath ||
      cfg.checkpointDb !== this.cfg.checkpointDb ||
      cfg.ollamaBaseUrl !== this.cfg.ollamaBaseUrl;
    const pingChanged = cfg.pingIntervalMs !== this.cfg.pingIntervalMs;
    this.cfg = cfg;
    if (semChanged) {
      this.researchSem = new BoundedSemaphore(cfg.queueMaxDepth, 1);
      this.braveSem = new BoundedSemaphore(BRAVE_MAX_WAITING, cfg.braveConcurrency);
    }
    if (pathsChanged && this.child && !this.child.closed) {
      if (this.inFlight === 0) {
        void this.deliberateReplace("config path change");
      } else {
        this.pendingReplace = true;
        this.log.info?.("artemis: path config changed; child replacement deferred until idle");
      }
    }
    if (pingChanged && this.watchdogTimer) {
      this.startWatchdog();
    }
  }

  /** Eager start (config eagerStart:true) — fire and forget with logging. */
  warmStart(): void {
    void this.ensureReady().catch(() => {
      /* failure already recorded/logged */
    });
  }

  // ------------------------------------------------------------------ tools

  async research(
    question: string,
    threadId: string | undefined,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    const requestId = `openclaw-${randomUUID()}`;
    const effectiveThreadId = threadId ?? requestId;
    const t0 = Date.now();

    let release: (() => void) | null = null;
    try {
      try {
        release = await this.researchSem.acquire(this.cfg.queueTimeoutMs, signal);
      } catch (err) {
        throw this.queueFailure(err, requestId);
      }

      await this.ensureReady();
      const child = this.child;
      if (!child || child.closed) {
        throw new ArtemisFailure("STARTUP_FAILED", true, "retry when healthy", "no healthy child after start");
      }

      this.inFlight++;
      let outcome: CallOutcome;
      try {
        outcome = await callTool(
          child,
          "artemis_research",
          { question, thread_id: effectiveThreadId },
          { timeoutMs: this.cfg.researchTimeoutMs, signal },
        );
      } finally {
        this.inFlight--;
      }

      const elapsedMs = Date.now() - t0;
      if (outcome.isError || outcome.text.startsWith("TOOL_ERROR")) {
        const cat = classifyToolText(outcome.text, "artemis_research");
        this.recordError(cat.code, requestId);
        return {
          ok: false,
          text: formatFailure("artemis_research", cat, requestId),
          details: {
            requestId,
            threadId: effectiveThreadId,
            elapsedMs,
            errorCode: cat.code,
            retryable: cat.retryable,
          },
        };
      }
      return {
        ok: true,
        text: outcome.text,
        details: { requestId, threadId: effectiveThreadId, elapsedMs },
      };
    } catch (err) {
      return await this.handleExecutionFailure(err, "artemis_research", requestId, effectiveThreadId, t0, signal, true);
    } finally {
      release?.();
      this.maybeApplyPendingReplace();
    }
  }

  async brave(
    query: string,
    numResults: number,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    const requestId = `openclaw-${randomUUID()}`;
    const t0 = Date.now();

    let release: (() => void) | null = null;
    try {
      try {
        release = await this.braveSem.acquire(this.cfg.queueTimeoutMs, signal);
      } catch (err) {
        throw this.queueFailure(err, requestId);
      }

      await this.ensureReady();
      const child = this.child;
      if (!child || child.closed) {
        throw new ArtemisFailure("STARTUP_FAILED", true, "retry when healthy", "no healthy child after start");
      }

      this.inFlight++;
      let outcome: CallOutcome;
      try {
        outcome = await callTool(
          child,
          "artemis_brave_search",
          { query, num_results: numResults },
          { timeoutMs: this.cfg.braveTimeoutMs, signal },
        );
      } finally {
        this.inFlight--;
      }

      const elapsedMs = Date.now() - t0;
      if (outcome.isError || outcome.text.startsWith("TOOL_ERROR")) {
        const cat = classifyToolText(outcome.text, "artemis_brave_search");
        this.recordError(cat.code, requestId);
        return {
          ok: false,
          text: formatFailure("artemis_brave_search", cat, requestId),
          details: { requestId, elapsedMs, errorCode: cat.code, retryable: cat.retryable },
        };
      }
      const resultCount = isNoResults(outcome.text)
        ? 0
        : (outcome.text.match(/^\d+\./gm) ?? []).length;
      return {
        ok: true,
        text: outcome.text,
        details: { requestId, elapsedMs, resultCount },
      };
    } catch (err) {
      return await this.handleExecutionFailure(err, "artemis_brave_search", requestId, undefined, t0, signal, false);
    } finally {
      release?.();
      this.maybeApplyPendingReplace();
    }
  }

  // ------------------------------------------------------------------ status

  status(action?: string): StatusReport {
    if (action === "reset-circuit") {
      if (this.circuitOpen) {
        this.circuitOpen = false;
        this.restartEvents = [];
        this.nextStartNotBefore = 0;
        this.state = this.child && !this.child.closed ? "ready" : "stopped";
        this.log.info?.("artemis: circuit manually reset; auto-recovery re-armed");
      }
    }
    const child = this.child;
    return {
      state: this.state,
      generation: this.generation,
      pid: child && !child.closed ? child.pid : null,
      uptimeMs: child && !child.closed ? Date.now() - child.startedAt : null,
      lastHandshakeAt: this.lastHandshakeAt,
      serverVersion: child && !child.closed ? child.serverVersion : null,
      inFlight: this.inFlight,
      researchQueued: this.researchSem.waitingCount,
      braveActive: this.braveSem.activeCount,
      restartsInWindow: this.restartEvents.length,
      circuitOpen: this.circuitOpen,
      lastError: this.lastError,
      childStderrTail: child ? child.stderrRing.tail(4000) : "",
      limits: {
        researchTimeoutMs: this.cfg.researchTimeoutMs,
        braveTimeoutMs: this.cfg.braveTimeoutMs,
        queueMaxDepth: this.cfg.queueMaxDepth,
        queueTimeoutMs: this.cfg.queueTimeoutMs,
        braveConcurrency: this.cfg.braveConcurrency,
        maxRestarts: this.cfg.maxRestarts,
        restartWindowMs: this.cfg.restartWindowMs,
        readinessTimeoutMs: this.cfg.readinessTimeoutMs,
      },
    };
  }

  /** Plugin unload: reject new work, close the owned child, clear timers. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.state = "stopping";
    this.stopWatchdog();
    if (this.child) {
      const child = this.child;
      this.child = null;
      await closeChild(child, 5_000);
    }
    this.state = "stopped";
  }

  // ------------------------------------------------------------------ internals

  /** Idempotent, single-flight readiness. */
  private async ensureReady(): Promise<void> {
    if (this.stopping) throw new ArtemisFailure("UNAVAILABLE", false, "plugin stopping", "plugin is stopping");
    if (this.circuitOpen) {
      throw new ArtemisFailure(
        "CIRCUIT_OPEN",
        false,
        "run artemis_status with action='reset-circuit' or restart the gateway",
        "auto-recovery circuit is open after repeated child failures",
      );
    }
    if (this.child && !this.child.closed && this.state === "ready") return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const waitMs = this.nextStartNotBefore - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    // Never keep two children: close any lingering (possibly broken) child first.
    await this.closeCurrentChild();

    this.generation += 1;
    this.state = "starting";
    this.log.info?.(`artemis: starting child (generation ${this.generation})`);
    try {
      const child = await startChild(this.cfg, this.generation, this.log);
      this.child = child;
      this.lastHandshakeAt = Date.now();
      this.readySince = Date.now();
      this.state = "ready";
      this.startWatchdog();
    } catch (err) {
      const reason = err instanceof IncompatibleServer ? "incompatible-server" : "startup-failed";
      await this.closeCurrentChild();
      this.recordRestart(reason);
      this.nextStartNotBefore = Date.now() + this.nextBackoffMs();
      if (this.circuitOpen) {
        this.state = "circuit-open";
      } else {
        this.state = "degraded";
      }
      this.log.warn?.(`artemis: child start failed (${reason}); ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof IncompatibleServer) {
        throw new ArtemisFailure("INCOMPATIBLE_SERVER", false, "update the wrapper or plugin; check artemis_status", err.message);
      }
      throw new ArtemisFailure(
        "STARTUP_FAILED",
        true,
        "check artemis_status (child stderr tail) and retry",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Watchdog: ping only when idle; failure while idle counts toward circuit. */
  private startWatchdog(): void {
    this.stopWatchdog();
    if (this.cfg.pingIntervalMs <= 0) return;
    this.watchdogTimer = setInterval(() => {
      void this.watchdogTick();
    }, this.cfg.pingIntervalMs);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private async watchdogTick(): Promise<void> {
    const child = this.child;
    if (this.state !== "ready" || !child || child.closed) return;

    // Never replace during valid in-flight work.
    if (this.inFlight > 0) return;

    try {
      await child.client.ping({ timeout: this.cfg.pingTimeoutMs });
      // Stability accounting: healthy uptime clears the restart budget.
      if (this.readySince && this.restartEvents.length > 0) {
        if (Date.now() - this.readySince >= this.cfg.stableResetMs) {
          this.restartEvents = [];
          this.log.info?.("artemis: stable interval reached; restart budget cleared");
        }
      }
    } catch (err) {
      this.log.warn?.(`artemis: watchdog ping failed while idle; replacing child (${err instanceof Error ? err.message : String(err)})`);
      this.stopWatchdog();
      await this.closeCurrentChild();
      this.recordRestart("watchdog-ping-failure");
      this.nextStartNotBefore = Date.now() + this.nextBackoffMs();
      this.state = this.circuitOpen ? "circuit-open" : "degraded";
    }
  }

  /** Deliberate replacement (deadline/cancel/config): does NOT count as a crash. */
  private async deliberateReplace(reason: string): Promise<void> {
    this.stopWatchdog();
    await this.closeCurrentChild();
    this.state = "stopped";
    this.readySince = null;
    this.log.warn?.(`artemis: deliberate child replacement (${reason})`);
  }

  private async closeCurrentChild(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    await closeChild(child, 3_000);
  }

  private maybeApplyPendingReplace(): void {
    if (this.pendingReplace && this.inFlight === 0 && this.child && !this.child.closed) {
      this.pendingReplace = false;
      void this.deliberateReplace("pending config path change");
    }
  }

  private recordRestart(reason: string): void {
    const now = Date.now();
    this.restartEvents.push(now);
    const windowStart = now - this.cfg.restartWindowMs;
    this.restartEvents = this.restartEvents.filter((t) => t >= windowStart);
    this.lastError = { code: "STARTUP_FAILED", at: now };
    if (this.restartEvents.length >= this.cfg.maxRestarts) {
      this.circuitOpen = true;
      this.state = "circuit-open";
      this.log.error?.(
        `artemis: ${this.restartEvents.length} replacement attempts within ${this.cfg.restartWindowMs}ms window — circuit OPEN (${reason}). Manual reset required (artemis_status action='reset-circuit').`,
      );
    }
  }

  private nextBackoffMs(): number {
    const n = this.restartEvents.length;
    const base = Math.min(16_000, 1_000 * 2 ** Math.max(0, n - 1));
    const jitter = 0.75 + Math.random() * 0.5;
    return Math.round(base * jitter);
  }

  private recordError(code: ErrorCode, requestId?: string): void {
    this.lastError = { code, at: Date.now(), requestId };
  }

  private queueFailure(err: unknown, requestId: string): ArtemisFailure {
    if (err instanceof QueueOverflowError) {
      this.recordError("QUEUE_OVERFLOW", requestId);
      return new ArtemisFailure(
        "QUEUE_OVERFLOW",
        true,
        "retry when the current research completes (check artemis_status)",
        err.message,
        requestId,
      );
    }
    if (err instanceof QueueTimeoutError) {
      this.recordError("QUEUE_TIMEOUT", requestId);
      return new ArtemisFailure(
        "QUEUE_TIMEOUT",
        true,
        "queue is busy; retry later or raise queueMaxDepth/queueTimeoutMs",
        err.message,
        requestId,
      );
    }
    if (err instanceof CancelledError) {
      this.recordError("CANCELLED", requestId);
      return new ArtemisFailure("CANCELLED", false, "request was cancelled before execution", err.message, requestId);
    }
    return new ArtemisFailure("UNKNOWN_ERROR", false, "unexpected queue error", err instanceof Error ? err.message : String(err), requestId);
  }

  /** Normalize call-phase failures into ToolOutcome. Child replacement only
   *  for research (global state) — brave is stateless and the child stays.
   *  Async: research deadline/cancel paths AWAIT the child replacement so the
   *  serialized slot is not released while the old worker still runs. */
  private async handleExecutionFailure(
    err: unknown,
    tool: string,
    requestId: string,
    threadId: string | undefined,
    t0: number,
    signal: AbortSignal | undefined,
    isResearch: boolean,
  ): Promise<ToolOutcome> {
    const elapsedMs = Date.now() - t0;
    const details: Record<string, unknown> = { requestId, elapsedMs };

    if (err instanceof DeadlineMarker) {
      if (isResearch) {
        // The worker may still hold the (process-global) scrape budget:
        // replace the child so the serialized slot frees deterministically.
        // Deliberate — does not count toward the crash budget.
        await this.deliberateReplace(`research deadline ${err.timeoutMs}ms`);
      }
      const cat = {
        code: "DEADLINE_EXCEEDED" as ErrorCode,
        retryable: false,
        operatorStep: isResearch
          ? `raise researchTimeoutMs or retry with the same thread_id to resume from the last checkpoint`
          : `raise braveTimeoutMs and retry`,
        message: `execution exceeded the ${err.timeoutMs}ms deadline; outcome unknown`,
      };
      this.recordError(cat.code, requestId);
      if (threadId) details.threadId = threadId;
      details.errorCode = cat.code;
      details.retryable = cat.retryable;
      return { ok: false, text: formatFailure(tool, cat, requestId), details };
    }

    if (signal?.aborted) {
      if (isResearch) {
        await this.deliberateReplace("research cancelled");
      }
      const cat = {
        code: "OUTCOME_UNKNOWN" as ErrorCode,
        retryable: false,
        operatorStep: threadId
          ? `resume with the same thread_id (${threadId}) to continue from the last checkpoint`
          : `retry the request if still needed`,
        message: "request was cancelled mid-execution; child work may have partially run",
      };
      this.recordError(cat.code, requestId);
      if (threadId) details.threadId = threadId;
      details.errorCode = cat.code;
      details.retryable = cat.retryable;
      return { ok: false, text: formatFailure(tool, cat, requestId), details };
    }

    if (err instanceof CancelledError) {
      this.recordError("CANCELLED", requestId);
      const cat = {
        code: "CANCELLED" as ErrorCode,
        retryable: false,
        operatorStep: "retry the request if still needed",
        message: err.message,
      };
      if (threadId) details.threadId = threadId;
      details.errorCode = cat.code;
      details.retryable = cat.retryable;
      return { ok: false, text: formatFailure(tool, cat, requestId), details };
    }

    if (err instanceof StartupFailure || err instanceof IncompatibleServer) {
      // Call raced a child close or startup validation failure.
      const code: ErrorCode = err instanceof IncompatibleServer ? "INCOMPATIBLE_SERVER" : "TRANSPORT_EXIT";
      this.recordError(code, requestId);
      const cat = {
        code,
        retryable: true,
        operatorStep: "retry when the child is healthy (artemis_status)",
        message: err.message,
      };
      if (threadId) details.threadId = threadId;
      details.errorCode = cat.code;
      details.retryable = cat.retryable;
      return { ok: false, text: formatFailure(tool, cat, requestId), details };
    }

    if (err instanceof ArtemisFailure) {
      // ensureReady / queue failures surfaced here.
      this.recordError(err.code, requestId);
      if (threadId) details.threadId = threadId;
      details.errorCode = err.code;
      details.retryable = err.retryable;
      const cat = { code: err.code, retryable: err.retryable, operatorStep: err.operatorStep, message: err.message };
      return { ok: false, text: formatFailure(tool, cat, requestId), details };
    }

    // Transport exit mid-call (child died) or unexpected error.
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const looksTransport = /closed|connect|transport|pipe/i.test(msg);
    const cat = looksTransport
      ? {
          code: "TRANSPORT_EXIT" as ErrorCode,
          retryable: true,
          operatorStep: threadId
            ? `child exited mid-call; call again (same thread_id resumes from the last checkpoint if one exists)`
            : `child exited mid-call; call again`,
          message: msg,
        }
      : {
          code: "UNKNOWN_ERROR" as ErrorCode,
          retryable: false,
          operatorStep: "check artemis_status; report the error code if it persists",
          message: msg,
        };
    if (looksTransport) {
      // Child is gone: mark degraded so the next call restarts it.
      this.stopWatchdog();
      this.state = "degraded";
    }
    this.recordError(cat.code, requestId);
    if (threadId) details.threadId = threadId;
    details.errorCode = cat.code;
    details.retryable = cat.retryable;
    return { ok: false, text: formatFailure(tool, cat, requestId), details };
  }
}