import {
  renderSupervisorReview,
  renderSupervisorAction,
  renderSupervisorWarning,
  renderToolCall,
  renderToolResult,
} from "../../../markdown/render.js";
import type { PromptMessageOverride } from "../../../supervisor/compile.js";
import type {
  AgentRuleCheck,
  SupervisorMessageType,
  SupervisorReviewResult,
  SupervisorTriggerKind,
} from "../../../supervisor/review_schema.js";
import type { RenderedRunConfigSupervisorTriggers } from "../../../supervisor/run_config.js";
import type { ProviderPermissionProfile } from "../../../providers/types.js";
import { combineTranscript } from "../helpers.js";
import type { SupervisorConfig } from "../types.js";
import type { RuntimeContext } from "../requests/context.js";
import type { TurnResult } from "./agent_turn.js";
import { replaceLastAssistantChat, replaceReasoningWithSnapshots } from "./fork_utils.js";
import { formatSupervisorCheckOutput, runSupervisorReview } from "./supervisor_run.js";
import { failedRuleNames } from "./review_utils.js";
import { messageTemplateSpecsForReview } from "./supervisor_interjections.js";
import { applyViolationForkPolicy, decisionPayloadSummary } from "./supervise_review_helpers.js";
import { hardNoResume, reviewFromOverride } from "./supervise_review_override.js";

export type SuperviseReviewStepArgs = {
  ctx: RuntimeContext;
  workspaceRoot: string;
  conversationId: string;
  documentText: string;
  currentDocText: string;
  agentRules?: string[];
  agentRuleViolations?: string[];
  supervisorInstructions?: string[];
  result: TurnResult;
  reasons: string[];
  supervisorMode: "hard" | "soft";
  providerName: string;
  supervisorProviderOptions?: Record<string, unknown>;
  permissionProfile?: ProviderPermissionProfile;
  supervisor: SupervisorConfig;
  supervisorModel: string;
  currentModel: string;
  agentModelReasoningEffort?: string;
  supervisorModelReasoningEffort?: string;
  agentsText?: string;
  workspaceListingText: string;
  taggedFiles: any[];
  openFiles: any[];
  utilities: any[];
  skills: any[];
  skillsToInvoke: any[];
  skillInstructions: any[];
  configuredSystemMessage?: PromptMessageOverride;
  supervisorTriggers?: RenderedRunConfigSupervisorTriggers;
  stopCondition: string;
  currentMode: string;
  allowedNextModes: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  modeGuidanceByMode?: Record<string, { description?: string; startWhen?: string[]; stopWhen?: string[] }>;
  supervisorCarryover?: string;
  supervisorWorkspaceRoot?: string;
  currentSupervisorThreadId?: string;
  triggerOverride?: SupervisorTriggerKind;
};

export type SuperviseReviewStepResult = {
  nextDocText: string;
  review: SupervisorReviewResult;
  reviewReasons: string[];
  effectiveAction: "continue" | "fork" | "stop";
  forkDisposition?: "fresh_mode" | "resume_mode_head";
  resume: boolean;
  nextMode?: string;
  nextUserMessage?: string;
  nextResumeMessageType?: SupervisorMessageType;
  nextMessageTemplateName?: string;
  nextModePayload?: Record<string, string>;
  nextModel: string;
  nextSupervisorThreadId?: string;
  historyRewritten: boolean;
  trigger: SupervisorTriggerKind;
};

function triggerForTurn(result: TurnResult): SupervisorTriggerKind {
  if (result.compactionDetected) return "agent_compaction";
  return result.hadError ? "agent_error" : "agent_yield";
}

export async function runSuperviseReviewStep(
  args: SuperviseReviewStepArgs,
): Promise<SuperviseReviewStepResult> {
  const {
    ctx,
    workspaceRoot,
    conversationId,
    documentText,
    currentDocText,
    agentRules,
    agentRuleViolations,
    supervisorInstructions,
    result,
    reasons,
    supervisorMode,
    providerName,
    supervisorProviderOptions,
    permissionProfile,
    supervisor,
    supervisorModel,
    currentModel,
    agentModelReasoningEffort,
    supervisorModelReasoningEffort,
    agentsText,
    workspaceListingText,
    taggedFiles,
    openFiles,
    utilities,
    skills,
    skillsToInvoke,
    skillInstructions,
    configuredSystemMessage,
    supervisorTriggers,
    stopCondition,
    currentMode,
    allowedNextModes,
    modePayloadFieldsByMode,
    modeGuidanceByMode,
    supervisorCarryover,
    supervisorWorkspaceRoot,
    currentSupervisorThreadId,
  } = args;

  const reviewTrigger = args.triggerOverride ?? triggerForTurn(result);
  const effectiveAgentRules = agentRules ?? [];
  const appendMessageTemplates = messageTemplateSpecsForReview({
    supervisorMode,
    reviewTrigger,
    supervisorTriggers,
  });

  let nextDocText = currentDocText;
  let reviewReasons = [...reasons];
  let review: SupervisorReviewResult;
  let reviewText = "";
  let promptLogRel = "";
  let responseLogRel = "";
  let nextSupervisorThreadId = currentSupervisorThreadId;

  if (supervisor.reviewOverrideJson) {
    reviewText = String(supervisor.reviewOverrideJson);
    promptLogRel = "(override)";
    responseLogRel = "(override)";
    review = reviewFromOverride({
      reviewOverrideJson: reviewText,
      trigger: reviewTrigger,
      mode: supervisorMode,
      agentRules: effectiveAgentRules,
      agentRuleViolations,
      appendMessageTemplates,
      allowedNextModes,
      modePayloadFieldsByMode,
    });
  } else {
    const outcome = await runSupervisorReview({
      workspaceRoot,
      conversationId,
      documentText: currentDocText || documentText,
      agentRules: effectiveAgentRules,
      agentRuleViolations,
      supervisorInstructions,
      assistantText: result.assistantText,
      trigger: reviewTrigger,
      stopReasons: reasons,
      mode: supervisorMode,
      providerName,
      providerOptions: supervisorProviderOptions,
      permissionProfile,
      model: supervisorModel,
      agentModel: currentModel,
      supervisorModel,
      agentModelReasoningEffort,
      supervisorModelReasoningEffort,
      agentsText,
      workspaceListingText,
      taggedFiles,
      openFiles,
      utilities,
      skills,
      skillsToInvoke,
      skillInstructions,
      configuredSystemMessage,
      supervisorTriggers,
      stopCondition,
      currentMode,
      allowedNextModes,
      modePayloadFieldsByMode,
      modeGuidanceByMode,
      supervisorCarryover,
      supervisorWorkspaceRoot,
      threadId: currentSupervisorThreadId,
      timeoutMs: supervisor.reviewTimeoutMs,
      disableSyntheticCheckSupervisorOnRuleFailure:
        supervisor.disableSyntheticCheckSupervisorOnRuleFailure,
    });
    review = outcome.review;
    reviewText = outcome.raw;
    promptLogRel = outcome.promptLogRel;
    responseLogRel = outcome.responseLogRel;
    nextSupervisorThreadId = outcome.threadId ?? nextSupervisorThreadId;
    if (outcome.error) {
      if (!reviewReasons.includes("supervisor_error")) {
        reviewReasons.push("supervisor_error");
      }
      ctx.sendNotification({
        method: "log",
        params: {
          level: "error",
          message: `Supervisor review failed: ${outcome.error.message} (trace: ${outcome.traceLogRel})`,
        },
      });
      const warningMd = renderSupervisorWarning(
        [
          `error: ${outcome.error.message}`,
          `trace_log: ${outcome.traceLogRel}`,
          `prompt_log: ${promptLogRel}`,
          `response_log: ${responseLogRel}`,
        ].join("\n"),
      );
      nextDocText = combineTranscript(nextDocText, [warningMd]);
    }
  }

  let effectiveAction: "continue" | "fork" | "stop" = "continue";
  let forkDisposition: "fresh_mode" | "resume_mode_head" | undefined = undefined;
  let resume = true;
  let nextMode: string | undefined = undefined;
  let nextUserMessage: string | undefined = undefined;
  let nextResumeMessageType: SupervisorMessageType | undefined = undefined;
  let nextMessageTemplateName: string | undefined = undefined;
  let nextModePayload: Record<string, string> | undefined = undefined;
  let shouldRewriteWithCheck = false;
  let checkRuleChecks: AgentRuleCheck[] = [];

  if (review.decision === "stop_and_return") {
    effectiveAction = "stop";
    resume = false;
  } else if (review.decision === "append_message_and_continue") {
    effectiveAction = "continue";
    resume = true;
    nextUserMessage = review.payload.message ?? "";
    nextMessageTemplateName = review.payload.message_template.trim() || undefined;
  } else if (review.decision === "retry") {
    effectiveAction = "continue";
    resume = true;
  } else if (review.decision === "continue") {
    effectiveAction = "continue";
    resume = true;
  } else if (review.decision === "fork_new_conversation") {
    effectiveAction = "fork";
    forkDisposition = "fresh_mode";
    resume = true;
    const fork = review.payload;
    const requestedMode = fork.mode.trim() || "";
    if (requestedMode && allowedNextModes.includes(requestedMode)) {
      nextMode = requestedMode;
      const selectedModePayload = fork.mode_payload?.[requestedMode];
      if (selectedModePayload && typeof selectedModePayload === "object") {
        nextModePayload = { ...selectedModePayload };
      }
    } else {
      effectiveAction = "continue";
      forkDisposition = undefined;
      nextMode = undefined;
    }
  } else if (review.decision === "resume_mode_head") {
    effectiveAction = "fork";
    forkDisposition = "resume_mode_head";
    resume = true;
    const targetMode = review.payload.mode.trim() || "";
    if (targetMode && allowedNextModes.includes(targetMode)) {
      nextMode = targetMode;
      nextModePayload = { ...(review.payload.mode_payload ?? {}) };
      nextUserMessage = review.payload.message ?? "";
      nextResumeMessageType = review.payload.message_type;
    } else {
      effectiveAction = "continue";
      forkDisposition = undefined;
      nextMode = undefined;
      nextUserMessage = undefined;
      nextResumeMessageType = undefined;
    }
  } else if (review.decision === "rewrite_with_check_supervisor_and_continue") {
    effectiveAction = "continue";
    resume = true;
    shouldRewriteWithCheck = true;
    checkRuleChecks = review.payload.agent_rule_checks ?? [];
  } else if (review.decision === "return_check_supervisor") {
    effectiveAction = "continue";
    resume = true;
  }

  ({
    effectiveAction,
    resume,
    nextMode,
    nextUserMessage,
    nextMessageTemplateName,
    nextModePayload,
    shouldRewriteWithCheck,
    checkRuleChecks,
    reviewReasons,
  } = applyViolationForkPolicy({
    review,
    currentMode,
    allowedNextModes,
    modePayloadFieldsByMode,
    state: {
      effectiveAction,
      resume,
      nextMode,
      nextUserMessage,
      nextMessageTemplateName,
      nextModePayload,
      shouldRewriteWithCheck,
      checkRuleChecks,
      reviewReasons,
    },
  }));

  if (effectiveAction === "fork") {
    forkDisposition = review.decision === "resume_mode_head"
      ? "resume_mode_head"
      : "fresh_mode";
  } else {
    forkDisposition = undefined;
  }

  const modeStopSatisfied = review.mode_assessment?.current_mode_stop_satisfied === true;
  const requiresRuntimeModeSwitch = reviewTrigger === "agent_yield"
    && result.streamEnded
    && modeStopSatisfied
    && allowedNextModes.length > 0;
  if (requiresRuntimeModeSwitch && effectiveAction === "continue") {
    if (!reviewReasons.includes("missing_runtime_switch_mode")) {
      reviewReasons.push("missing_runtime_switch_mode");
    }
    const warningMd = renderSupervisorWarning(
      [
        "mode transition blocked",
        `current_mode: ${currentMode}`,
        `allowed_next_modes: ${allowedNextModes.join(", ")}`,
        "reason: current mode stop condition was satisfied, but no runtime switch_mode tool call was observed.",
        "action: stopping run to avoid accepting prose/json switch payloads.",
      ].join("\n"),
    );
    nextDocText = combineTranscript(nextDocText, [warningMd]);
      effectiveAction = "stop";
      forkDisposition = undefined;
      resume = false;
      nextMode = undefined;
      nextUserMessage = undefined;
      nextResumeMessageType = undefined;
      nextMessageTemplateName = undefined;
      nextModePayload = undefined;
  }

  if (hardNoResume(reviewReasons)) {
    effectiveAction = "stop"; resume = false;
    forkDisposition = undefined;
    nextMode = undefined; nextUserMessage = undefined; nextResumeMessageType = undefined; nextMessageTemplateName = undefined; nextModePayload = undefined;
  }

  const trigger: SupervisorTriggerKind =
    !result.hadError && !result.interrupted && !resume
      ? "agent_yield"
      : reviewTrigger;

  let historyRewritten = false;
  if (shouldRewriteWithCheck && !supervisor.disableSyntheticCheckSupervisorOnRuleFailure) {
    const failedRules = failedRuleNames(checkRuleChecks);
    const toolCallBody = JSON.stringify(
      {
        source: "supervisor",
        trigger,
        mode: supervisorMode,
        reasons: reviewReasons,
        failed_rules: failedRules,
        agent_rule_checks: checkRuleChecks,
      },
      null,
      2,
    );
    const ruleOutput = formatSupervisorCheckOutput({
      review,
      promptLogRel,
      responseLogRel,
      source: "supervisor",
      trigger,
      mode: supervisorMode,
      reasons: reviewReasons,
    });
    const toolCallMd = renderToolCall("check_supervisor", toolCallBody);
    const toolResultMd = renderToolResult([`(ok=false)`, ruleOutput].join("\n"));
    const replacement = [toolCallMd, toolResultMd].join("\n\n");
    const replaced = replaceLastAssistantChat(nextDocText, replacement);
    if (replaced.text !== nextDocText) {
      nextDocText = replaced.text;
      historyRewritten = true;
    }
  }

  if (historyRewritten) {
    const snapshot = replaceReasoningWithSnapshots(nextDocText);
    nextDocText = snapshot.text;
  }

  const reviewMd = renderSupervisorReview(
    [
      `mode: ${supervisorMode}`,
      `trigger: ${trigger}`,
      `reasons: ${reviewReasons.join(", ") || "(none)"}`,
      `prompt_log: ${promptLogRel}`,
      `response_log: ${responseLogRel}`,
      `decision: ${review.decision}`,
      `action: ${effectiveAction}`,
      `resume: ${String(resume)}`,
      `next_mode: ${nextMode || "(none)"}`,
      `next_user_message: ${nextUserMessage || "(none)"}`,
      `next_message_type: ${nextResumeMessageType || "(none)"}`,
      `next_message_template: ${nextMessageTemplateName || "(none)"}`,
      `decision_payload_summary: ${decisionPayloadSummary(review)}`,
      "",
      reviewText.trim() || JSON.stringify(review, null, 2),
    ].join("\n"),
    { mode: supervisorMode },
  );

  const actionMd = renderSupervisorAction(
    [
      `mode: ${supervisorMode}`,
      `trigger: ${trigger}`,
      `decision: ${review.decision}`,
      `action: ${effectiveAction}`,
      `resume: ${String(resume)}`,
      `reasons: ${reviewReasons.join(", ") || "(none)"}`,
      `next_mode: ${nextMode || "(none)"}`,
      `next_user_message: ${nextUserMessage || "(none)"}`,
      `next_message_type: ${nextResumeMessageType || "(none)"}`,
      `next_message_template: ${nextMessageTemplateName || "(none)"}`,
      `decision_payload_summary: ${decisionPayloadSummary(review)}`,
      `agent_model: ${review.agent_model ?? currentModel}`,
      `supervisor_model: ${supervisorModel}`,
      `prompt_log: ${promptLogRel}`,
      `response_log: ${responseLogRel}`,
    ].join("\n"),
    { mode: supervisorMode, action: effectiveAction },
  );

  nextDocText = combineTranscript(nextDocText, [reviewMd, actionMd]);

  const nextModel = review.agent_model ? review.agent_model.trim() : "";
  return {
    nextDocText,
    review,
    reviewReasons,
    effectiveAction,
    forkDisposition,
    resume,
    nextMode,
    nextUserMessage,
    nextResumeMessageType,
    nextMessageTemplateName,
    nextModePayload,
    nextModel,
    nextSupervisorThreadId,
    historyRewritten,
    trigger,
  };
}
