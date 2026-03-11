import type { SupervisorReviewResult } from "../../../supervisor/review_schema.js";
import type { SupervisorAction, BudgetSnapshot } from "../../../store/types.js";
import { failedRuleNames, ruleCheckPayload } from "./review_utils.js";

export function buildSupervisorAction(args: {
  action: string;
  mode?: "hard" | "soft";
  review?: SupervisorReviewResult | null;
  stopReasons: string[];
  stopDetails: string[];
  budget: BudgetSnapshot;
  agentModel?: string;
  supervisorModel?: string;
}): SupervisorAction {
  const ruleCheck = ruleCheckPayload(args.review);
  const checks = ruleCheck?.agent_rule_checks ?? [];
  const violationChecks = ruleCheck?.agent_violation_checks ?? [];
  const failedRequirementRules = failedRuleNames(checks);
  const failedViolationRules = failedRuleNames(violationChecks);
  const failed = [...failedViolationRules, ...failedRequirementRules];
  const unknownRules = checks
    .filter((check) => check.status === "unknown")
    .map((check) => check.rule);
  const unknownViolations = violationChecks
    .filter((check) => check.status === "unknown")
    .map((check) => check.rule);
  const advice = ruleCheck?.advice ?? undefined;
  return {
    action: args.action,
    mode: args.mode,
    stopReasons: args.stopReasons,
    stopDetails: args.stopDetails,
    passed: args.review ? failed.length === 0 : undefined,
    violations: failed.length ? failed : undefined,
    unfinishedRules: [...unknownViolations, ...unknownRules].length
      ? [...unknownViolations, ...unknownRules]
      : undefined,
    reasoning: args.review?.reasoning || undefined,
    critique: advice,
    skillNudge: undefined,
    agentModel: args.agentModel,
    supervisorModel: args.supervisorModel,
    budget: args.budget,
    createdAt: new Date().toISOString(),
    summary: `${args.action}${args.mode ? ` (${args.mode})` : ""}`,
  };
}

export function summarizeFork(args: {
  review?: SupervisorReviewResult | null;
  action?: string;
  stopReasons?: string[];
}): string {
  const review = args.review;
  const reasons = args.stopReasons ?? [];
  const first = (text: string) => text.split(/\r?\n/)[0].trim();
  const ruleCheck = ruleCheckPayload(review);
  const checks = ruleCheck?.agent_rule_checks ?? [];
  const violationChecks = ruleCheck?.agent_violation_checks ?? [];
  const failed = [...failedRuleNames(violationChecks), ...failedRuleNames(checks)];
  if (failed.length) return `Rule fix: ${first(failed[0])}`.slice(0, 120);
  const advice = ruleCheck?.advice;
  if (advice?.trim()) return `Advice: ${first(advice)}`.slice(0, 120);
  if (reasons.includes("time_budget")) return "Stopped: time budget";
  if (reasons.includes("token_budget")) return "Stopped: token budget";
  if (reasons.includes("cadence_time")) return "Checkpoint: cadence time";
  if (reasons.includes("cadence_tokens")) return "Checkpoint: cadence tokens";
  if (reasons.includes("error")) return "Stopped: error";
  if (reasons.includes("agent_stop")) return "Agent stopped";
  if (args.action) return `Supervisor: ${args.action}`.slice(0, 120);
  if (review?.reasoning) return first(review.reasoning).slice(0, 120);
  return "Supervisor update";
}
