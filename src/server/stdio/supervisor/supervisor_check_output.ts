import type {
  ModeAssessment,
  SupervisorReviewResult,
  SupervisorTriggerKind,
} from "../../../supervisor/review_schema.js";
import { failedRuleNames, ruleCheckPayload } from "./review_utils.js";

export type SupervisorCheckPayload = {
  source?: string;
  trigger?: SupervisorTriggerKind;
  mode?: string;
  reasons?: string[];
  decision: string;
  decision_payload: unknown;
  advice?: string | null;
  agent_rule_checks?: { rule: string; status: string; comment: string }[];
  agent_violation_checks?: { rule: string; status: string; comment: string }[];
  failed_rules?: string[];
  violated_rules?: string[];
  mode_assessment?: ModeAssessment | null;
  reasoning?: string | null;
  prompt_log?: string;
  response_log?: string;
};

export function formatSupervisorCheckOutput(args: {
  review: SupervisorReviewResult;
  promptLogRel?: string;
  responseLogRel?: string;
  source?: string;
  trigger?: SupervisorTriggerKind;
  mode?: string;
  reasons?: string[];
}): string {
  const ruleCheck = ruleCheckPayload(args.review);
  const advice = ruleCheck?.advice ?? null;
  const checks = ruleCheck?.agent_rule_checks ?? [];
  const violationChecks = ruleCheck?.agent_violation_checks ?? [];
  const payload: SupervisorCheckPayload = {
    source: args.source,
    trigger: args.trigger,
    mode: args.mode,
    reasons: args.reasons,
    decision: args.review.decision,
    decision_payload: args.review.payload,
    advice,
    agent_rule_checks: checks,
    agent_violation_checks: violationChecks,
    failed_rules: failedRuleNames(checks),
    violated_rules: failedRuleNames(violationChecks),
    mode_assessment: args.review.mode_assessment ?? null,
    reasoning: args.review.reasoning ?? null,
    prompt_log: args.promptLogRel,
    response_log: args.responseLogRel,
  };
  return JSON.stringify(payload, null, 2);
}
