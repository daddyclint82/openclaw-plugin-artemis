/** Error normalization unit tests (handoff coverage 2). */

import { describe, expect, it } from "vitest";
import { classifyToolText, formatFailure, isNoResults } from "../src/errors.js";

describe("classifyToolText", () => {
  it("brave missing key -> MISSING_CREDENTIAL (not retryable)", () => {
    const cat = classifyToolText("TOOL_ERROR brave_search: BRAVE_API_KEY not set", "artemis_brave_search");
    expect(cat.code).toBe("MISSING_CREDENTIAL");
    expect(cat.retryable).toBe(false);
    expect(cat.message).toBe("BRAVE_API_KEY not set");
    expect(cat.operatorStep).toContain("artemis2/.env");
  });

  it("exa missing key -> MISSING_CREDENTIAL", () => {
    const cat = classifyToolText("TOOL_ERROR exa_search: EXA_API_KEY not set", "artemis_exa_search");
    expect(cat.code).toBe("MISSING_CREDENTIAL");
  });

  it("firecrawl missing key -> MISSING_CREDENTIAL", () => {
    const cat = classifyToolText(
      "TOOL_ERROR firecrawl_search: FIRECRAWL_API_KEY missing or invalid. Use searxng_search instead.",
      "artemis_firecrawl_search",
    );
    expect(cat.code).toBe("MISSING_CREDENTIAL");
  });

  it("scrape budget exhausted -> BUDGET_EXHAUSTED", () => {
    const cat = classifyToolText(
      "TOOL_ERROR firecrawl_scrape: scrape budget exhausted (5 max). Synthesize with what you have.",
      "artemis_firecrawl_scrape",
    );
    expect(cat.code).toBe("BUDGET_EXHAUSTED");
    expect(cat.retryable).toBe(false);
  });

  it("sqlite lock -> CHECKPOINT_ERROR", () => {
    const cat = classifyToolText("TOOL_ERROR artemis_research: database is locked", "artemis_research");
    expect(cat.code).toBe("CHECKPOINT_ERROR");
  });

  it("unknown tool -> INCOMPATIBLE_SERVER", () => {
    const cat = classifyToolText("TOOL_ERROR unknown tool: artemis_research", "artemis_research");
    expect(cat.code).toBe("INCOMPATIBLE_SERVER");
  });

  it("rate limit -> PROVIDER_ERROR retryable", () => {
    const cat = classifyToolText("TOOL_ERROR brave_search: 429 rate limited", "artemis_brave_search");
    expect(cat.code).toBe("PROVIDER_ERROR");
    expect(cat.retryable).toBe(true);
  });

  it("unrecognized tool error -> PROVIDER_ERROR retryable", () => {
    const cat = classifyToolText("TOOL_ERROR brave_search: something unexpected happened", "artemis_brave_search");
    expect(cat.code).toBe("PROVIDER_ERROR");
    expect(cat.retryable).toBe(true);
  });
});

describe("isNoResults", () => {
  it("detects exact NO_RESULTS", () => {
    expect(isNoResults("NO_RESULTS")).toBe(true);
    expect(isNoResults("  NO_RESULTS\n")).toBe(true);
    expect(isNoResults("NO_RESULTS extra")).toBe(false);
  });
});

describe("formatFailure", () => {
  it("includes code, retryable flag, step, and request id", () => {
    const cat = classifyToolText("TOOL_ERROR brave_search: BRAVE_API_KEY not set", "artemis_brave_search");
    const text = formatFailure("artemis_brave_search", cat, "openclaw-abc");
    expect(text).toContain("[MISSING_CREDENTIAL]");
    expect(text).not.toContain("retryable"); // not retryable -> no marker
    expect(text).toContain("Next step:");
    expect(text).toContain("[request openclaw-abc]");
  });

  it("marks retryable failures", () => {
    const cat = classifyToolText("TOOL_ERROR brave_search: 429 rate limited", "artemis_brave_search");
    const text = formatFailure("artemis_brave_search", cat, undefined);
    expect(text).toContain("(retryable)");
  });
});