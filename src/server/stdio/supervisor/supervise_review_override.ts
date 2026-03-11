import type { SupervisorReviewResult, SupervisorTriggerKind } from "../../../supervisor/review_schema.js";
import { fallbackReview, normalizeReview, validateReviewSemantic } from "./review_utils.js";

export function hardNoResume(reasons: string[]): boolean {
  const noResumeReasons = new Set([
    "time_budget",
    "token_budget",
    "error",
    "supervisor_error",
    "interrupted",
    "return_control",
  ]);
  return reasons.some((reason) => noResumeReasons.has(reason));
}

export function reviewFromOverride(args: {
  reviewOverrideJson: string;
  trigger: SupervisorTriggerKind;
  mode: "hard" | "soft";
  agentRules: string[];
  agentRuleViolations?: string[];
  appendMessageTemplates?: { name: string; acceptsMessage: boolean }[];
  allowedNextModes: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
}): SupervisorReviewResult {
  const fallback = fallbackReview({
    trigger: args.trigger,
    mode: args.mode,
    agentRules: args.agentRules,
    reason: "Invalid supervisor override JSON.",
  });
  try {
    const parsed = JSON.parse(args.reviewOverrideJson);
    const normalized = normalizeReview({
      raw: parsed,
      trigger: args.trigger,
      mode: args.mode,
      agentRules: args.agentRules,
      agentRuleViolations: args.agentRuleViolations,
    });
    const semanticError = validateReviewSemantic({
      review: normalized,
      trigger: args.trigger,
      mode: args.mode,
      agentRules: args.agentRules,
      agentRuleViolations: args.agentRuleViolations,
      allowedNextModes: args.allowedNextModes,
      modePayloadFieldsByMode: args.modePayloadFieldsByMode,
      appendMessageTemplates: args.appendMessageTemplates,
    });
    if (semanticError) {
      return fallbackReview({
        trigger: args.trigger,
        mode: args.mode,
        agentRules: args.agentRules,
        reason: `Supervisor override failed semantic validation: ${semanticError}`,
      });
    }
    return normalized;
  } catch {
    return fallback;
  }
}
