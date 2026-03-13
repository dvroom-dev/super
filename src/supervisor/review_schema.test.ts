import { describe, expect, it } from "bun:test";
import {
  allowedDecisionsForTrigger,
  buildSupervisorResponseSchema,
} from "./review_schema.js";

describe("review_schema", () => {
  it("limits allowed decisions by trigger", () => {
    expect(allowedDecisionsForTrigger("run_start_bootstrap")).toEqual([
      "stop_and_return",
      "fork_new_conversation",
    ]);
    expect(allowedDecisionsForTrigger("agent_yield")).toEqual([
      "stop_and_return",
      "rewrite_with_check_supervisor_and_continue",
      "append_message_and_continue",
      "fork_new_conversation",
      "resume_mode_head",
    ]);
    expect(allowedDecisionsForTrigger("agent_compaction")).toEqual([
      "stop_and_return",
      "fork_new_conversation",
    ]);
    expect(allowedDecisionsForTrigger("agent_error")).toEqual([
      "stop_and_return",
      "append_message_and_continue",
      "fork_new_conversation",
      "resume_mode_head",
      "retry",
    ]);
    expect(allowedDecisionsForTrigger("agent_check_supervisor")).toEqual([
      "return_check_supervisor",
      "fork_new_conversation",
      "resume_mode_head",
      "stop_and_return",
    ]);
    expect(allowedDecisionsForTrigger("agent_tool_intercept")).toEqual([
      "append_message_and_continue",
      "fork_new_conversation",
      "resume_mode_head",
      "stop_and_return",
      "continue",
    ]);
    expect(allowedDecisionsForTrigger("agent_switch_mode_request")).toEqual([
      "append_message_and_continue",
      "fork_new_conversation",
      "resume_mode_head",
      "stop_and_return",
      "continue",
    ]);
  });

  it("uses provider-compatible flat payload schema while still allowing fork decisions", () => {
    const schema = buildSupervisorResponseSchema({
      trigger: "agent_yield",
      allowedNextModes: ["explore", "plan"],
      modePayloadFieldsByMode: {
        explore: [],
        plan: ["hypothesis", "next_probe"],
      },
    }) as any;
    expect(schema.required).toEqual([
      "decision",
      "payload",
      "mode_assessment",
      "transition_payload",
      "reasoning",
      "agent_model",
    ]);
    expect(schema.properties.payload.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties.decision.enum).toContain("fork_new_conversation");
    expect(schema.properties.payload.required).toEqual([
      "reason",
      "advice",
      "agent_rule_checks",
      "agent_violation_checks",
      "message",
      "message_template",
      "message_type",
      "wait_for_boundary",
      "mode",
      "mode_payload",
    ]);
    expect(schema.properties.payload.properties.mode_payload.type).toEqual(["object", "null"]);
    expect(schema.properties.payload.properties.mode_payload.additionalProperties.anyOf).toHaveLength(3);
    expect(schema.properties.transition_payload.type).toEqual(["object", "null"]);
    expect(schema.properties.transition_payload.additionalProperties.type).toBe("string");
  });

  it("keeps mode_assessment required at top-level but nullable when no next modes are available", () => {
    const schema = buildSupervisorResponseSchema({
      trigger: "agent_yield",
      allowedNextModes: [],
    }) as any;
    expect(schema.required).toContain("mode_assessment");
    expect(schema.properties.mode_assessment.type).toEqual(["object", "null"]);
    expect(schema.properties.payload.properties.mode_payload.type).toEqual(["object", "null"]);
    expect(schema.properties.mode_assessment.properties.recommended_action.enum).toEqual([
      "continue",
      "fork_new_conversation",
      "resume_mode_head",
    ]);
  });

  it("enables continue only for soft cadence-style reviews", () => {
    expect(allowedDecisionsForTrigger("agent_yield", "hard")).not.toContain("continue");
    expect(allowedDecisionsForTrigger("agent_yield", "soft")).toContain("continue");
    expect(allowedDecisionsForTrigger("agent_yield", "soft")).not.toContain(
      "rewrite_with_check_supervisor_and_continue",
    );
    expect(allowedDecisionsForTrigger("agent_error", "soft")).not.toContain("continue");
    expect(allowedDecisionsForTrigger("agent_check_supervisor", "soft")).not.toContain("continue");
  });

  it("keeps append_message_and_continue available when message templates are configured", () => {
    const schema = buildSupervisorResponseSchema({
      trigger: "agent_yield",
      allowedNextModes: ["explore"],
      appendMessageTemplates: [
        { name: "supervisor_command", acceptsMessage: true },
        { name: "plain_guidance", acceptsMessage: false },
        { name: "supervisor_command", acceptsMessage: true },
      ],
    }) as any;
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties.decision.enum).toContain("append_message_and_continue");
    expect(schema.properties.payload.type).toBe("object");
    expect(schema.properties.payload.properties.message_template.enum).toEqual([
      "custom",
      "plain_guidance",
      "supervisor_command",
      null,
    ]);
  });

  it("restricts bootstrap reviews to initial fork-or-stop decisions", () => {
    const schema = buildSupervisorResponseSchema({
      trigger: "run_start_bootstrap",
      allowedNextModes: ["explore_and_solve"],
      modePayloadFieldsByMode: { explore_and_solve: ["user_message"] },
    }) as any;
    expect(schema.properties.decision.enum).toEqual([
      "stop_and_return",
      "fork_new_conversation",
    ]);
    expect(schema.properties.payload.properties.mode.enum).toEqual(["explore_and_solve", null]);
  });
});
