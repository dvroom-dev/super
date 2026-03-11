import { describe, expect, it } from "bun:test";
import {
  adjustedTokenUsage,
  combineTranscript,
  describeStopReasons,
  detectStopReasons,
  normalizeRules,
  parseJsonSafe,
} from "./helpers.js";

describe("stdio helpers", () => {
  it("normalizes list-like rule strings", () => {
    const rules = normalizeRules("- one\n* two\n  + three\n\nfour");
    expect(rules).toEqual(["one", "two", "three", "four"]);
  });

  it("combines transcript with trimmed appended markdown", () => {
    const out = combineTranscript("```chat role=user\nhi\n```", ["\n```chat role=assistant\nok\n```\n"]);
    expect(out).toContain("```chat role=user");
    expect(out).toContain("```chat role=assistant");
  });

  it("detects stop reasons from budget, error, and return control pattern", () => {
    const reasons = detectStopReasons({
      assistantText: "please RETURN CONTROL now",
      usage: {},
      startedAt: Date.now() - 2000,
      supervisor: { timeBudgetMs: 1, returnControlPattern: "return\\s+control" },
      hadError: true,
      timeBudgetHit: false,
      tokenBudgetHit: false,
    });
    expect(reasons).toContain("time_budget");
    expect(reasons).toContain("error");
    expect(reasons).toContain("return_control");
  });

  it("describes known stop reasons with readable messages", () => {
    const details = describeStopReasons({
      reasons: ["time_budget", "cadence_tokens", "agent_stop"],
      usage: {},
      startedAt: Date.now(),
      supervisor: { timeBudgetMs: 120000, cadenceTokensAdjusted: 5000 },
      hadError: false,
    });
    expect(details.some((line) => line.includes("Time budget reached"))).toBe(true);
    expect(details).toContain("Cadence reached: 5000 adjusted tokens");
    expect(details).toContain("Agent stopped");
  });

  it("parses JSON safely", () => {
    expect(parseJsonSafe("{\"a\":1}")).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonSafe("{")).toEqual({ ok: false, value: undefined });
  });

  it("computes adjusted token usage with model pricing multiplier", () => {
    const out = adjustedTokenUsage({
      outputTokens: 200,
      model: "expensive",
      pricing: { outputUsdPerMillion: { expensive: 20, cheap: 10 } },
    });
    expect(out.multiplier).toBe(2);
    expect(out.adjustedTokens).toBe(400);
    expect(out.cheapestModel).toBe("cheap");
  });
});
