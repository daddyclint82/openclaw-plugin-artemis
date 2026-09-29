# Operator Guide — Artemis plugin for OpenClaw

Everything needed to install, operate, diagnose, and roll back — without either
agent's memory.

## What this adds

Three agent tools: `artemis_brave_search` (quick sourced lookups),
`artemis_research` (deep cited research, 60–180s typical), and
`artemis_status` (free diagnostics + manual circuit reset). Backed by any
Artemis research agent install (Python/LangGraph checkout with a `server.py`
MCP wrapper and a provisioned venv — defaults assume `~/.openclaw/artemis/`),
driven over stdio MCP by an OpenClaw-owned, supervised child process.

## Install / update / disable

```bash
# install (from the plugin repo root)
npm pack
openclaw plugins install npm-pack:./openclaw-plugin-artemis-<version>.tgz
openclaw plugins enable artemis      # third-party plugins require explicit enable
# restart or reload the gateway, then verify runtime registration:
openclaw plugins inspect artemis --runtime --json

# update
openclaw plugins install npm-pack:./openclaw-plugin-artemis-<new-version>.tgz --force
# reload the gateway; config and checkpoint state are preserved

# disable (stops the child and removes the tools; keeps config)
openclaw plugins disable artemis
```

## Configuration

All fields optional. Edit
`plugins.entries.artemis.config` in `openclaw.json` (gateway reload applies);
tilde-leading paths are expanded against the gateway user's home:

| Field | Default | Meaning |
| --- | --- | --- |
| `pythonPath` | `~/.openclaw/artemis/venv/bin/python` | Interpreter for the MCP child |
| `serverPath` | `~/.openclaw/artemis/server.py` | MCP wrapper script |
| `artemisPath` | `~/.openclaw/artemis` | `ARTEMIS_PATH` for the child |
| `ollamaBaseUrl` | `http://127.0.0.1:11434` | LLM bridge URL (config, not a credential) |
| `checkpointDb` | `~/.openclaw/artemis/checkpoints.sqlite` | This gateway's isolated research checkpoints |
| `eagerStart` | `false` | Start the child at plugin load instead of first use |
| `readinessTimeoutMs` | `30000` | Spawn → tools/list deadline |
| `researchTimeoutMs` | `300000` | Research execution deadline (set ≥ your client's request timeout) |
| `braveTimeoutMs` | `60000` | Brave call deadline |
| `queueMaxDepth` | `2` | Research requests that may WAIT while one runs |
| `queueTimeoutMs` | `300000` | Max queue wait before QUEUE_TIMEOUT |
| `braveConcurrency` | `4` | Concurrent brave calls |
| `pingIntervalMs` / `pingTimeoutMs` | `30000` / `10000` | Watchdog cadence |
| `maxRestarts` / `restartWindowMs` | `3` / `600000` | Auto-restart budget window |
| `stableResetMs` | `300000` | Healthy uptime that clears the restart budget |

## Secrets policy (Phase 1)

**No credentials pass through this plugin.** The Python child loads provider
keys itself from `<artemisPath>/.env` (BRAVE_API_KEY, EXA_API_KEY,
FIRECRAWL_API_KEY, OLLAMA_BASE_URL) — the same store OpenCode's child uses.
The plugin passes only non-secret env, so:

- Do **not** put keys in `openclaw.json`, plugin config, or tool prompts.
- To rotate a key: edit `<artemisPath>/.env`, then `artemis_status` → if degraded,
  the next request restarts the child; otherwise `openclaw plugins disable
  artemis` + re-enable forces a fresh child.
- Optional future (needs explicit ratification): plugin-config SecretRefs
  (env source) resolved in-memory at gateway activation. Not implemented in
  this release.

## Status interpretation (`artemis_status`)

`state`: `stopped` (lazy, child absent) → `starting` → `ready` → `degraded`
(start failed recently; retrying auto-applies backoff) → `circuit-open`
(auto-recovery suspended; manual reset required) → `stopping`.

Key fields: `pid`/`uptimeMs` (child liveness), `inFlight` (calls executing
against the child), `researchQueued` (waiting research), `restartsInWindow`
vs `limits.maxRestarts` (failure budget), `circuitOpen`, `lastError.code`,
`childStderrTail` (last ~4 KB of child stderr, credential-redacted).

A status call never spends search credits.

## Error codes and remedies

| Code | Retryable | Remedy |
| --- | --- | --- |
| `VALIDATION_ERROR` | no | Fix the tool arguments (question 1–2000 chars, query 1–400, num_results 1–20). |
| `MISSING_CREDENTIAL` | no | Set the named key in `<artemisPath>/.env`, restart the child (disable/enable the plugin or just retry — lazy start picks it up on next request only for a NEW child). |
| `BUDGET_EXHAUSTED` | no | Scrape budget hit; raise `MAX_SCRAPES` in `<artemisPath>/.env` or start a fresh run (omit thread_id). |
| `PROVIDER_ERROR` | yes | Usually transient (engine outage/rate limit). Check `childStderrTail` via status; retry after a pause. |
| `NO_RESULTS` | — | Valid empty result, not a failure. Widen the query. |
| `DEADLINE_EXCEEDED` | no | Research exceeded `researchTimeoutMs`; the child was replaced. Retry with the same `thread_id` (from the result) to resume from the last checkpoint, or raise the deadline. |
| `QUEUE_OVERFLOW` / `QUEUE_TIMEOUT` | yes | Research queue full/busy; retry when `researchQueued` drops, or raise `queueMaxDepth`/`queueTimeoutMs`. |
| `TRANSPORT_EXIT` | yes | Child died mid-call. Auto-recovery restarts it; call again (same `thread_id` resumes if a checkpoint exists). Research is never auto-replayed — that is deliberate. |
| `STARTUP_FAILED` | yes | Child could not initialize; check `childStderrTail` (bad `pythonPath`/`serverPath`, missing `.env` perms, port-less local SearXNG is fine — it degrades per-engine). |
| `CIRCUIT_OPEN` | no | Repeated failures tripped the breaker. Inspect status, fix the underlying issue, then `artemis_status {action: "reset-circuit"}`. |
| `INCOMPATIBLE_SERVER` | no | The wrapper does not expose the contracted tools; update the wrapper or the plugin. |
| `CHECKPOINT_ERROR` | no | SQLite issue on the checkpoint store; check both consumers' `CHECKPOINT_DB` (this plugin's is isolated by default). |
| `OUTCOME_UNKNOWN` | no | Request cancelled mid-research; the child was replaced. Resume explicitly with the same `thread_id`. |
| `CANCELLED` | no | Cancelled before/at admission; retry if still needed. |

## Manual circuit recovery

```
Ask the agent: "run artemis_status with action reset-circuit"
```
This clears the breaker and the restart budget; the next request lazily starts
a fresh child. A gateway restart has the same effect.

## Rollback (verified)

Two independent layers; roll back either or both:

1. **Plugin** (no data loss): `openclaw plugins disable artemis` — child stops,
   tools disappear, config and checkpoints (`~/.openclaw/artemis/`) remain.
   To fully remove: `openclaw plugins uninstall artemis`.
2. **Shared wrapper patch** (if installed): the only shared-source change is
   `patches/server-tothread.patch` (makes the 5 thin tools non-blocking via
   `asyncio.to_thread` — same pattern research already used). Revert with:
   ```bash
   cd <directory containing the wrapper `server.py`>
   patch -R server.py < /path/to/openclaw-plugin-artemis/patches/server-tothread.patch
   ```
   Other runtimes sharing the install keep working after the revert (the
   plugin only degrades concurrent brave/research overlap; correctness is
   unaffected).

No credential migration is tied to this rollback — none was performed.

## Shared-source disclosure

One file changed outside the plugin: the Artemis wrapper `server.py`
(5 call sites → `await asyncio.to_thread(_invoke, …)`). Other runtimes sharing
the install were re-verified after the change (plugin env shape and a
restricted-env shape both initialize and list tools — covered by
`test/integration.real.test.ts`).