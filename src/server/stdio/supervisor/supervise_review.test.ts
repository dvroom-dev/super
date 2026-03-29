import { describe, expect, it } from "bun:test";
import type { RuntimeContext } from "../requests/context.js";
import { runSuperviseReviewStep } from "./supervise_review.js";
import type { TurnResult } from "./agent_turn.js";

function makeContext(): RuntimeContext {
  return {
    store: {} as any,
    state: {},
    sendNotification: () => {},
    requireWorkspaceRoot: () => "/tmp",
  };
}

function makeTurnResult(assistantText: string): TurnResult {
  return {
    appended: [],
    assistantText,
    errorMessage: null,
    assistantFinal: true,
    hadError: false,
    interrupted: false,
    interruptionReason: null,
    abortedBySupervisor: false,
    abortError: false,
    streamEnded: true,
    usage: undefined,
    cadenceHit: false,
    cadenceReason: null,
    compactionDetected: false,
    compactionDetails: null,
  };
}

function makeDocument(): string {
  return [
    "---",
    "conversation_id: conv_test",
    "fork_id: fork_test",
    "mode: explore",
    "---",
    "",
    "```chat role=user",
    "turn 1",
    "```",
    "",
    "```chat role=assistant",
    "agent answer",
    "```",
    "",
  ].join("\n");
}

function baseArgs() {
  const ctx = makeContext();
  const documentText = makeDocument();
  return {
    ctx,
    workspaceRoot: "/tmp",
    conversationId: "conv_test",
    documentText,
    currentDocText: documentText,
    agentRules: ["write act.py or request reset"],
    supervisorInstructions: ["keep progress moving"],
    result: makeTurnResult("agent answer"),
    reasons: ["agent_stop"],
    supervisorMode: "hard" as const,
    providerName: "mock",
    supervisor: {
      appendSupervisorJudgements: false,
    },
    supervisorModel: "gpt-5.3-codex",
    currentModel: "gpt-5.3-codex",
    workspaceListingText: "",
    taggedFiles: [],
    openFiles: [],
    utilities: [],
    skills: [],
    skillsToInvoke: [],
    skillInstructions: [],
    stopCondition: "level complete",
    currentMode: "explore",
    allowedNextModes: ["explore", "plan"],
    supervisorCarryover: "",
  };
}

describe("runSuperviseReviewStep", () => {
  it("replaces last assistant with synthetic check_supervisor on hard violations", async () => {
    const args = baseArgs();
    const reviewOverrideJson = JSON.stringify({
      decision: "rewrite_with_check_supervisor_and_continue",
      rewrite_with_check_supervisor_and_continue: {
        advice: "Write act.py now.",
        agent_rule_checks: [
          {
            rule: "write act.py or request reset",
            status: "fail",
            comment: "act.py missing",
          },
        ],
      },
      mode_assessment: {
        current_mode_stop_satisfied: false,
        candidate_modes_ranked: [{ mode: "explore", confidence: "medium", evidence: "Need corrective action first." }],
        recommended_action: "continue",
      },
    });
    const result = await runSuperviseReviewStep({
      ...args,
      supervisor: {
        reviewOverrideJson,
        appendSupervisorJudgements: false,
      },
    });

    expect(result.effectiveAction).toBe("continue");
    expect(result.resume).toBe(true);
    expect(result.trigger).toBe("agent_yield");
    expect(result.nextUserMessage).toBeUndefined();
    expect(result.nextDocText).toContain("```tool_call name=check_supervisor");
    expect(result.nextDocText).toContain("(ok=false)");
    expect(result.nextDocText).not.toContain("```chat role=assistant\nagent answer");
  });

  it("supports cadence continue decisions without injecting a message", async () => {
    const args = baseArgs();
    const reviewOverrideJson = JSON.stringify({
      decision: "continue",
      continue: {},
      transition_payload: {
        release_ticket: "alpha",
      },
      mode_assessment: {
        current_mode_stop_satisfied: false,
        candidate_modes_ranked: [{ mode: "explore", confidence: "medium", evidence: "Cadence checkpoint only." }],
        recommended_action: "continue",
      },
    });
    const result = await runSuperviseReviewStep({
      ...args,
      supervisorMode: "soft",
      reasons: ["cadence_time"],
      supervisor: {
        reviewOverrideJson,
        appendSupervisorJudgements: false,
      },
    });

    expect(result.review.decision).toBe("continue");
    expect(result.nextTransitionPayload).toEqual({ release_ticket: "alpha" });
    expect(result.nextUserMessage).toBeUndefined();
    expect(result.nextDocText).not.toContain("```tool_call name=check_supervisor");
    expect(result.nextDocText).toContain("decision: continue");
  });

  it("uses the agent_compaction trigger when provider compaction was detected", async () => {
    const args = baseArgs();
    const reviewOverrideJson = JSON.stringify({
      decision: "fork_new_conversation",
      fork_new_conversation: {
        mode: "plan",
        mode_payload: {
          explore: null,
          plan: { hypothesis: "compact carryover" },
        },
        wait_for_boundary: false,
      },
      mode_assessment: {
        current_mode_stop_satisfied: false,
        candidate_modes_ranked: [{ mode: "plan", confidence: "high", evidence: "Need fresh prompt after compaction." }],
        recommended_action: "fork_new_conversation",
      },
    });
    const result = await runSuperviseReviewStep({
      ...args,
      result: {
        ...makeTurnResult("agent answer"),
        interrupted: true,
        interruptionReason: "provider_compaction",
        compactionDetected: true,
        compactionDetails: "provider compact boundary detected",
      },
      reasons: ["interrupted"],
      supervisor: {
        reviewOverrideJson,
        appendSupervisorJudgements: false,
      },
    });

    expect(result.trigger).toBe("agent_compaction");
    expect(result.review.decision).toBe("fork_new_conversation");
  });

  it("returns fork decision with next mode and payload", async () => {
    const args = baseArgs();
    const reviewOverrideJson = JSON.stringify({
      decision: "fork_new_conversation",
      fork_new_conversation: {
        mode: "plan",
        mode_payload: {
          explore: null,
          plan: { hypothesis: "cross toggles polarity" },
        },
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "plan", confidence: "high", evidence: "Evidence supports planning mode." }],
        recommended_action: "fork_new_conversation",
      },
    });
    const result = await runSuperviseReviewStep({
      ...args,
      supervisor: {
        reviewOverrideJson,
        appendSupervisorJudgements: false,
      },
    });

    expect(result.effectiveAction).toBe("fork");
    expect(result.resume).toBe(true);
    expect(result.nextMode).toBe("plan");
    expect(result.nextUserMessage).toBeUndefined();
    expect(result.nextModePayload).toEqual({ hypothesis: "cross toggles polarity" });
  });

  it("stops when supervisor decides stop_and_return", async () => {
    const args = baseArgs();
    const reviewOverrideJson = JSON.stringify({
      decision: "stop_and_return",
      stop_and_return: { reason: "All acceptance checks pass." },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "plan", confidence: "low", evidence: "No follow-up needed." }],
        recommended_action: "continue",
      },
    });
    const result = await runSuperviseReviewStep({
      ...args,
      supervisor: {
        reviewOverrideJson,
        appendSupervisorJudgements: false,
      },
    });

    expect(result.effectiveAction).toBe("stop");
    expect(result.resume).toBe(false);
    expect(result.trigger).toBe("agent_yield");
  });

  it("hard-fails when mode stop is satisfied without a runtime switch_mode call", async () => {
    const args = baseArgs();
    const reviewOverrideJson = JSON.stringify({
      decision: "append_message_and_continue",
      append_message_and_continue: {
        reason: "mode complete",
        message: "Switch accepted based on payload text.",
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "plan", confidence: "high", evidence: "Mode contract complete." }],
        recommended_action: "continue",
      },
    });
    const result = await runSuperviseReviewStep({
      ...args,
      supervisor: {
        reviewOverrideJson,
        appendSupervisorJudgements: false,
      },
    });

    expect(result.effectiveAction).toBe("stop");
    expect(result.resume).toBe(false);
    expect(result.reviewReasons).toContain("missing_runtime_switch_mode");
    expect(result.nextDocText).toContain("mode transition blocked");
  });

  it("keeps running when supervisor issues a same-mode follow-up handoff after a stop boundary", async () => {
    const args = baseArgs();
    const reviewOverrideJson = JSON.stringify({
      decision: "append_message_and_continue",
      append_message_and_continue: {
        reason: "bounded probe complete",
        message: "Current probe is closed. Stay in the same mode and test exactly one new bounded target.",
        mode: "analyze",
        message_template: "custom",
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "analyze", confidence: "high", evidence: "Stay in the same mode with a new bounded handoff." }],
        recommended_action: "continue",
      },
    });
    const result = await runSuperviseReviewStep({
      ...args,
      currentMode: "analyze",
      allowedNextModes: ["analyze", "plan"],
      supervisor: {
        reviewOverrideJson,
        appendSupervisorJudgements: false,
      },
    });

    expect(result.effectiveAction).toBe("continue");
    expect(result.resume).toBe(true);
    expect(result.reviewReasons).not.toContain("missing_runtime_switch_mode");
  });

  it("forces fork on matched violation checks even when no next modes are listed", async () => {
    const args = baseArgs();
    const reviewOverrideJson = JSON.stringify({
      decision: "rewrite_with_check_supervisor_and_continue",
      rewrite_with_check_supervisor_and_continue: {
        advice: "Do not solve in this mode.",
        agent_rule_checks: [
          {
            rule: "write act.py or request reset",
            status: "pass",
            comment: "Requirement satisfied",
          },
        ],
        agent_violation_checks: [
          {
            rule: "Attempting to solve the real game with actions.",
            status: "fail",
            comment: "Agent attempted real-game solving.",
          },
        ],
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "explore", confidence: "high", evidence: "Violation requires immediate fork." }],
        recommended_action: "continue",
      },
    });
    const result = await runSuperviseReviewStep({
      ...args,
      allowedNextModes: [],
      agentRuleViolations: ["Attempting to solve the real game with actions."],
      supervisor: {
        reviewOverrideJson,
        appendSupervisorJudgements: false,
      },
    });

    expect(result.effectiveAction).toBe("fork");
    expect(result.resume).toBe(true);
    expect(result.nextMode).toBe("explore");
    expect(result.reviewReasons).toContain("rule_violation");
    expect(result.nextUserMessage).toContain("<supervisor-advice");
    expect(result.nextUserMessage).toContain("Attempting to solve the real game with actions.");
  });
});
