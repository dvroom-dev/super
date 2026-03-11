import {
  type AppendMessageTemplateOption,
  allowedDecisionsForTrigger,
  CUSTOM_MESSAGE_TEMPLATE_NAME,
  type AgentRuleCheck,
  type DecisionPayloadByDecision,
  type ModeAssessment,
  type RuleCheckPayload,
  type SupervisorMessageType,
  type SupervisorDecisionKind,
  type SupervisorReviewResult,
  type SupervisorTriggerKind,
} from "../../../supervisor/review_schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

const SUPERVISOR_MESSAGE_TYPES: SupervisorMessageType[] = [
  "user",
  "assistant",
  "system",
  "developer",
  "supervisor",
];

function normalizeSupervisorMessageType(value: unknown): SupervisorMessageType {
  const normalized = normalizeString(value).toLowerCase();
  if (SUPERVISOR_MESSAGE_TYPES.includes(normalized as SupervisorMessageType)) {
    return normalized as SupervisorMessageType;
  }
  return "user";
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function fallbackDecision(trigger: SupervisorTriggerKind): SupervisorDecisionKind {
  if (trigger === "agent_check_supervisor") return "return_check_supervisor";
  return "stop_and_return";
}

function normalizeRuleStatus(value: unknown): AgentRuleCheck["status"] {
  const status = normalizeString(value).toLowerCase();
  if (status === "pass" || status === "fail" || status === "unknown") return status;
  return "unknown";
}

function defaultRuleChecks(agentRules: string[]): AgentRuleCheck[] {
  return agentRules.map((rule) => ({
    rule,
    status: "unknown",
    comment: "No assessment provided.",
  }));
}

function normalizeRuleChecks(raw: unknown, agentRules: string[]): AgentRuleCheck[] {
  const entries = Array.isArray(raw) ? raw : [];
  const out: AgentRuleCheck[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const rule = normalizeString(entry.rule);
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    out.push({
      rule,
      status: normalizeRuleStatus(entry.status),
      comment: normalizeString(entry.comment),
    });
  }
  for (const rule of agentRules) {
    if (seen.has(rule)) continue;
    out.push({
      rule,
      status: "unknown",
      comment: "Rule was not assessed in supervisor response.",
    });
  }
  return out;
}

function normalizeModePayload(raw: unknown): Record<string, Record<string, string> | null> {
  if (!isRecord(raw)) return {};
  const out: Record<string, Record<string, string> | null> = {};
  for (const [mode, value] of Object.entries(raw)) {
    const modeName = normalizeString(mode);
    if (!modeName) continue;
    if (value == null) {
      out[modeName] = null;
      continue;
    }
    if (!isRecord(value)) continue;
    const payload: Record<string, string> = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      const key = normalizeString(field);
      if (!key) continue;
      payload[key] = normalizeString(fieldValue);
    }
    out[modeName] = payload;
  }
  return out;
}

function normalizeMessageTemplateName(value: unknown): string {
  const normalized = normalizeString(value);
  return normalized || CUSTOM_MESSAGE_TEMPLATE_NAME;
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" | "unknown" {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low" || normalized === "unknown") {
    return normalized;
  }
  return "unknown";
}

function normalizeModeAssessment(raw: unknown): ModeAssessment | null {
  if (!isRecord(raw)) return null;
  const rankedRaw = Array.isArray(raw.candidate_modes_ranked) ? raw.candidate_modes_ranked : [];
  const candidateModesRanked: ModeAssessment["candidate_modes_ranked"] = [];
  const seen = new Set<string>();
  for (const entry of rankedRaw) {
    if (!isRecord(entry)) continue;
    const mode = normalizeString(entry.mode);
    if (!mode || seen.has(mode)) continue;
    seen.add(mode);
    candidateModesRanked.push({
      mode,
      confidence: normalizeConfidence(entry.confidence),
      evidence: normalizeString(entry.evidence),
    });
  }
  const recommendedActionRaw = normalizeString(raw.recommended_action);
  const recommendedAction = recommendedActionRaw === "fork_new_conversation"
    ? "fork_new_conversation"
    : recommendedActionRaw === "resume_mode_head"
      ? "resume_mode_head"
      : "continue";
  return {
    current_mode_stop_satisfied: Boolean(raw.current_mode_stop_satisfied),
    candidate_modes_ranked: candidateModesRanked,
    recommended_action: recommendedAction,
  };
}

function resolvePayloadRaw(rawRecord: Record<string, unknown>, decision: SupervisorDecisionKind): unknown {
  if (isRecord(rawRecord.payload)) return rawRecord.payload;
  const legacy = rawRecord[decision];
  if (isRecord(legacy)) return legacy;
  return {};
}

function normalizeDecisionPayload(args: {
  decision: SupervisorDecisionKind;
  payloadRaw: unknown;
  agentRules: string[];
  agentRuleViolations: string[];
}): DecisionPayloadByDecision[SupervisorDecisionKind] {
  const payload = isRecord(args.payloadRaw) ? args.payloadRaw : {};
  if (args.decision === "stop_and_return") {
    return {
      reason: normalizeString(payload.reason),
      wait_for_boundary: normalizeBoolean(payload.wait_for_boundary),
    };
  }
  if (args.decision === "append_message_and_continue") {
    return {
      message: normalizeString(payload.message),
      message_template: normalizeMessageTemplateName(payload.message_template),
    };
  }
  if (args.decision === "fork_new_conversation") {
    return {
      mode: normalizeString(payload.mode),
      mode_payload: normalizeModePayload(payload.mode_payload),
      wait_for_boundary: normalizeBoolean(payload.wait_for_boundary),
    };
  }
  if (args.decision === "resume_mode_head") {
    return {
      mode: normalizeString(payload.mode),
      message: normalizeString(payload.message),
      message_type: normalizeSupervisorMessageType(payload.message_type),
      wait_for_boundary: normalizeBoolean(payload.wait_for_boundary),
    };
  }
  if (args.decision === "retry") {
    return { reason: normalizeString(payload.reason) };
  }
  if (args.decision === "continue") {
    return {};
  }
  return {
    advice: normalizeString(payload.advice),
    agent_rule_checks: normalizeRuleChecks(payload.agent_rule_checks, args.agentRules),
    agent_violation_checks: normalizeRuleChecks(payload.agent_violation_checks, args.agentRuleViolations),
  };
}

export function normalizeReview(args: {
  raw: unknown;
  trigger: SupervisorTriggerKind;
  mode?: "hard" | "soft";
  agentRules: string[];
  agentRuleViolations?: string[];
}): SupervisorReviewResult {
  const rawRecord = isRecord(args.raw) ? args.raw : {};
  const allowed = allowedDecisionsForTrigger(args.trigger, args.mode);
  const decisionRaw = normalizeString(rawRecord.decision) as SupervisorDecisionKind;
  const decision = allowed.includes(decisionRaw) ? decisionRaw : fallbackDecision(args.trigger);
  const payloadRaw = resolvePayloadRaw(rawRecord, decision);
  const payload = normalizeDecisionPayload({
    decision,
    payloadRaw,
    agentRules: args.agentRules,
    agentRuleViolations: args.agentRuleViolations ?? [],
  });
  const base = {
    mode_assessment: normalizeModeAssessment(rawRecord.mode_assessment),
    reasoning: typeof rawRecord.reasoning === "string" ? rawRecord.reasoning : null,
    agent_model: normalizeString(rawRecord.agent_model) || null,
  };
  return {
    ...base,
    decision,
    payload,
  } as SupervisorReviewResult;
}

export function ruleCheckPayload(review: SupervisorReviewResult | null | undefined): RuleCheckPayload | undefined {
  if (!review) return undefined;
  if (review.decision === "rewrite_with_check_supervisor_and_continue") return review.payload;
  if (review.decision === "return_check_supervisor") return review.payload;
  return undefined;
}

export function failedRuleNames(checks: AgentRuleCheck[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const check of checks) {
    if (check.status !== "fail") continue;
    const rule = normalizeString(check.rule);
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    out.push(rule);
  }
  return out;
}

export function validateReviewSemantic(args: {
  review: SupervisorReviewResult;
  trigger: SupervisorTriggerKind;
  mode?: "hard" | "soft";
  agentRules: string[];
  agentRuleViolations?: string[];
  allowedNextModes: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  appendMessageTemplates?: AppendMessageTemplateOption[];
}): string | undefined {
  const allowed = allowedDecisionsForTrigger(args.trigger, args.mode);
  if (!allowed.includes(args.review.decision)) {
    return `decision '${args.review.decision}' is not allowed for trigger '${args.trigger}'`;
  }

  const modeSwitchingEnabled = args.allowedNextModes.length > 0;
  if (modeSwitchingEnabled && !args.review.mode_assessment) {
    return "mode_assessment is required when mode switching is enabled";
  }
  if (args.review.mode_assessment) {
    const rankedModes = args.review.mode_assessment.candidate_modes_ranked ?? [];
    const seenRankedModes = new Set<string>();
    for (const entry of rankedModes) {
      const mode = normalizeString(entry.mode);
      if (!mode) return "mode_assessment.candidate_modes_ranked contains empty mode";
      if (seenRankedModes.has(mode)) {
        return `mode_assessment.candidate_modes_ranked has duplicate mode '${mode}'`;
      }
      seenRankedModes.add(mode);
      if (args.allowedNextModes.length > 0 && !args.allowedNextModes.includes(mode)) {
        return `mode_assessment.candidate_modes_ranked mode '${mode}' is not allowed`;
      }
    }
    const assessmentAction = args.review.mode_assessment.recommended_action;
    if (args.review.decision === "fork_new_conversation" && assessmentAction !== "fork_new_conversation") {
      return "mode_assessment.recommended_action must be 'fork_new_conversation' when decision is fork_new_conversation";
    }
    if (args.review.decision === "resume_mode_head" && assessmentAction !== "resume_mode_head") {
      return "mode_assessment.recommended_action must be 'resume_mode_head' when decision is resume_mode_head";
    }
    if (
      args.review.decision !== "fork_new_conversation"
      && args.review.decision !== "resume_mode_head"
      && assessmentAction !== "continue"
    ) {
      return "mode_assessment.recommended_action must be 'continue' when decision is neither fork_new_conversation nor resume_mode_head";
    }
  }

  if (args.review.decision === "stop_and_return") {
    if (!normalizeString(args.review.payload.reason)) {
      return "stop_and_return.reason is required";
    }
    return undefined;
  }

  if (args.review.decision === "append_message_and_continue") {
    const message = normalizeString(args.review.payload.message);
    const messageTemplateName = normalizeMessageTemplateName(args.review.payload.message_template);
    const options = args.appendMessageTemplates ?? [];
    const optionByName = new Map(options.map((entry) => [entry.name, entry]));
    if (
      messageTemplateName !== CUSTOM_MESSAGE_TEMPLATE_NAME &&
      !optionByName.has(messageTemplateName)
    ) {
      return `append_message_and_continue.message_template '${messageTemplateName}' is not allowed`;
    }
    if (messageTemplateName === CUSTOM_MESSAGE_TEMPLATE_NAME && !message) {
      return "append_message_and_continue.message is required for message_template 'custom'";
    }
    const selected = optionByName.get(messageTemplateName);
    if (selected?.acceptsMessage && !message) {
      return `append_message_and_continue.message is required for message_template '${messageTemplateName}'`;
    }
    if (selected && !selected.acceptsMessage && message) {
      return `append_message_and_continue.message must be empty for message_template '${messageTemplateName}'`;
    }
    return undefined;
  }

  if (args.review.decision === "continue") {
    if (Object.keys(args.review.payload).length > 0) {
      return "continue payload must be empty";
    }
    return undefined;
  }

  if (args.review.decision === "retry") {
    if (!normalizeString(args.review.payload.reason)) {
      return "retry.reason is required";
    }
    return undefined;
  }

  if (
    args.review.decision === "rewrite_with_check_supervisor_and_continue" ||
    args.review.decision === "return_check_supervisor"
  ) {
    const block = args.review.payload;
    if (!normalizeString(block.advice)) {
      return `${args.review.decision}.advice is required`;
    }
    const checks = block.agent_rule_checks ?? [];
    const seen = new Set<string>();
    for (const check of checks) {
      const rule = normalizeString(check.rule);
      if (!rule) return `${args.review.decision}.agent_rule_checks contains empty rule`;
      if (seen.has(rule)) return `${args.review.decision}.agent_rule_checks has duplicate rule '${rule}'`;
      seen.add(rule);
    }
    for (const requiredRule of args.agentRules) {
      if (!seen.has(requiredRule)) {
        return `${args.review.decision}.agent_rule_checks missing rule '${requiredRule}'`;
      }
    }
    const violationChecks = block.agent_violation_checks ?? [];
    const seenViolations = new Set<string>();
    for (const check of violationChecks) {
      const rule = normalizeString(check.rule);
      if (!rule) return `${args.review.decision}.agent_violation_checks contains empty rule`;
      if (seenViolations.has(rule)) {
        return `${args.review.decision}.agent_violation_checks has duplicate rule '${rule}'`;
      }
      seenViolations.add(rule);
    }
    for (const violationRule of args.agentRuleViolations ?? []) {
      if (!seenViolations.has(violationRule)) {
        return `${args.review.decision}.agent_violation_checks missing rule '${violationRule}'`;
      }
    }
    return undefined;
  }

  if (args.review.decision === "fork_new_conversation") {
    const fork = args.review.payload;
    if (!normalizeString(fork.mode)) return "fork_new_conversation.mode is required";
    if (!args.allowedNextModes.includes(fork.mode)) {
      return `fork_new_conversation.mode '${fork.mode}' is not allowed`;
    }
    const selectedPayload = fork.mode_payload[fork.mode];
    if (selectedPayload == null) return undefined;
    if (!isRecord(selectedPayload)) {
      return `fork_new_conversation.mode_payload.${fork.mode} must be an object`;
    }
    const requiredFields = args.modePayloadFieldsByMode?.[fork.mode] ?? [];
    for (const field of requiredFields) {
      const value = normalizeString(selectedPayload[field]);
      if (!value) {
        return `fork_new_conversation.mode_payload.${fork.mode}.${field} is required`;
      }
    }
    return undefined;
  }

  if (args.review.decision === "resume_mode_head") {
    const resume = args.review.payload;
    if (!normalizeString(resume.mode)) return "resume_mode_head.mode is required";
    if (!args.allowedNextModes.includes(resume.mode)) {
      return `resume_mode_head.mode '${resume.mode}' is not allowed`;
    }
    if (!SUPERVISOR_MESSAGE_TYPES.includes(resume.message_type)) {
      return "resume_mode_head.message_type must be one of user|assistant|system|developer|supervisor";
    }
    return undefined;
  }

  return undefined;
}

export function fallbackReview(args: {
  trigger: SupervisorTriggerKind;
  mode?: "hard" | "soft";
  agentRules: string[];
  agentRuleViolations?: string[];
  reason: string;
}): SupervisorReviewResult {
  if (args.trigger === "agent_check_supervisor") {
    return {
      decision: "return_check_supervisor",
      payload: {
        advice: args.reason,
        agent_rule_checks: defaultRuleChecks(args.agentRules),
        agent_violation_checks: defaultRuleChecks(args.agentRuleViolations ?? []),
      },
      mode_assessment: {
        current_mode_stop_satisfied: false,
        candidate_modes_ranked: [],
        recommended_action: "continue",
      },
      reasoning: null,
      agent_model: null,
    };
  }
  return {
    decision: "stop_and_return",
    payload: { reason: args.reason, wait_for_boundary: false },
    mode_assessment: {
      current_mode_stop_satisfied: true,
      candidate_modes_ranked: [],
      recommended_action: "continue",
    },
    reasoning: null,
    agent_model: null,
  };
}
