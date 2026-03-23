import { describe, expect, it } from "bun:test";
import type { SupervisorReviewResult } from "../../../supervisor/review_schema.js";
import { normalizeReview, validateReviewSemantic } from "./review_utils.js";

function appendReview(messageTemplate: string, message: string): SupervisorReviewResult {
  return {
    decision: "append_message_and_continue",
    payload: {
      message,
      message_template: messageTemplate,
    },
    mode_assessment: {
      current_mode_stop_satisfied: false,
      candidate_modes_ranked: [{ mode: "default", confidence: "medium", evidence: "default evidence" }],
      recommended_action: "continue",
    },
    reasoning: null,
    agent_model: null,
  };
}

function continueReview(messageTemplate: string, message: string): SupervisorReviewResult {
  return {
    decision: "continue",
    payload: {
      message,
      message_template: messageTemplate,
      message_type: "supervisor",
    },
    mode_assessment: {
      current_mode_stop_satisfied: false,
      candidate_modes_ranked: [{ mode: "default", confidence: "medium", evidence: "default evidence" }],
      recommended_action: "continue",
    },
    reasoning: null,
    agent_model: null,
  };
}

describe("review_utils append message template semantics", () => {
  it("requires mode_assessment when mode switching is enabled", () => {
    const review = appendReview("custom", "ok");
    delete (review as any).mode_assessment;
    const error = validateReviewSemantic({
      review,
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
      appendMessageTemplates: [{ name: "templated", acceptsMessage: true }],
    });
    expect(error).toContain("mode_assessment is required");
  });

  it("allows missing mode_assessment when mode switching is disabled", () => {
    const review = appendReview("custom", "ok");
    delete (review as any).mode_assessment;
    const error = validateReviewSemantic({
      review,
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: [],
      appendMessageTemplates: [{ name: "templated", acceptsMessage: true }],
    });
    expect(error).toBeUndefined();
  });

  it("requires mode_assessment action to match fork decisions", () => {
    const error = validateReviewSemantic({
      review: {
        decision: "fork_new_conversation",
        payload: {
          mode: "default",
          wait_for_boundary: false,
          mode_payload: {
            default: {},
          },
        },
        mode_assessment: {
          current_mode_stop_satisfied: true,
          candidate_modes_ranked: [{ mode: "default", confidence: "high", evidence: "move modes" }],
          recommended_action: "continue",
        },
        reasoning: null,
        agent_model: null,
      },
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
      modePayloadFieldsByMode: { default: [] },
    });
    expect(error).toContain("recommended_action must be 'fork_new_conversation'");
  });

  it("requires message for custom template", () => {
    const error = validateReviewSemantic({
      review: appendReview("custom", ""),
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
      appendMessageTemplates: [{ name: "static_template", acceptsMessage: false }],
    });
    expect(error).toContain("required for message_template 'custom'");
  });

  it("requires message for templates that accept customization", () => {
    const error = validateReviewSemantic({
      review: appendReview("templated", ""),
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
      appendMessageTemplates: [{ name: "templated", acceptsMessage: true }],
    });
    expect(error).toContain("required for message_template 'templated'");
  });

  it("allows empty message for templates with no customizable fields", () => {
    const error = validateReviewSemantic({
      review: appendReview("static_template", ""),
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
      appendMessageTemplates: [{ name: "static_template", acceptsMessage: false }],
    });
    expect(error).toBeUndefined();
  });

  it("rejects non-empty message for templates with no customizable fields", () => {
    const error = validateReviewSemantic({
      review: appendReview("static_template", "unexpected"),
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
      appendMessageTemplates: [{ name: "static_template", acceptsMessage: false }],
    });
    expect(error).toContain("must be empty for message_template 'static_template'");
  });

  it("allows continue to carry templated in-place guidance", () => {
    const error = validateReviewSemantic({
      review: continueReview("templated", "new bounded probe"),
      trigger: "agent_process_result_report",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
      appendMessageTemplates: [{ name: "templated", acceptsMessage: true }],
    });
    expect(error).toBeUndefined();
  });

  it("allows fork decisions with empty mode payload", () => {
    const error = validateReviewSemantic({
      review: {
        decision: "fork_new_conversation",
        payload: {
          mode: "default",
          wait_for_boundary: false,
          mode_payload: {},
        },
        mode_assessment: {
          current_mode_stop_satisfied: true,
          candidate_modes_ranked: [{ mode: "default", confidence: "high", evidence: "switch mode" }],
          recommended_action: "fork_new_conversation",
        },
        reasoning: null,
        agent_model: null,
      },
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
      modePayloadFieldsByMode: { default: ["hypothesis"] },
    });
    expect(error).toBeUndefined();
  });

  it("requires mode_assessment action to match resume decisions", () => {
    const error = validateReviewSemantic({
      review: {
        decision: "resume_mode_head",
        payload: {
          mode: "default",
          message: "",
          message_type: "user",
          wait_for_boundary: false,
        },
        mode_assessment: {
          current_mode_stop_satisfied: true,
          candidate_modes_ranked: [{ mode: "default", confidence: "high", evidence: "resume mode head" }],
          recommended_action: "continue",
        },
        reasoning: null,
        agent_model: null,
      },
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
    });
    expect(error).toContain("recommended_action must be 'resume_mode_head'");
  });

  it("defaults resume_mode_head.message_type to user when omitted", () => {
    const normalized = normalizeReview({
      raw: {
        decision: "resume_mode_head",
        transition_payload: { release_ticket: "alpha", empty_value: "" },
        payload: {
          mode: "default",
          message: "resume now",
          wait_for_boundary: false,
        },
      },
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
    });
    expect(normalized.decision).toBe("resume_mode_head");
    if (normalized.decision !== "resume_mode_head") return;
    expect(normalized.payload.message_type).toBe("user");
    expect(normalized.transition_payload).toEqual({ release_ticket: "alpha" });
  });

  it("requires resume_mode_head mode_payload fields when the target mode declares them", () => {
    const error = validateReviewSemantic({
      review: {
        decision: "resume_mode_head",
        payload: {
          mode: "default",
          mode_payload: {},
          message: "resume now",
          message_type: "user",
          wait_for_boundary: false,
        },
        mode_assessment: {
          current_mode_stop_satisfied: true,
          candidate_modes_ranked: [{ mode: "default", confidence: "high", evidence: "resume mode head" }],
          recommended_action: "resume_mode_head",
        },
        reasoning: null,
        agent_model: null,
      },
      trigger: "agent_yield",
      mode: "hard",
      agentRules: [],
      allowedNextModes: ["default"],
      modePayloadFieldsByMode: { default: ["phase_ticket"] },
    });
    expect(error).toContain("resume_mode_head.mode_payload.phase_ticket is required");
  });
});
