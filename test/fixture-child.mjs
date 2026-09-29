#!/usr/bin/env node
/** Fixture MCP child for tests: same tool names as the real Artemis wrapper,
 *  behavior driven by a mode file next to this script (`${script}.mode`).
 *
 * Modes:
 *   echo          (default) — research echoes thread/question + selected env;
 *                            brave returns fake numbered results
 *   error_text    — brave: TOOL_ERROR brave_search: BRAVE_API_KEY not set
 *                   research: TOOL_ERROR artemis_research: budget exhausted
 *   is_error      — research returns isError:true with text
 *   slow_init <ms> — delays startup before serving initialize
 *   crash_init    — exits(1) immediately
 *   crash_call    — research call exits the process after 100ms without replying
 *   hang          — research never responds (deadline/cancel testing)
 *   unknown_tools — advertises only an unrelated tool (readiness must fail)
 *   serial_latch  — research waits for `${script}.latch` to exist, appends
 *                   start/end timestamps to `${script}.log`
 *   no_results    — brave returns NO_RESULTS
 */

import { readFile, stat } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const scriptPath = process.argv[1] ?? "";
const modeFile = `${scriptPath}.mode`;
const latchFile = `${scriptPath}.latch`;
const logFile = `${scriptPath}.log`;

const modeRaw = await readFile(modeFile, "utf8").catch(() => "echo");
const [mode, modeArg] = modeRaw.trim().split(/\s+/);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === "crash_init") {
  process.exit(1);
}
if (mode === "slow_init") {
  await sleep(Number(modeArg) || 2000);
}

const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string" },
    thread_id: { type: "string" },
  },
  required: ["question"],
};
const BRAVE_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    num_results: { type: "integer" },
  },
  required: ["query"],
};

const server = new Server(
  { name: "artemis-fixture", version: "test" },
  {
    capabilities: { tools: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools:
    mode === "unknown_tools"
      ? [{ name: "other_tool", description: "not artemis", inputSchema: { type: "object" } }]
      : [
          {
            name: "artemis_research",
            description: "fixture research",
            inputSchema: RESEARCH_SCHEMA,
          },
          {
            name: "artemis_brave_search",
            description: "fixture brave",
            inputSchema: BRAVE_SCHEMA,
          },
        ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params ?? {};

  if (mode === "unknown_tools") {
    return {
      content: [{ type: "text", text: `TOOL_ERROR unknown tool: ${name}` }],
      isError: false,
    };
  }

  if (name === "artemis_brave_search") {
    if (mode === "error_text") {
      return { content: [{ type: "text", text: "TOOL_ERROR brave_search: BRAVE_API_KEY not set" }], isError: false };
    }
    if (mode === "no_results") {
      return { content: [{ type: "text", text: "NO_RESULTS" }], isError: false };
    }
    const q = String(args?.query ?? "");
    const n = Number(args?.num_results) || 8;
    const lines = [];
    for (let i = 1; i <= n; i++) {
      lines.push(`${i}. Fake Result ${i} for ${q}\n   URL: https://example.com/${i}\n   Snippet: fixture snippet ${i}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
  }

  if (name === "artemis_research") {
    if (mode === "error_text") {
      return { content: [{ type: "text", text: "TOOL_ERROR artemis_research: scrape budget exhausted (5 max). Synthesize with what you have." }], isError: false };
    }
    if (mode === "is_error") {
      return { content: [{ type: "text", text: "simulated provider failure" }], isError: true };
    }
    if (mode === "crash_call") {
      setTimeout(() => process.exit(1), 100);
      await sleep(60_000);
      return { content: [{ type: "text", text: "unreachable" }], isError: false };
    }
    if (mode === "hang") {
      await sleep(600_000);
      return { content: [{ type: "text", text: "unreachable" }], isError: false };
    }
    if (mode === "serial_latch") {
      const started = Date.now();
      const { appendFile } = await import("node:fs/promises");
      await appendFile(logFile, `start ${started}\n`);
      for (;;) {
        try {
          await stat(latchFile);
          break;
        } catch {
          await sleep(20);
        }
      }
      await appendFile(logFile, `end ${Date.now()}\n`);
      return {
        content: [
          {
            type: "text",
            text: `LATCHED_ANSWER started=${started} ended=${Date.now()} thread=${args?.thread_id ?? "none"}`,
          },
        ],
        isError: false,
      };
    }
    // echo (default)
    const env = {
      ARTEMIS_PATH: process.env.ARTEMIS_PATH ?? null,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? null,
      CHECKPOINT_DB: process.env.CHECKPOINT_DB ?? null,
    };
    return {
      content: [
        {
          type: "text",
          text: `FAKE_RESEARCH_ANSWER thread=${args?.thread_id ?? "none"} q=${args?.question} env=${JSON.stringify(env)}`,
        },
      ],
      isError: false,
    };
  }

  return { content: [{ type: "text", text: `TOOL_ERROR unknown tool: ${name}` }], isError: false };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`fixture child ready (mode=${mode})`);