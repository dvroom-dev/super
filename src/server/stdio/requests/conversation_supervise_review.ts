import type { ProviderPermissionProfile } from "../../../providers/types.js";
import type { SupervisorReviewResult } from "../../../supervisor/review_schema.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import { newId } from "../../../utils/ids.js";
import { updateFrontmatterForkId } from "../supervisor/fork_utils.js";
import { applyConfiguredHooks } from "../supervisor/hook_runtime.js";
import {
  appendChatMessage,
  applySupervisorTemplateFields,
  buildFreshModeDocument,
  frontmatterValue,
  mergeAgentRuleSet,
  modeTransitionAllowed,
  resolveModeConfig,
  updateFrontmatterField,
  updateFrontmatterModePayload,
} from "../supervisor/mode_runtime.js";
import { runSuperviseReviewStep, type SuperviseReviewStepResult } from "../supervisor/supervise_review.js";
import { emitSupervisorRunEnd } from "../supervisor/supervise_notifications.js";
import { buildSupervisorAction, summarizeFork } from "../supervisor/supervisor_actions.js";
import { buildSupervisorInjectedMessage } from "../supervisor/supervisor_interjections.js";
import { appendSupervisorMemoryEntry, loadSupervisorCarryover } from "../supervisor/supervisor_memory.js";
import { ruleCheckPayload } from "../supervisor/review_utils.js";
import type { BudgetState } from "../supervisor/agent_turn.js";
import type { RuntimeContext } from "./context.js";
import { refreshRenderedRunConfigForModeFork } from "./conversation_supervise_run_config_refresh.js";
import { buildSessionSystemPromptForMode } from "../supervisor/session_system_prompt.js";
import { shouldForceFreshForkAcrossLevelBoundary } from "./conversation_supervise_level_boundary.js";
type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;
type RunSupervisorReviewAndPersistArgs = {
  ctx: RuntimeContext;
  workspaceRoot: string;
  conversationId: string;
  docPath: string;
  documentText: string;
  currentDocText: string;
  activeForkId: string;
  currentThreadId?: string;
  currentSupervisorThreadId?: string;
  switchActiveFork: (nextForkId: string) => void;
  renderedRunConfig: RenderedRunConfig;
  runConfigPath?: string;
  configBaseDir: string;
  agentBaseDir: string;
  supervisorBaseDir: string;
  supervisorTriggers?: NonNullable<RenderedRunConfig>["supervisorTriggers"];
  activeMode: string;
  activeModePayload: Record<string, string>;
  allowedNextModes: string[];
  modePayloadFieldsByMode: Record<string, string[]>;
  modeGuidanceByMode: Record<string, { description?: string; startWhen?: string[]; stopWhen?: string[] }>;
  supervisorWorkspaceRoot: string;
  requestAgentRuleRequirements: string[];
  agentRules: string[];
  agentRuleViolations: string[];
  supervisorInstructions: string[];
  result: any;
  reasons: string[];
  stopDetails: string[];
  supervisorMode: "soft" | "hard";
  supervisorProviderName: "mock" | "codex" | "claude";
  supervisorProviderOptions?: Record<string, unknown>;
  supervisor: any;
  supervisorModel: string;
  currentModel: string;
  agentModelReasoningEffort?: string;
  supervisorModelReasoningEffort?: string;
  agentsText?: string;
  workspaceListingText: string;
  taggedFiles: any[];
  openFiles: any[];
  utilities: any;
  skills: any[];
  skillsToInvoke: any[];
  skillInstructions: any[];
  configuredSystemMessage?: any;
  permissionProfile: ProviderPermissionProfile;
  stopCondition: string;
  hooks: any[];
  startedAt: number;
  budget: BudgetState;
  timeBudgetMs: number;
  tokenBudgetAdjusted: number;
  cadenceTimeMs: number;
  cadenceTokensAdjusted: number;
  providerName: "mock" | "codex" | "claude";
  fullResyncNeeded: boolean;
  turn: number;
  precomputedReviewStep?: SuperviseReviewStepResult;
};
type RunSupervisorReviewAndPersistResult = {
  nextDocText: string;
  nextForkId: string;
  nextThreadId?: string;
  nextSupervisorThreadId?: string;
  nextModel?: string;
  review: SupervisorReviewResult;
  reviewReasons: string[];
  effectiveAction: "replace" | "fork" | "continue" | "stop";
  resume: boolean;
  historyRewritten: boolean;
  supervisorHookChanged: boolean;
  reviewAdvice?: string;
  reviewFailedRulesCount: number;
  fullResyncNeeded: boolean;
};
async function loadLatestForkInMode(args: {
  ctx: RuntimeContext;
  workspaceRoot: string;
  conversationId: string;
  mode: string;
}) {
  const idx = await args.ctx.store.loadIndex(args.workspaceRoot, args.conversationId);
  for (let i = idx.forks.length - 1; i >= 0; i -= 1) {
    const forkSummary = idx.forks[i];
    const fork = await args.ctx.store.loadFork(args.workspaceRoot, args.conversationId, forkSummary.id);
    const forkMode = frontmatterValue(fork.documentText ?? "", "mode")?.trim() || "";
    if (forkMode === args.mode) return fork;
  }
  return undefined;
}

export async function runSupervisorReviewAndPersist(args: RunSupervisorReviewAndPersistArgs): Promise<RunSupervisorReviewAndPersistResult> {
  const reviewStep = await (async () => {
    if (args.precomputedReviewStep) {
      return runSuperviseReviewStep({
        ctx: args.ctx,
        workspaceRoot: args.workspaceRoot,
        conversationId: args.conversationId,
        documentText: args.documentText,
        currentDocText: args.currentDocText,
        agentRules: args.agentRules,
        agentRuleViolations: args.agentRuleViolations,
        supervisorInstructions: args.supervisorInstructions,
        result: args.result,
        reasons: args.precomputedReviewStep.reviewReasons,
        supervisorMode: args.supervisorMode,
        providerName: args.supervisorProviderName,
        supervisorProviderOptions: args.supervisorProviderOptions,
        supervisor: {
          ...args.supervisor,
          reviewOverrideJson: JSON.stringify(args.precomputedReviewStep.review),
        },
        supervisorModel: args.supervisorModel,
        currentModel: args.currentModel,
        agentModelReasoningEffort: args.agentModelReasoningEffort,
        supervisorModelReasoningEffort: args.supervisorModelReasoningEffort,
        agentsText: args.agentsText,
        workspaceListingText: args.workspaceListingText,
        taggedFiles: args.taggedFiles,
        openFiles: args.openFiles,
        utilities: args.utilities,
        skills: args.skills,
        skillsToInvoke: args.skillsToInvoke,
        skillInstructions: args.skillInstructions,
        configuredSystemMessage: args.configuredSystemMessage,
        permissionProfile: args.permissionProfile,
        stopCondition: args.stopCondition,
        currentMode: args.activeMode,
        allowedNextModes: args.allowedNextModes,
        modePayloadFieldsByMode: args.modePayloadFieldsByMode,
        modeGuidanceByMode: args.modeGuidanceByMode,
        supervisorTriggers: args.supervisorTriggers,
        supervisorCarryover: "",
        supervisorWorkspaceRoot: args.supervisorWorkspaceRoot,
        currentSupervisorThreadId:
          args.precomputedReviewStep.nextSupervisorThreadId ?? args.currentSupervisorThreadId,
      });
    }

    const carryover = await loadSupervisorCarryover({
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      limitBytes: args.supervisor.contextCarryoverLimitBytes,
    });
    return runSuperviseReviewStep({
      ctx: args.ctx,
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      documentText: args.documentText,
      currentDocText: args.currentDocText,
      agentRules: args.agentRules,
      agentRuleViolations: args.agentRuleViolations,
      supervisorInstructions: args.supervisorInstructions,
      result: args.result,
      reasons: args.reasons,
      supervisorMode: args.supervisorMode,
      providerName: args.supervisorProviderName,
      supervisorProviderOptions: args.supervisorProviderOptions,
      supervisor: args.supervisor,
      supervisorModel: args.supervisorModel,
      currentModel: args.currentModel,
      agentModelReasoningEffort: args.agentModelReasoningEffort,
      supervisorModelReasoningEffort: args.supervisorModelReasoningEffort,
      agentsText: args.agentsText,
      workspaceListingText: args.workspaceListingText,
      taggedFiles: args.taggedFiles,
      openFiles: args.openFiles,
      utilities: args.utilities,
      skills: args.skills,
      skillsToInvoke: args.skillsToInvoke,
      skillInstructions: args.skillInstructions,
      configuredSystemMessage: args.configuredSystemMessage,
      permissionProfile: args.permissionProfile,
      stopCondition: args.stopCondition,
      currentMode: args.activeMode,
      allowedNextModes: args.allowedNextModes,
      modePayloadFieldsByMode: args.modePayloadFieldsByMode,
      modeGuidanceByMode: args.modeGuidanceByMode,
      supervisorTriggers: args.supervisorTriggers,
      supervisorCarryover: carryover.text,
      supervisorWorkspaceRoot: args.supervisorWorkspaceRoot,
      currentSupervisorThreadId: args.currentSupervisorThreadId,
    });
  })();

  let nextDocText = reviewStep.nextDocText;
  const review = reviewStep.review;
  const reviewReasons = reviewStep.reviewReasons;
  const supervisorHookApply = await applyConfiguredHooks({
    hooks: args.hooks,
    trigger: reviewReasons.includes("supervisor_error") ? "supervisor_error" : "supervisor_turn_complete",
    workspaceRoot: args.workspaceRoot,
    currentDocText: nextDocText,
    docPath: args.docPath,
    ctx: args.ctx,
    appendNotifications: false,
  });
  nextDocText = supervisorHookApply.nextDocText;

  const effectiveAction = reviewStep.effectiveAction;
  const resume = reviewStep.resume;
  const historyRewritten = reviewStep.historyRewritten;
  const reviewRuleCheck = ruleCheckPayload(review);
  const reviewAdvice = reviewRuleCheck?.advice ?? undefined;
  const reviewChecks = reviewRuleCheck?.agent_rule_checks ?? [];
  const reviewViolationChecks = reviewRuleCheck?.agent_violation_checks ?? [];
  const reviewFailedRules = [
    ...reviewChecks.filter((check) => check.status === "fail"),
    ...reviewViolationChecks.filter((check) => check.status === "fail"),
  ];
  const shouldInjectMessage = review.decision === "append_message_and_continue";
  const injectedMessage = shouldInjectMessage
    ? buildSupervisorInjectedMessage({
        supervisorMode: args.supervisorMode,
        reviewTrigger: reviewStep.trigger,
        review,
        guidanceText: reviewStep.nextUserMessage ?? "",
        messageTemplateName: reviewStep.nextMessageTemplateName,
        reasons: reviewReasons,
        stopDetails: args.stopDetails,
        supervisorTriggers: args.supervisorTriggers,
      })
    : undefined;

  emitSupervisorRunEnd(args.ctx, {
    turn: args.turn,
    mode: args.supervisorMode,
    action: effectiveAction,
    resume,
    reasons: reviewReasons,
    edits: 0,
    appendEdits: 0,
    replaceEdits: 0,
    blocks: 0,
    violations: reviewFailedRules.length,
    critique: reviewAdvice,
  });

  let persistedModel = args.currentModel;
  if (reviewStep.nextModel) persistedModel = reviewStep.nextModel;

  await appendSupervisorMemoryEntry({
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    entry: {
      at: new Date().toISOString(),
      mode: args.activeMode,
      action: effectiveAction,
      decision: review.decision,
      stopReasons: reviewReasons,
      failedRules: reviewFailedRules.map((check) => check.rule),
      advice: reviewAdvice ?? null,
      nextMode: reviewStep.nextMode ?? null,
      nextUserMessage: injectedMessage?.text ?? reviewStep.nextUserMessage ?? null,
      reasoning: review.reasoning ?? null,
    },
  });

  const actionEntry = buildSupervisorAction({
    action: effectiveAction,
    mode: args.supervisorMode,
    review,
    stopReasons: reviewReasons,
    stopDetails: args.stopDetails,
    budget: {
      timeUsedMs: Date.now() - args.startedAt,
      adjustedTokensUsed: args.budget.adjustedTokensUsed,
      multiplier: args.budget.budgetMultiplier,
      modelCost: args.budget.modelCost,
      minCost: args.budget.minCost,
      cheapestModel: args.budget.cheapestModel,
      timeBudgetMs: args.timeBudgetMs || undefined,
      tokenBudgetAdjusted: args.tokenBudgetAdjusted || undefined,
      cadenceTimeMs: args.cadenceTimeMs || undefined,
      cadenceTokensAdjusted: args.cadenceTokensAdjusted || undefined,
    },
    agentModel: persistedModel,
    supervisorModel: args.supervisorModel,
  });

  const forkSummary = summarizeFork({ review, action: effectiveAction, stopReasons: reviewReasons });
  const nextForkId = newId("fork");
  let nextThreadId = args.currentThreadId;
  let nextSupervisorThreadId = reviewStep.nextSupervisorThreadId ?? args.currentSupervisorThreadId;
  let persistedMode = args.activeMode;
  let persistedAgentRules = args.agentRules;
  let fullResyncNeeded = args.fullResyncNeeded;
  let nextParentForkId = args.activeForkId;

  if (effectiveAction === "fork" && reviewStep.nextMode && reviewStep.forkDisposition === "fresh_mode") {
    const refreshedRunConfig = await refreshRenderedRunConfigForModeFork({
      workspaceRoot: args.workspaceRoot,
      runConfigPath: args.runConfigPath,
      configBaseDir: args.configBaseDir,
      agentBaseDir: args.agentBaseDir,
      supervisorBaseDir: args.supervisorBaseDir,
    });
    const effectiveRenderedRunConfig = refreshedRunConfig ?? args.renderedRunConfig;
    const transitionAllowed = modeTransitionAllowed({
      config: effectiveRenderedRunConfig,
      fromMode: args.activeMode,
      toMode: reviewStep.nextMode,
    });
    const nextMode = transitionAllowed ? reviewStep.nextMode : args.activeMode;
    const nextModeConfig = resolveModeConfig(effectiveRenderedRunConfig, nextMode);
    const nextModeRuleSet = mergeAgentRuleSet({
      requestRequirements: args.requestAgentRuleRequirements,
      configured: nextModeConfig?.agentRules ?? effectiveRenderedRunConfig?.agentRules,
    });
    const nextModePayload = reviewStep.nextModePayload ?? {};
    const seeded = applySupervisorTemplateFields(nextModeConfig?.userMessage?.text?.trim() ?? "", nextModePayload);
    if (!seeded.trim()) {
      throw new Error(`fork_new_conversation requires modes.${nextMode}.user_message to render non-empty text`);
    }
    nextDocText = buildFreshModeDocument({
      conversationId: args.conversationId,
      forkId: nextForkId,
      mode: nextMode,
      systemMessage: buildSessionSystemPromptForMode({ renderedRunConfig: effectiveRenderedRunConfig, mode: nextMode, modePayload: nextModePayload, provider: args.providerName, model: args.currentModel, agentRules: nextModeRuleSet.requirements }),
      userMessage: seeded,
      modePayload: nextModePayload,
      agentRuleRequirements: nextModeRuleSet.requirements,
      agentRuleViolations: nextModeRuleSet.violations,
    });
    persistedMode = nextMode;
    persistedAgentRules = nextModeRuleSet.requirements;
    nextThreadId = undefined;
    nextSupervisorThreadId = args.currentSupervisorThreadId;
    fullResyncNeeded = true;
  } else if (effectiveAction === "fork" && reviewStep.nextMode && reviewStep.forkDisposition === "resume_mode_head") {
    const refreshedRunConfig = await refreshRenderedRunConfigForModeFork({
      workspaceRoot: args.workspaceRoot,
      runConfigPath: args.runConfigPath,
      configBaseDir: args.configBaseDir,
      agentBaseDir: args.agentBaseDir,
      supervisorBaseDir: args.supervisorBaseDir,
    });
    const effectiveRenderedRunConfig = refreshedRunConfig ?? args.renderedRunConfig;
    const transitionAllowed = modeTransitionAllowed({
      config: effectiveRenderedRunConfig,
      fromMode: args.activeMode,
      toMode: reviewStep.nextMode,
    });
    if (!transitionAllowed) {
      throw new Error(`resume_mode_head mode '${reviewStep.nextMode}' is not an allowed transition from '${args.activeMode}'`);
    }
    const forceFreshAcrossLevelBoundary = await shouldForceFreshForkAcrossLevelBoundary({
      workspaceRoot: args.workspaceRoot,
      agentBaseDir: args.agentBaseDir,
    });
    const targetModeFork = forceFreshAcrossLevelBoundary
      ? undefined
      : await loadLatestForkInMode({
          ctx: args.ctx,
          workspaceRoot: args.workspaceRoot,
          conversationId: args.conversationId,
          mode: reviewStep.nextMode,
        });
    if (!targetModeFork) {
      const nextModeConfig = resolveModeConfig(effectiveRenderedRunConfig, reviewStep.nextMode);
      const nextModePayload = reviewStep.nextModePayload ?? {};
      const seeded = applySupervisorTemplateFields(nextModeConfig?.userMessage?.text?.trim() ?? "", nextModePayload);
      if (!seeded.trim()) {
        throw new Error(`resume_mode_head fallback requires modes.${reviewStep.nextMode}.user_message to render non-empty text`);
      }
      const nextModeRuleSet = mergeAgentRuleSet({
        requestRequirements: args.requestAgentRuleRequirements,
        configured: nextModeConfig?.agentRules ?? effectiveRenderedRunConfig?.agentRules,
      });
      nextDocText = buildFreshModeDocument({
        conversationId: args.conversationId,
        forkId: nextForkId,
        mode: reviewStep.nextMode,
        systemMessage: buildSessionSystemPromptForMode({ renderedRunConfig: effectiveRenderedRunConfig, mode: reviewStep.nextMode, modePayload: nextModePayload, provider: args.providerName, model: args.currentModel, agentRules: nextModeRuleSet.requirements }),
        userMessage: seeded,
        modePayload: nextModePayload,
        agentRuleRequirements: nextModeRuleSet.requirements,
        agentRuleViolations: nextModeRuleSet.violations,
      });
      if ((reviewStep.nextUserMessage ?? "").trim()) {
        nextDocText = appendChatMessage(
          nextDocText,
          reviewStep.nextResumeMessageType ?? "user",
          reviewStep.nextUserMessage ?? "",
        );
      }
      persistedMode = reviewStep.nextMode;
      persistedAgentRules = nextModeRuleSet.requirements;
      nextThreadId = undefined;
      nextSupervisorThreadId = args.currentSupervisorThreadId;
      nextParentForkId = args.activeForkId;
    } else {
      nextDocText = targetModeFork.documentText ?? "";
      if ((reviewStep.nextUserMessage ?? "").trim()) {
        nextDocText = appendChatMessage(
          nextDocText,
          reviewStep.nextResumeMessageType ?? "user",
          reviewStep.nextUserMessage ?? "",
        );
      }
      persistedMode = reviewStep.nextMode;
      persistedAgentRules = targetModeFork.agentRules ?? [];
      nextThreadId = targetModeFork.providerThreadId;
      nextSupervisorThreadId = targetModeFork.supervisorThreadId;
      nextParentForkId = targetModeFork.id;
    }
    fullResyncNeeded = true;
  } else if (effectiveAction === "fork" && !reviewStep.forkDisposition) {
    throw new Error("fork action requested without fork_disposition");
  } else if (resume && injectedMessage) {
    nextDocText = appendChatMessage(
      nextDocText,
      injectedMessage.messageType,
      injectedMessage.text,
    );
    fullResyncNeeded = true;
  }

  const nextDocWithFork = updateFrontmatterField(
    updateFrontmatterForkId(nextDocText, args.conversationId, nextForkId),
    "mode",
    persistedMode,
  );
  const nextDocWithModePayload = effectiveAction === "fork"
    ? nextDocWithFork
    : updateFrontmatterModePayload(nextDocWithFork, args.activeModePayload);

  const nextFork = await args.ctx.store.createFork({
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    parentId: nextParentForkId,
    forkId: nextForkId,
    documentText: nextDocWithModePayload,
    agentRules: persistedAgentRules,
    providerName: args.providerName,
    model: persistedModel,
    providerThreadId: nextThreadId,
    supervisorThreadId: nextSupervisorThreadId,
    actions: [actionEntry],
    actionSummary: actionEntry.summary,
    forkSummary,
    agentModel: persistedModel,
    supervisorModel: args.supervisorModel,
  });
  args.ctx.sendNotification({ method: "fork.created", params: { conversationId: args.conversationId, forkId: nextFork.id, headId: nextFork.id } });
  args.switchActiveFork(nextFork.id);
  args.ctx.sendNotification({
    method: "conversation.replace",
    params: { docPath: args.docPath, documentText: nextDocWithModePayload, baseForkId: nextFork.id },
  });

  return {
    nextDocText: nextDocWithModePayload,
    nextForkId: nextFork.id,
    nextThreadId,
    nextSupervisorThreadId,
    nextModel: reviewStep.nextModel,
    review,
    reviewReasons,
    effectiveAction,
    resume,
    historyRewritten,
    supervisorHookChanged: supervisorHookApply.changed,
    reviewAdvice,
    reviewFailedRulesCount: reviewFailedRules.length,
    fullResyncNeeded,
  };
}
