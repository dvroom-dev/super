export type SupervisorTriggerKind =
  | "agent_yield"
  | "agent_compaction"
  | "agent_error"
  | "agent_check_supervisor"
  | "agent_tool_intercept"
  | "agent_switch_mode_request";

export type SupervisorDecisionKind =
  | "stop_and_return"
  | "rewrite_with_check_supervisor_and_continue"
  | "append_message_and_continue"
  | "fork_new_conversation"
  | "resume_mode_head"
  | "retry"
  | "return_check_supervisor"
  | "continue";

export const CUSTOM_MESSAGE_TEMPLATE_NAME = "custom";

export type SupervisorMessageType = "user" | "assistant" | "system" | "developer" | "supervisor";

export type AppendMessageTemplateOption = {
  name: string;
  acceptsMessage: boolean;
};

export type AgentRuleCheck = {
  rule: string;
  status: "pass" | "fail" | "unknown";
  comment: string;
};

export type ModeAssessmentCandidate = {
  mode: string;
  confidence: "high" | "medium" | "low" | "unknown";
  evidence: string;
};

export type ModeAssessment = {
  current_mode_stop_satisfied: boolean;
  candidate_modes_ranked: ModeAssessmentCandidate[];
  recommended_action: "continue" | "fork_new_conversation" | "resume_mode_head";
};

export type StopAndReturnPayload = {
  reason: string;
  wait_for_boundary: boolean;
};
export type RuleCheckPayload = {
  advice: string;
  agent_rule_checks: AgentRuleCheck[];
  agent_violation_checks: AgentRuleCheck[];
};
export type AppendMessagePayload = {
  message: string;
  message_template: string;
};
export type ForkNewConversationPayload = {
  mode: string;
  mode_payload: Record<string, Record<string, string> | null>;
  wait_for_boundary: boolean;
};
export type ResumeModeHeadPayload = {
  mode: string;
  message: string;
  message_type: SupervisorMessageType;
  wait_for_boundary: boolean;
};
export type RetryPayload = { reason: string };
export type ContinuePayload = Record<string, never>;

export type DecisionPayloadByDecision = {
  stop_and_return: StopAndReturnPayload;
  rewrite_with_check_supervisor_and_continue: RuleCheckPayload;
  append_message_and_continue: AppendMessagePayload;
  fork_new_conversation: ForkNewConversationPayload;
  resume_mode_head: ResumeModeHeadPayload;
  retry: RetryPayload;
  return_check_supervisor: RuleCheckPayload;
  continue: ContinuePayload;
};

export type SupervisorReviewResultBase = {
  mode_assessment?: ModeAssessment | null;
  reasoning?: string | null;
  agent_model?: string | null;
};

export type SupervisorReviewResultByDecision<K extends SupervisorDecisionKind> = SupervisorReviewResultBase & {
  decision: K;
  payload: DecisionPayloadByDecision[K];
};

export type SupervisorReviewResult = {
  [K in SupervisorDecisionKind]: SupervisorReviewResultByDecision<K>;
}[SupervisorDecisionKind];

export const ALL_SUPERVISOR_DECISIONS: SupervisorDecisionKind[] = [
  "stop_and_return",
  "rewrite_with_check_supervisor_and_continue",
  "append_message_and_continue",
  "fork_new_conversation",
  "resume_mode_head",
  "retry",
  "return_check_supervisor",
  "continue",
];

const TRIGGER_DECISIONS: Record<SupervisorTriggerKind, SupervisorDecisionKind[]> = {
  agent_yield: [
    "stop_and_return",
    "rewrite_with_check_supervisor_and_continue",
    "append_message_and_continue",
    "fork_new_conversation",
    "resume_mode_head",
  ],
  agent_compaction: [
    "stop_and_return",
    "fork_new_conversation",
  ],
  agent_error: [
    "stop_and_return",
    "append_message_and_continue",
    "fork_new_conversation",
    "resume_mode_head",
    "retry",
  ],
  agent_check_supervisor: [
    "return_check_supervisor",
    "fork_new_conversation",
    "resume_mode_head",
    "stop_and_return",
  ],
  agent_tool_intercept: [
    "append_message_and_continue",
    "fork_new_conversation",
    "resume_mode_head",
    "stop_and_return",
    "continue",
  ],
  agent_switch_mode_request: [
    "append_message_and_continue",
    "fork_new_conversation",
    "resume_mode_head",
    "stop_and_return",
    "continue",
  ],
};

const AGENT_RULE_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rule", "status", "comment"],
  properties: {
    rule: { type: "string" },
    status: { type: "string", enum: ["pass", "fail", "unknown"] },
    comment: { type: "string" },
  },
} as const;

function sortedUnique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function objectSchema(args: {
  required: string[];
  properties: Record<string, unknown>;
}) {
  return {
    type: "object",
    additionalProperties: false,
    required: args.required,
    properties: args.properties,
  } as const;
}

function modePayloadEntrySchema(fields: string[]) {
  const required = sortedUnique(fields);
  const properties: Record<string, unknown> = {};
  for (const field of required) {
    properties[field] = { type: "string" };
  }
  return {
    type: ["object", "null"],
    additionalProperties: false,
    required,
    properties,
  } as const;
}

function modePayloadSchema(args: {
  allowedNextModes: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
}) {
  const modes = sortedUnique(args.allowedNextModes);
  const modeKeys = modes.length ? modes : ["default"];
  const properties: Record<string, unknown> = {};
  for (const mode of modeKeys) {
    const fields = args.modePayloadFieldsByMode?.[mode] ?? [];
    properties[mode] = modePayloadEntrySchema(fields);
  }
  return {
    type: ["object", "null"],
    additionalProperties: false,
    required: modeKeys,
    properties,
  } as const;
}

function payloadSupersetSchema(args: {
  allowedNextModes: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  appendMessageTemplates?: AppendMessageTemplateOption[];
}) {
  const modeKeys = sortedUnique(args.allowedNextModes).length
    ? sortedUnique(args.allowedNextModes)
    : ["default"];
  const messageTemplateNames = sortedUnique([
    CUSTOM_MESSAGE_TEMPLATE_NAME,
    ...(args.appendMessageTemplates ?? []).map((entry) => entry.name),
  ]);
  const properties = {
    reason: { type: ["string", "null"] },
    advice: { type: ["string", "null"] },
    agent_rule_checks: { type: ["array", "null"], items: AGENT_RULE_CHECK_SCHEMA },
    agent_violation_checks: { type: ["array", "null"], items: AGENT_RULE_CHECK_SCHEMA },
    message: { type: ["string", "null"] },
    message_template: {
      type: ["string", "null"],
      enum: [...messageTemplateNames, null],
    },
    message_type: {
      type: ["string", "null"],
      enum: ["user", "assistant", "system", "developer", "supervisor", null],
    },
    wait_for_boundary: { type: ["boolean", "null"] },
    mode: {
      type: ["string", "null"],
      enum: [...modeKeys, null],
    },
    mode_payload: modePayloadSchema({
      allowedNextModes: modeKeys,
      modePayloadFieldsByMode: args.modePayloadFieldsByMode,
    }),
  } as const;
  return objectSchema({
    required: Object.keys(properties),
    properties,
  });
}

function modeAssessmentSchema(allowedNextModes: string[]) {
  const modes = sortedUnique(allowedNextModes);
  const modeProperty = modes.length
    ? { type: "string", enum: modes }
    : { type: "string" };
  return objectSchema({
    required: ["current_mode_stop_satisfied", "candidate_modes_ranked", "recommended_action"],
    properties: {
      current_mode_stop_satisfied: { type: "boolean" },
      candidate_modes_ranked: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "confidence", "evidence"],
          properties: {
            mode: modeProperty,
            confidence: { type: "string", enum: ["high", "medium", "low", "unknown"] },
            evidence: { type: "string" },
          },
        },
      },
      recommended_action: {
        type: "string",
        enum: ["continue", "fork_new_conversation", "resume_mode_head"],
      },
    },
  });
}

export function decisionFieldName(_decision: SupervisorDecisionKind): "payload" {
  return "payload";
}

export function allowedDecisionsForTrigger(
  trigger: SupervisorTriggerKind,
  mode?: "hard" | "soft",
): SupervisorDecisionKind[] {
  const out = [...TRIGGER_DECISIONS[trigger]];
  if (mode !== "soft") return out;
  const filtered = out.filter((decision) => decision !== "rewrite_with_check_supervisor_and_continue");
  if (trigger === "agent_yield" && !filtered.includes("continue")) filtered.push("continue");
  return filtered;
}

export function buildSupervisorResponseSchema(args: {
  trigger: SupervisorTriggerKind;
  mode?: "hard" | "soft";
  allowedNextModes: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  appendMessageTemplates?: AppendMessageTemplateOption[];
  agentViolationRules?: string[];
}) {
  const decisions = allowedDecisionsForTrigger(args.trigger, args.mode).filter(
    (decision) =>
      (
        decision !== "fork_new_conversation"
        && decision !== "resume_mode_head"
      ) || args.allowedNextModes.length > 0,
  );
  const modeAssessmentObject = modeAssessmentSchema(args.allowedNextModes);
  const properties = {
    decision: { type: "string", enum: decisions },
    // Avoid unsupported keywords (e.g. oneOf) in provider response_format schemas.
    // Decision/payload compatibility is enforced by local semantic validation.
    payload: payloadSupersetSchema({
      allowedNextModes: args.allowedNextModes,
      modePayloadFieldsByMode: args.modePayloadFieldsByMode,
      appendMessageTemplates: args.appendMessageTemplates,
    }),
    mode_assessment: {
      type: ["object", "null"],
      additionalProperties: false,
      required: (modeAssessmentObject as { required: string[] }).required,
      properties: (modeAssessmentObject as { properties: Record<string, unknown> }).properties,
    },
    reasoning: { type: ["string", "null"] },
    agent_model: { type: ["string", "null"] },
  } as const;
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  } as const;
}
