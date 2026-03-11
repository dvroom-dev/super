import type { AgentRuleCheck, SupervisorReviewResult } from "../../../supervisor/review_schema.js";
import { failedRuleNames, ruleCheckPayload } from "./review_utils.js";

export function decisionPayloadSummary(review: SupervisorReviewResult): string {
  if (review.decision === "stop_and_return") return review.payload.reason || "(missing reason)";
  if (review.decision === "append_message_and_continue") {
    const payload = review.payload;
    const messageSummary = payload.message == null ? "(missing message)" : payload.message === "" ? "(empty message)" : payload.message;
    return `template=${payload.message_template || "custom"}; message=${messageSummary}`;
  }
  if (review.decision === "retry") return review.payload.reason || "(missing reason)";
  if (review.decision === "continue") return "(none)";
  if (review.decision === "fork_new_conversation") {
    const mode = review.payload.mode || "(missing mode)";
    const payload = review.payload.mode_payload?.[mode] ?? review.payload.mode_payload ?? {};
    const fields = Object.keys(payload ?? {});
    return `mode=${mode}; mode_payload_fields=${fields.length ? fields.join(", ") : "(none)"}`;
  }
  if (review.decision === "resume_mode_head") {
    const mode = review.payload.mode || "(missing mode)";
    const messageSummary = review.payload.message
      ? review.payload.message
      : "(empty message)";
    return `mode=${mode}; message_type=${review.payload.message_type}; message=${messageSummary}`;
  }
  const block = ruleCheckPayload(review);
  if (!block) return "(missing rule-check payload)";
  const failed = failedRuleNames(block.agent_rule_checks ?? []);
  const failedViolations = failedRuleNames(block.agent_violation_checks ?? []);
  return `advice=${block.advice || "(none)"}; failed_rules=${failed.join("; ") || "(none)"}; failed_violations=${failedViolations.join("; ") || "(none)"}`;
}

export type ReviewDecisionState = {
  effectiveAction: "continue" | "fork" | "stop";
  resume: boolean;
  nextMode?: string;
  nextUserMessage?: string;
  nextMessageTemplateName?: string;
  nextModePayload?: Record<string, string>;
  shouldRewriteWithCheck: boolean;
  checkRuleChecks: AgentRuleCheck[];
  reviewReasons: string[];
};

export function applyViolationForkPolicy(args: {
  review: SupervisorReviewResult;
  currentMode: string;
  allowedNextModes: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  state: ReviewDecisionState;
}): ReviewDecisionState {
  const violationChecks = ruleCheckPayload(args.review)?.agent_violation_checks ?? [];
  const failedViolationRules = failedRuleNames(violationChecks);
  if (!failedViolationRules.length) return args.state;

  const next: ReviewDecisionState = { ...args.state, reviewReasons: [...args.state.reviewReasons] };
  const targetMode =
    String(args.currentMode ?? "").trim() ||
    args.allowedNextModes.find((mode) => String(mode ?? "").trim()) ||
    "";
  if (!targetMode) {
    next.effectiveAction = "stop";
    next.resume = false;
    next.nextMode = undefined;
    next.nextUserMessage = undefined;
    next.nextMessageTemplateName = undefined;
    next.nextModePayload = undefined;
    next.shouldRewriteWithCheck = false;
    next.checkRuleChecks = [];
    if (!next.reviewReasons.includes("rule_violation")) next.reviewReasons.push("rule_violation");
    return next;
  }

  const guidance = [
    "<supervisor-advice source=\"rule-violation\">",
    "Violation-triggered fork: the prior session violated protected rules.",
    ...failedViolationRules.map((rule) => `- ${rule}`),
    "Continue in this new conversation while explicitly avoiding the violated behaviors.",
    "</supervisor-advice>",
  ].join("\n");
  const requiredFields = args.modePayloadFieldsByMode?.[targetMode] ?? [];
  const payload: Record<string, string> = {};
  for (const field of requiredFields) payload[field] = guidance;
  if (requiredFields.includes("user_message")) payload.user_message = guidance;
  next.effectiveAction = "fork";
  next.resume = true;
  next.nextMode = targetMode;
  next.nextModePayload = payload;
  next.nextUserMessage = guidance;
  next.nextMessageTemplateName = undefined;
  next.shouldRewriteWithCheck = false;
  next.checkRuleChecks = [];
  if (!next.reviewReasons.includes("rule_violation")) next.reviewReasons.push("rule_violation");
  return next;
}
