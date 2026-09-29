# openclaw-plugin-artemis

Artemis research tools for OpenClaw: quick sourced Brave lookups and deep
cited multi-engine research via a supervised, long-lived Artemis MCP child.

## Tools

| Tool | Purpose |
| --- | --- |
| `artemis_brave_search` | Quick sourced web lookups (Brave Search API). Numbered results with title/URL/snippet. |
| `artemis_research` | Deep multi-engine research: decompose → search (SearXNG/Brave/Exa) → scrape (Firecrawl) → cited synthesis with confidence. Slow (60–180s). Serialized; resumable via `thread_id`. |
| `artemis_status` | Free diagnostics: child lifecycle, queue depth, restart budget, circuit state, redacted child stderr. `action: "reset-circuit"` re-arms auto-recovery. |

## Install

```bash
npm pack
openclaw plugins install npm-pack:./openclaw-plugin-artemis-<version>.tgz
openclaw plugins enable artemis
# then restart/reload the gateway
openclaw plugins inspect artemis --runtime --json
```

Configuration lives at `plugins.entries.artemis.config` — see
[OPERATOR.md](./OPERATOR.md) for every field, the status/error code reference,
and the verified rollback procedure.

## Design notes

- One OpenClaw-owned Python child per gateway, spawned and supervised by the
  plugin through the maintained Node MCP client SDK. A runtime that spawns its
  own child against the same Artemis install keeps a separate process; neither
  runtime touches the other's checkpoint store (`CHECKPOINT_DB` isolates this
  gateway's runs).
- No secrets flow through the plugin or its config: the child loads provider
  keys itself from `<artemisPath>/.env` (Artemis-owned). Only non-secret env
  (`ARTEMIS_PATH`, `OLLAMA_BASE_URL`, `CHECKPOINT_DB`) is passed explicitly.
- Bounded self-healing: startup/watchdog failures count against a rolling
  restart window; over budget the circuit opens and stays closed until a
  manual `artemis_status {action: "reset-circuit"}`. Deliberate replacements
  (deadline/cancel) never count as crashes.
- Research is never auto-replayed after an ambiguous failure; resume is
  explicit via `thread_id`.