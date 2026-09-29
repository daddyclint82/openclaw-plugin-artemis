/** Error categorization: stable codes, retryable flags, operator next steps. */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "MISSING_CREDENTIAL"
  | "BUDGET_EXHAUSTED"
  | "PROVIDER_ERROR"
  | "NO_RESULTS"
  | "DEADLINE_EXCEEDED"
  | "QUEUE_OVERFLOW"
  | "QUEUE_TIMEOUT"
  | "TRANSPORT_EXIT"
  | "STARTUP_FAILED"
  | "CIRCUIT_OPEN"
  | "INCOMPATIBLE_SERVER"
  | "CHECKPOINT_ERROR"
  | "OUTCOME_UNKNOWN"
  | "CANCELLED"
  | "UNAVAILABLE"
  | "UNKNOWN_ERROR";

export interface CategorizedError {
  code: ErrorCode;
  retryable: boolean;
  /** Short imperative for the operator (or model) — what to do next. */
  operatorStep: string;
  /** Redacted, bounded human message. */
  message: string;
}

/** Typed failure thrown by manager/client code. */
export class ArtemisFailure extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly retryable: boolean,
    public readonly operatorStep: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ArtemisFailure";
  }
}

/** Marker classes so control flow never string-matches on messages. */
export class DeadlineMarker extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`deadline exceeded after ${timeoutMs}ms`);
    this.name = "DeadlineMarker";
  }
}
export class StartupFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupFailure";
  }
}
export class IncompatibleServer extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleServer";
  }
}

export function isNoResults(text: string): boolean {
  return text.trim() === "NO_RESULTS";
}

/** Classify `TOOL_ERROR <tool>: <msg>` text (the wrapper's legacy error contract).
 *  Pattern classification runs against the RAW text: the prefix regex strips
 *  `TOOL_ERROR <name>:`, and that <name> slot can itself carry a phrase like
 *  "unknown tool" — so matching only the stripped tail would miss it. */
export function classifyToolText(rawText: string, toolName: string): CategorizedError {
  const t = rawText;
  let text = rawText;
  const prefix = new RegExp(`^TOOL_ERROR\\s+[^:]+:\\s*`);
  if (prefix.test(text)) text = text.replace(prefix, "");
  const msg = text.slice(0, 500);

  if (/BRAVE_API_KEY not set/.test(t))
    return {
      code: "MISSING_CREDENTIAL",
      retryable: false,
      operatorStep: `Set BRAVE_API_KEY in artemis2/.env (or per-consumer env), then retry.`,
      message: msg,
    };
  if (/EXA_API_KEY not set|FIRECRAWL_API_KEY (missing|not set|invalid)/.test(t))
    return {
      code: "MISSING_CREDENTIAL",
      retryable: false,
      operatorStep: `Set the named key in artemis2/.env, then retry.`,
      message: msg,
    };
  if (/budget exhausted/.test(t))
    return {
      code: "BUDGET_EXHAUSTED",
      retryable: false,
      operatorStep: `Run is at its scrape budget; raise MAX_SCRAPES or start a fresh run (new thread_id).`,
      message: msg,
    };
  if (/database is locked|sqlite|checkpoint/i.test(t))
    return {
      code: "CHECKPOINT_ERROR",
      retryable: false,
      operatorStep: `Inspect the CHECKPOINT_DB store via artemis_status; if locked, wait for the other consumer to finish.`,
      message: msg,
    };
  if (/unknown tool/.test(t))
    return {
      code: "INCOMPATIBLE_SERVER",
      retryable: false,
      operatorStep: `The server does not implement ${toolName}; update the wrapper or the plugin.`,
      message: msg,
    };
  if (/rate limit|429/.test(t))
    return {
      code: "PROVIDER_ERROR",
      retryable: true,
      operatorStep: `Provider rate-limited; wait before retrying.`,
      message: msg,
    };
  return {
    code: "PROVIDER_ERROR",
    retryable: true,
    operatorStep: `Check engine state via artemis_status (child stderr tail); retry if transient.`,
    message: msg,
  };
}

/** Build the model-facing text for a categorized failure. */
export function formatFailure(tool: string, cat: CategorizedError, requestId?: string): string {
  const retry = cat.retryable ? " (retryable)" : "";
  const req = requestId ? ` [request ${requestId}]` : "";
  return `Artemis ${tool} failed [${cat.code}]${retry}: ${cat.message}. Next step: ${cat.operatorStep}${req}`;
}