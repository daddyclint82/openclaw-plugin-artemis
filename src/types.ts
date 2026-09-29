/** Plugin config types, defaults, and validation. */

export interface ArtemisPluginConfig {
  pythonPath?: string;
  serverPath?: string;
  artemisPath?: string;
  ollamaBaseUrl?: string;
  checkpointDb?: string;
  eagerStart?: boolean;
  readinessTimeoutMs?: number;
  researchTimeoutMs?: number;
  braveTimeoutMs?: number;
  queueMaxDepth?: number;
  queueTimeoutMs?: number;
  braveConcurrency?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  stableResetMs?: number;
}

export type ResolvedConfig = Required<ArtemisPluginConfig>;

/** Minimal logger surface the manager needs (api.logger satisfies this). */
export interface LoggerLike {
  info?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;
  error?: (msg: string, ...args: unknown[]) => void;
  debug?: (msg: string, ...args: unknown[]) => void;
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  pythonPath: "~/.openclaw/artemis/venv/bin/python",
  serverPath: "~/.openclaw/artemis/server.py",
  artemisPath: "~/.openclaw/artemis",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  checkpointDb: "~/.openclaw/artemis/checkpoints.sqlite",
  eagerStart: false,
  readinessTimeoutMs: 30_000,
  researchTimeoutMs: 300_000,
  braveTimeoutMs: 60_000,
  queueMaxDepth: 2,
  queueTimeoutMs: 300_000,
  braveConcurrency: 4,
  pingIntervalMs: 30_000,
  pingTimeoutMs: 10_000,
  maxRestarts: 3,
  restartWindowMs: 600_000,
  stableResetMs: 300_000,
};

function asString(v: unknown, fallback: string, minLen = 1): string {
  if (typeof v === "string" && v.trim().length >= minLen) return v.trim();
  return fallback;
}

function asInt(v: unknown, fallback: number, min: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= min) return Math.floor(v);
  return fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Resolve `~`-relative paths against the given home directory. */
export function expandTilde(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/")) return homedir + p.slice(1);
  return p;
}

/**
 * Merge raw plugin config over defaults with strict bounds. Unknown keys are
 * ignored (the manifest schema rejects them at the config surface anyway).
 */
export function resolveConfig(raw: unknown, homedir: string): ResolvedConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const cfg: ResolvedConfig = {
    pythonPath: expandTilde(asString(r.pythonPath, DEFAULT_CONFIG.pythonPath), homedir),
    serverPath: expandTilde(asString(r.serverPath, DEFAULT_CONFIG.serverPath), homedir),
    artemisPath: expandTilde(asString(r.artemisPath, DEFAULT_CONFIG.artemisPath), homedir),
    ollamaBaseUrl: asString(r.ollamaBaseUrl, DEFAULT_CONFIG.ollamaBaseUrl),
    checkpointDb: expandTilde(
      asString(r.checkpointDb, DEFAULT_CONFIG.checkpointDb),
      homedir,
    ),
    eagerStart: asBool(r.eagerStart, DEFAULT_CONFIG.eagerStart),
    readinessTimeoutMs: asInt(r.readinessTimeoutMs, DEFAULT_CONFIG.readinessTimeoutMs, 1_000),
    researchTimeoutMs: asInt(r.researchTimeoutMs, DEFAULT_CONFIG.researchTimeoutMs, 1_000),
    braveTimeoutMs: asInt(r.braveTimeoutMs, DEFAULT_CONFIG.braveTimeoutMs, 1_000),
    queueMaxDepth: asInt(r.queueMaxDepth, DEFAULT_CONFIG.queueMaxDepth, 0),
    queueTimeoutMs: asInt(r.queueTimeoutMs, DEFAULT_CONFIG.queueTimeoutMs, 1_000),
    braveConcurrency: asInt(r.braveConcurrency, DEFAULT_CONFIG.braveConcurrency, 1),
    pingIntervalMs: asInt(r.pingIntervalMs, DEFAULT_CONFIG.pingIntervalMs, 100),
    pingTimeoutMs: asInt(r.pingTimeoutMs, DEFAULT_CONFIG.pingTimeoutMs, 100),
    maxRestarts: asInt(r.maxRestarts, DEFAULT_CONFIG.maxRestarts, 1),
    restartWindowMs: asInt(r.restartWindowMs, DEFAULT_CONFIG.restartWindowMs, 1_000),
    stableResetMs: asInt(r.stableResetMs, DEFAULT_CONFIG.stableResetMs, 1_000),
  };
  return cfg;
}