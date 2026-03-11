import { describe, expect, it } from "bun:test";
import { buildSupervisorAction, summarizeFork } from "./supervisor_actions.js";

describe("supervisor_actions", () => {
  it("builds supervisor action payload with review-derived fields", () => {
    const action = buildSupervisorAction({
      action: "continue",
      mode: "hard",
      review: {
        decision: "rewrite_with_check_supervisor_and_continue",
        payload: {
          advice: "focus on smallest probe",
          agent_rule_checks: [
            { rule: "must write act.py", status: "fail", comment: "missing" },
            { rule: "missing output schema", status: "unknown", comment: "not checked" },
          ],
          agent_violation_checks: [],
        },
        reasoning: "explain",
        agent_model: "claude-opus-4-6",
      },
      stopReasons: ["agent_stop"],
      stopDetails: ["Agent stopped"],
      budget: { adjustedTokensUsed: 10, multiplier: 1 },
      agentModel: "claude-opus-4-6",
      supervisorModel: "gpt-5.3-codex",
    });
    expect(action.action).toBe("continue");
    expect(action.mode).toBe("hard");
    expect(action.passed).toBe(false);
    expect(action.violations).toEqual(["must write act.py"]);
    expect(action.unfinishedRules).toEqual(["missing output schema"]);
    expect(action.critique).toBe("focus on smallest probe");
    expect(action.skillNudge).toBeUndefined();
    expect(action.summary).toContain("continue");
  });

  it("summarizes forks using violation/unfinished/budget/action fallbacks", () => {
    expect(
      summarizeFork({
        review: {
          decision: "rewrite_with_check_supervisor_and_continue",
          payload: {
            advice: "",
            agent_rule_checks: [
              { rule: "rule one\nrule two", status: "fail", comment: "broken" },
            ],
            agent_violation_checks: [],
          },
          reasoning: "",
          agent_model: "claude-opus-4-6",
        },
      }),
    ).toBe("Rule fix: rule one");
    expect(summarizeFork({ stopReasons: ["cadence_tokens"] })).toBe("Checkpoint: cadence tokens");
    expect(summarizeFork({ action: "append" })).toBe("Supervisor: append");
    expect(summarizeFork({})).toBe("Supervisor update");
  });
});
