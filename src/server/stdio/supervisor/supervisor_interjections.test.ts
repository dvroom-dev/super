import { describe, expect, it } from "bun:test";
import { buildSupervisorInjectedMessage } from "./supervisor_interjections.js";

describe("buildSupervisorInjectedMessage (supervisor interjections)", () => {
  it("uses cadence template in soft mode with xml tags", () => {
    const message = buildSupervisorInjectedMessage({
      supervisorMode: "soft",
      reviewTrigger: "agent_yield",
      review: {
        decision: "append_message_and_continue",
        payload: { message: "continue", message_template: "supervisor_command" },
        reasoning: null,
        agent_model: null,
      },
      guidanceText: "CADENCE_NUDGE_CONTINUE",
      messageTemplateName: "supervisor_command",
      reasons: ["cadence_time"],
      stopDetails: ["Cadence reached"],
      supervisorTriggers: {
        cadence: {
          messageTemplates: [
            {
              name: "supervisor_command",
              description: "Wrap in XML",
              messageType: "user",
              text: "<supervisor-command trigger=\"cadence\">{{message}}</supervisor-command>",
            },
          ],
        },
      },
    });
    expect(message?.trigger).toBe("cadence");
    expect(message?.messageType).toBe("user");
    expect(message?.text).toContain("<supervisor-command trigger=\"cadence\">");
    expect(message?.text).toContain("CADENCE_NUDGE_CONTINUE");
  });

  it("falls back to user message when no template is configured", () => {
    const message = buildSupervisorInjectedMessage({
      supervisorMode: "hard",
      reviewTrigger: "agent_yield",
      review: {
        decision: "append_message_and_continue",
        payload: { message: "continue", message_template: "custom" },
        reasoning: null,
        agent_model: null,
      },
      guidanceText: "PLAIN_GUIDANCE",
      reasons: ["agent_stop"],
      stopDetails: ["Agent stopped"],
      supervisorTriggers: undefined,
    });
    expect(message?.trigger).toBe("agent_yield");
    expect(message?.messageType).toBe("user");
    expect(message?.text).toBe("PLAIN_GUIDANCE");
  });

  it("renders static template text when selected template has no message placeholder", () => {
    const message = buildSupervisorInjectedMessage({
      supervisorMode: "soft",
      reviewTrigger: "agent_yield",
      review: {
        decision: "append_message_and_continue",
        payload: { message: "", message_template: "static_template" },
        reasoning: null,
        agent_model: null,
      },
      guidanceText: "",
      messageTemplateName: "static_template",
      reasons: ["cadence_time"],
      stopDetails: ["Cadence reached"],
      supervisorTriggers: {
        cadence: {
          messageTemplates: [
            {
              name: "static_template",
              description: "fixed text",
              messageType: "system",
              text: "<supervisor-command trigger=\"cadence\">RETURN_CONTROL</supervisor-command>",
            },
          ],
        },
      },
    });
    expect(message?.messageType).toBe("system");
    expect(message?.text).toBe("<supervisor-command trigger=\"cadence\">RETURN_CONTROL</supervisor-command>");
  });

  it("uses switch-mode-request templates for switch trigger in hard mode", () => {
    const message = buildSupervisorInjectedMessage({
      supervisorMode: "hard",
      reviewTrigger: "agent_switch_mode_request",
      review: {
        decision: "append_message_and_continue",
        payload: { message: "stay in mode", message_template: "replace_switch_mode_with_guidance" },
        reasoning: null,
        agent_model: null,
      },
      guidanceText: "stay in mode",
      messageTemplateName: "replace_switch_mode_with_guidance",
      reasons: ["agent_switch_mode_request"],
      stopDetails: [],
      supervisorTriggers: {
        agent_switch_mode_request: {
          messageTemplates: [
            {
              name: "replace_switch_mode_with_guidance",
              description: "Replace with guidance",
              messageType: "user",
              text: "SUPERVISOR: {{message}}",
            },
          ],
        },
      },
    });
    expect(message?.trigger).toBe("agent_switch_mode_request");
    expect(message?.messageType).toBe("user");
    expect(message?.text).toBe("SUPERVISOR: stay in mode");
  });

  it("uses tool-intercept templates for interception trigger in hard mode", () => {
    const message = buildSupervisorInjectedMessage({
      supervisorMode: "hard",
      reviewTrigger: "agent_tool_intercept",
      review: {
        decision: "append_message_and_continue",
        payload: { message: "halt tool", message_template: "replace_tool_call_with_guidance" },
        reasoning: null,
        agent_model: null,
      },
      guidanceText: "halt tool",
      messageTemplateName: "replace_tool_call_with_guidance",
      reasons: ["tool_intercept"],
      stopDetails: [],
      supervisorTriggers: {
        agent_tool_intercept: {
          messageTemplates: [
            {
              name: "replace_tool_call_with_guidance",
              description: "Replace with guidance",
              messageType: "user",
              text: "<supervisor-command>{{message}}</supervisor-command>",
            },
          ],
        },
      },
    });
    expect(message?.trigger).toBe("agent_tool_intercept");
    expect(message?.messageType).toBe("user");
    expect(message?.text).toContain("halt tool");
  });
});
