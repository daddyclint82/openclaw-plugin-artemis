/** OpenClaw plugin entry: Artemis research tools.
 *
 * Exposes three required tools over a supervised, long-lived MCP child:
 *  - artemis_research   (deep cited research; serialized, resumable)
 *  - artemis_brave_search (quick sourced lookups)
 *  - artemis_status     (free diagnostics + manual circuit reset)
 *
 * Config comes from plugins.entries.artemis.config (api.pluginConfig at
 * registration, refreshed per-call from the runtime config when available).
 * No secrets flow through this plugin: the child loads provider keys itself
 * from its own .env; only non-secret env is passed explicitly.
 */

import os from "node:os";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ArtemisManager, type StatusReport } from "./manager.js";
import { resolveConfig, type LoggerLike, type ResolvedConfig } from "./types.js";

interface ToolContextLike {
  runtimeConfig?: unknown;
  getRuntimeConfig?: () => unknown;
  sandboxed?: boolean;
}

interface RegisterApiLike {
  logger?: LoggerLike;
  pluginConfig?: unknown;
  runtimeConfig?: unknown;
  registerTool?: (tool: unknown, meta?: { name?: string; optional?: boolean }) => void;
  onUnload?: (fn: () => void) => void;
}

function pluginConfigFromRuntime(rc: unknown): unknown {
  const entries = (rc as { plugins?: { entries?: Record<string, { config?: unknown }> } } | undefined)
    ?.plugins?.entries;
  const entry = entries?.["artemis"];
  return entry?.config;
}

const STATUS_LIMITS_SCHEMA = Type.Object(
  {
    researchTimeoutMs: Type.Number(),
    braveTimeoutMs: Type.Number(),
    queueMaxDepth: Type.Number(),
    queueTimeoutMs: Type.Number(),
    braveConcurrency: Type.Number(),
    maxRestarts: Type.Number(),
    restartWindowMs: Type.Number(),
    readinessTimeoutMs: Type.Number(),
  },
  { additionalProperties: false },
);

export default definePluginEntry({
  id: "artemis",
  name: "Artemis Research",
  description:
    "Quick sourced Brave lookups and deep cited multi-engine research via a supervised, long-lived Artemis MCP child.",
  register(_api: unknown) {
    const api = _api as RegisterApiLike;
    const log: LoggerLike = api.logger ?? console;
    const homedir = os.homedir();
    const baseConfig = resolveConfig(
      api.pluginConfig ?? pluginConfigFromRuntime(api.runtimeConfig),
      homedir,
    );
    const manager = new ArtemisManager(baseConfig, log);

    if (baseConfig.eagerStart) manager.warmStart();

    // Opportunistic unload hook (not all SDK versions expose one; the child
    // also exits on stdin EOF when the gateway process dies).
    if (typeof api.onUnload === "function") {
      api.onUnload(() => {
        void manager.stop();
      });
    }

    const refreshConfig = (toolContext: ToolContextLike): void => {
      try {
        const rc = toolContext.getRuntimeConfig?.() ?? toolContext.runtimeConfig;
        const raw = pluginConfigFromRuntime(rc);
        if (raw && typeof raw === "object") {
          const cfg: ResolvedConfig = resolveConfig(raw, homedir);
          manager.updateConfig(cfg);
        }
      } catch {
        /* keep current config */
      }
    };

    api.registerTool?.(
      (toolContext: ToolContextLike) => ({
        name: "artemis_research",
        description:
          "Deep multi-engine internet research: decomposes the question into sub-questions, searches across SearXNG/Brave/Exa in parallel, scrapes the most promising pages, and synthesizes a cited answer with a confidence rating. SLOW: typically 60-180 seconds. Use for non-trivial research questions that need sources — NOT for simple factual lookups (use artemis_brave_search for those). thread_id is optional: pass a prior run's openclaw-... id to resume an interrupted run from its last checkpoint.",
        parameters: Type.Object({
          question: Type.String({
            minLength: 1,
            maxLength: 2000,
            description: "The research question to investigate.",
          }),
          thread_id: Type.Optional(
            Type.String({
              description:
                "Optional research thread id: pass a prior run's id (from the result's threadId) to resume it, or to isolate this run from other runs of the same question.",
              pattern: "^(openclaw-[0-9a-f-]{36}|[0-9a-f]{12}-[0-9]{8})$",
            }),
          ),
        }),
        outputSchema: Type.Object(
          {
            requestId: Type.String(),
            threadId: Type.Optional(Type.String()),
            elapsedMs: Type.Number(),
            errorCode: Type.Optional(Type.String()),
            retryable: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        async execute(
          _toolCallId: string,
          params: { question: string; thread_id?: string },
          signal?: AbortSignal,
        ) {
          refreshConfig(toolContext);
          const question = typeof params?.question === "string" ? params.question.trim() : "";
          if (!question || question.length > 2000) {
            return {
              content: [
                {
                  type: "text",
                  text: "Artemis research failed [VALIDATION_ERROR]: question must be 1-2000 characters.",
                },
              ],
              details: {
                requestId: "openclaw-invalid-request",
                elapsedMs: 0,
                errorCode: "VALIDATION_ERROR",
                retryable: false,
              },
            };
          }
          const outcome = await manager.research(question, params?.thread_id, signal);
          return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
        },
      }),
      { name: "artemis_research", optional: false },
    );

    api.registerTool?.(
      (toolContext: ToolContextLike) => ({
        name: "artemis_brave_search",
        description:
          "Quick web search via the Brave Search API (independent index). Returns numbered results with title, URL, and snippet. Prefer this for fast, sourced lookups; use artemis_research only for deep multi-source questions.",
        parameters: Type.Object({
          query: Type.String({
            minLength: 1,
            maxLength: 400,
            description: "The search query.",
          }),
          num_results: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 20,
              description: "Number of results (default 8, max 20).",
            }),
          ),
        }),
        outputSchema: Type.Object(
          {
            requestId: Type.String(),
            elapsedMs: Type.Number(),
            resultCount: Type.Optional(Type.Number()),
            errorCode: Type.Optional(Type.String()),
            retryable: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        async execute(
          _toolCallId: string,
          params: { query: string; num_results?: number },
          signal?: AbortSignal,
        ) {
          refreshConfig(toolContext);
          const query = typeof params?.query === "string" ? params.query.trim() : "";
          const n = Number.isInteger(params?.num_results)
            ? Math.min(20, Math.max(1, params.num_results as number))
            : 8;
          if (!query || query.length > 400) {
            return {
              content: [
                {
                  type: "text",
                  text: "Artemis brave search failed [VALIDATION_ERROR]: query must be 1-400 characters.",
                },
              ],
              details: {
                requestId: "openclaw-invalid-request",
                elapsedMs: 0,
                errorCode: "VALIDATION_ERROR",
                retryable: false,
              },
            };
          }
          const outcome = await manager.brave(query, n, signal);
          return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
        },
      }),
      { name: "artemis_brave_search", optional: false },
    );

    api.registerTool?.(
      (toolContext: ToolContextLike) => ({
        name: "artemis_status",
        description:
          "Report the Artemis subsystem state: child lifecycle, generation, pid, uptime, queue depth, restart budget, circuit state, last categorized failure, and recent child stderr (redacted). Free — never spends search credits. Optional action='reset-circuit' manually re-arms auto-recovery after the circuit opened.",
        parameters: Type.Object({
          action: Type.Optional(
            Type.Union([Type.Literal("reset-circuit")], {
              description: "Set to 'reset-circuit' to clear an open failure circuit.",
            }),
          ),
        }),
        outputSchema: Type.Object(
          {
            state: Type.String(),
            generation: Type.Number(),
            pid: Type.Union([Type.Number(), Type.Null()]),
            uptimeMs: Type.Union([Type.Number(), Type.Null()]),
            lastHandshakeAt: Type.Union([Type.Number(), Type.Null()]),
            serverVersion: Type.Union([Type.String(), Type.Null()]),
            inFlight: Type.Number(),
            researchQueued: Type.Number(),
            braveActive: Type.Number(),
            restartsInWindow: Type.Number(),
            circuitOpen: Type.Boolean(),
            lastError: Type.Union([
              Type.Object(
                {
                  code: Type.String(),
                  at: Type.Number(),
                  requestId: Type.Optional(Type.String()),
                },
                { additionalProperties: false },
              ),
              Type.Null(),
            ]),
            childStderrTail: Type.String(),
            limits: STATUS_LIMITS_SCHEMA,
          },
          { additionalProperties: false },
        ),
        async execute(
          _toolCallId: string,
          params: { action?: "reset-circuit" },
        ): Promise<{ content: Array<{ type: "text"; text: string }>; details: StatusReport }> {
          refreshConfig(toolContext);
          const report = manager.status(params?.action);
          const text = [
            `Artemis state: ${report.state}${report.circuitOpen ? " (CIRCUIT OPEN)" : ""}`,
            `child: generation ${report.generation}, pid ${report.pid ?? "-"}, uptime ${report.uptimeMs ?? "-"}ms, server ${report.serverVersion ?? "-"}`,
            `work: in-flight ${report.inFlight}, research queued ${report.researchQueued}, brave active ${report.braveActive}`,
            `restarts in window: ${report.restartsInWindow}/${report.limits.maxRestarts}`,
            `last error: ${report.lastError ? `${report.lastError.code} at ${new Date(report.lastError.at).toISOString()}` : "none"}`,
            `limits: research ${report.limits.researchTimeoutMs}ms, brave ${report.limits.braveTimeoutMs}ms, queue depth ${report.limits.queueMaxDepth}, queue wait ${report.limits.queueTimeoutMs}ms`,
          ].join("\n");
          return { content: [{ type: "text", text }], details: report };
        },
      }),
      { name: "artemis_status", optional: false },
    );
  },
});