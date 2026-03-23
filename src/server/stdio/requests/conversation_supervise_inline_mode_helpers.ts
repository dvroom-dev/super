import type { SupervisorReviewResult } from "../../../supervisor/review_schema.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { ChatRole } from "../../../markdown/ast.js";
import { parseChatMarkdown } from "../../../markdown/parse.js";
import { newId } from "../../../utils/ids.js";
import type { BudgetState } from "../supervisor/agent_turn.js";
import { updateFrontmatterForkId } from "../supervisor/fork_utils.js";
import { buildSupervisorAction, summarizeFork } from "../supervisor/supervisor_actions.js";
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
import type { RuntimeContext } from "./context.js";
import type { SwitchModeRequest } from "./conversation_supervise_switch_mode.js";
import { validateSwitchModeHandoffText } from "./conversation_supervise_switch_mode.js";
import { refreshRenderedRunConfigForModeFork } from "./conversation_supervise_run_config_refresh.js";
import { buildSessionSystemPromptForMode } from "../supervisor/session_system_prompt.js";
import {
  applyProcessFrontmatter,
  isV2ProcessEnabled,
  normalizeTransitionPayloadForMode,
  processAssignmentForTransition,
  resumeStrategyForTaskProfile,
} from "../supervisor/process_runtime.ts";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export function buildSwitchModeSupervisorRequestMessage(args: {
  activeMode: string;
  request: SwitchModeRequest;
  allowedNextModes: string[];
}): string {
  const payloadJson = JSON.stringify(args.request.modePayload, null, 2);
  return [
    "<agent-switch-mode-request>",
    `from_mode: ${args.activeMode}`,
    `target_mode: ${args.request.targetMode}`,
    `reason: ${args.request.reason}`,
    `terminal: ${String(args.request.terminal)}`,
    `allowed_next_modes: ${args.allowedNextModes.join(", ") || "(none)"}`,
    "mode_payload:",
    "```json",
    payloadJson,
    "```",
    "</agent-switch-mode-request>",
    "Decide whether to follow this request, modify it, replace it with guidance, continue, or stop.",
  ].join("\n");
}

function decisionModePayload(args: {
  review: SupervisorReviewResult;
  mode: string;
}): Record<string, string> {
  const payload = args.review.decision === "fork_new_conversation"
    ? args.review.payload.mode_payload?.[args.mode]
    : args.review.decision === "resume_mode_head"
      ? args.review.payload.mode_payload
      : undefined;
  if (!payload || typeof payload !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const normalizedKey = String(key ?? "").trim();
    const normalizedValue = String(value ?? "").trim();
    if (!normalizedKey || !normalizedValue) continue;
    out[normalizedKey] = normalizedValue;
  }
  return out;
}

async function loadLatestForkInMode(args: {
  ctx: RuntimeContext;
  workspaceRoot: string;
  conversationId: string;
  mode: string;
}) {
  const idx = await args.ctx.store.loadIndex(args.workspaceRoot, args.conversationId);
  let fallback: any = undefined;
  for (let i = idx.forks.length - 1; i >= 0; i -= 1) {
    const forkSummary = idx.forks[i];
    const fork = await args.ctx.store.loadFork(args.workspaceRoot, args.conversationId, forkSummary.id);
    const forkMode = frontmatterValue(fork.documentText ?? "", "mode")?.trim() || "";
    if (forkMode !== args.mode) continue;
    if (fork.providerThreadId) return fork;
    if (!fallback) fallback = fork;
  }
  return fallback;
}

function extractLastAssistantMessage(documentText: string): string {
  const parsed = parseChatMarkdown(documentText);
  for (let i = parsed.blocks.length - 1; i >= 0; i -= 1) {
    const block = parsed.blocks[i];
    if (block.kind !== "chat") continue;
    if (!("role" in block) || block.role !== "assistant") continue;
    const content = String(block.content ?? "").trim();
    if (content) return content;
  }
  return "";
}

function buildResumeHandoffMessage(args: {
  review: SupervisorReviewResult;
  agentMessage?: string;
  agentRequestMessage?: string;
  transitionTrigger?: string;
}): { text: string; messageType: ChatRole } {
  const reviewMessage = args.review.decision === "resume_mode_head"
    ? String(args.review.payload.message ?? "").trim()
    : "";
  const reviewMessageType: ChatRole = args.review.decision === "resume_mode_head"
    ? (args.review.payload.message_type ?? "user")
    : "user";
  const agentRequestMessage = String(args.agentRequestMessage ?? "").trim();
  const agentMessage = args.transitionTrigger === "agent_switch_mode_request"
    ? ""
    : String(args.agentMessage ?? "").trim();
  const handoffSource = agentRequestMessage || agentMessage;
  if (args.transitionTrigger !== "agent_switch_mode_request" || !handoffSource) {
    return { text: reviewMessage, messageType: reviewMessageType };
  }
  const lines = [
    "<mode-handoff source=\"agent_switch_mode_request\">",
    agentMessage ? "<agent-message>" : "<agent-switch-request>",
    handoffSource,
    agentMessage ? "</agent-message>" : "</agent-switch-request>",
  ];
  if (reviewMessage) {
    lines.push("", "<supervisor-guidance>", reviewMessage, "</supervisor-guidance>");
  }
  lines.push("</mode-handoff>");
  return { text: lines.join("\n"), messageType: "supervisor" };
}

export async function applySupervisorForkDecision(args: {
  ctx: RuntimeContext;
  workspaceRoot: string;
  docPath: string;
  conversationId: string;
  activeForkId: string;
  switchActiveFork: (nextForkId: string) => void;
  renderedRunConfig: RenderedRunConfig | null;
  runConfigPath?: string;
  configBaseDir: string;
  agentBaseDir: string;
  supervisorBaseDir: string;
  requestAgentRuleRequirements: string[];
  activeMode: string;
  allowedNextModes: string[];
  review: SupervisorReviewResult;
  reasonLabel: string;
  detailLabel: string;
  startedAt: number;
  budget: BudgetState;
  providerName: "mock" | "codex" | "claude";
  supervisorProviderName?: "mock" | "codex" | "claude";
  currentModel: string;
  supervisorModel: string;
  currentDocText?: string;
  currentThreadId?: string;
  currentSupervisorThreadId?: string;
  currentAssistantText?: string;
  currentAgentRequestMessage?: string;
  transitionTrigger?: string;
}): Promise<{
  docText: string;
  threadId?: string;
  supervisorThreadId?: string;
  activeTransitionPayload: Record<string, string>;
  fullResyncNeeded: true;
} | undefined> {
  if (args.review.decision !== "fork_new_conversation" && args.review.decision !== "resume_mode_head") return undefined;
  const activeTransitionPayload = normalizeTransitionPayloadForMode(
    args.renderedRunConfig,
    String(args.review.payload.mode ?? "").trim(),
    args.review.transition_payload && typeof args.review.transition_payload === "object"
      ? { ...args.review.transition_payload }
      : {},
  );
  const refreshedRunConfig = await refreshRenderedRunConfigForModeFork({
    workspaceRoot: args.workspaceRoot,
    runConfigPath: args.runConfigPath,
    configBaseDir: args.configBaseDir,
    agentBaseDir: args.agentBaseDir,
    supervisorBaseDir: args.supervisorBaseDir,
  });
  const effectiveRenderedRunConfig = refreshedRunConfig ?? args.renderedRunConfig;
  const requestedMode = String(args.review.payload.mode ?? "").trim();
  const v2 = isV2ProcessEnabled(effectiveRenderedRunConfig);
  if (!requestedMode || (!v2 && !args.allowedNextModes.includes(requestedMode))) {
    return undefined;
  }
  if (!v2 && !modeTransitionAllowed({ config: effectiveRenderedRunConfig, fromMode: args.activeMode, toMode: requestedMode })) {
    return undefined;
  }
  const handoff = buildResumeHandoffMessage({
    review: args.review,
    agentMessage:
      String(args.currentAssistantText ?? "").trim()
      || extractLastAssistantMessage(String(args.currentDocText ?? "")),
    agentRequestMessage: args.currentAgentRequestMessage,
    transitionTrigger: args.transitionTrigger,
  });
  const handoffValidationError = validateSwitchModeHandoffText({
    targetMode: requestedMode,
    text: handoff.text,
  });
  if (handoffValidationError) {
    throw new Error(handoffValidationError);
  }
  const maybeCheckpointCurrentMode = async (): Promise<void> => {
    const currentDocText = String(args.currentDocText ?? "").trim();
    if (!currentDocText) return;
    const currentMode = frontmatterValue(currentDocText, "mode")?.trim() || args.activeMode;
    if (!currentMode || currentMode !== args.activeMode) return;
    let currentFork: any;
    try {
      currentFork = await args.ctx.store.loadFork(
        args.workspaceRoot,
        args.conversationId,
        args.activeForkId,
      );
    } catch {
      // Some inline check_supervisor paths can branch before the current fork is persisted.
      // In that case there is nothing concrete to checkpoint yet.
      return;
    }
    const currentForkText = String(currentFork.documentText ?? "");
    const currentThreadId = args.currentThreadId;
    const currentSupervisorThreadId = args.currentSupervisorThreadId;
    const documentChanged = currentForkText.trim() !== currentDocText.trim();
    const threadChanged =
      String(currentFork.providerThreadId ?? "") !== String(currentThreadId ?? "")
      || String(currentFork.supervisorThreadId ?? "") !== String(currentSupervisorThreadId ?? "");
    if (!documentChanged && !threadChanged) return;
    const checkpointForkId = newId("fork");
    const checkpointDoc = updateFrontmatterForkId(currentDocText, args.conversationId, checkpointForkId);
    await args.ctx.store.createFork({
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      parentId: args.activeForkId,
      forkId: checkpointForkId,
      documentText: checkpointDoc,
      agentRules: currentFork.agentRules ?? [],
      providerName: args.providerName,
      supervisorProviderName: args.supervisorProviderName,
      model: args.currentModel,
      providerThreadId: currentThreadId,
      supervisorThreadId: currentSupervisorThreadId,
      actionSummary: "mode checkpoint",
      forkSummary: `Mode checkpoint: ${currentMode}`,
      agentModel: args.currentModel,
      supervisorModel: args.supervisorModel,
    });
  };
  if (args.review.decision === "resume_mode_head") {
    if (requestedMode !== args.activeMode) {
      await maybeCheckpointCurrentMode();
    }
    const nextModePayload = decisionModePayload({ review: args.review, mode: requestedMode });
    const targetAssignment = processAssignmentForTransition({
      config: effectiveRenderedRunConfig,
      mode: requestedMode,
      transitionPayload: activeTransitionPayload,
    });
    const defaultResumeStrategy = resumeStrategyForTaskProfile(
      effectiveRenderedRunConfig,
      targetAssignment.profileId,
    );
    const requestedResumeStrategy = String(activeTransitionPayload.resume_strategy ?? "").trim();
    const resumeStrategy = requestedResumeStrategy === "same_conversation" || requestedResumeStrategy === "fork_fresh"
      ? requestedResumeStrategy
      : defaultResumeStrategy;
    const targetModeFork = await loadLatestForkInMode({
      ctx: args.ctx,
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      mode: requestedMode,
    });
    const nextForkId = newId("fork");
    if (!targetModeFork || resumeStrategy === "fork_fresh") {
      const nextModeConfig = resolveModeConfig(effectiveRenderedRunConfig, requestedMode);
      const nextModeRuleSet = mergeAgentRuleSet({
        requestRequirements: args.requestAgentRuleRequirements,
        configured: nextModeConfig?.agentRules ?? effectiveRenderedRunConfig?.agentRules,
      });
      const seeded = applySupervisorTemplateFields(nextModeConfig?.userMessage?.text?.trim() ?? "", {});
      if (!seeded.trim()) {
        throw new Error(`resume_mode_head fallback requires modes.${requestedMode}.user_message to render non-empty text`);
      }
      let freshDoc = buildFreshModeDocument({
        conversationId: args.conversationId,
        forkId: nextForkId,
        mode: requestedMode,
        processStage: targetAssignment.stageId ?? undefined,
        taskProfile: targetAssignment.profileId ?? undefined,
        systemMessage: buildSessionSystemPromptForMode({ renderedRunConfig: effectiveRenderedRunConfig, mode: requestedMode, modePayload: nextModePayload, provider: args.providerName, model: args.currentModel, agentRules: nextModeRuleSet.requirements }),
        userMessage: seeded,
        modePayload: nextModePayload,
        agentRuleRequirements: nextModeRuleSet.requirements,
        agentRuleViolations: nextModeRuleSet.violations,
      });
      if (handoff.text) {
        freshDoc = appendChatMessage(
          freshDoc,
          handoff.messageType,
          handoff.text,
        );
      }
      const actionEntry = buildSupervisorAction({
        action: "fork",
        mode: "hard",
        review: args.review,
        stopReasons: [args.reasonLabel],
        stopDetails: [args.detailLabel],
        budget: {
          timeUsedMs: Date.now() - args.startedAt,
          adjustedTokensUsed: args.budget.adjustedTokensUsed,
        },
        agentModel: args.currentModel,
        supervisorModel: args.supervisorModel,
      });
      const nextFork = await args.ctx.store.createFork({
        workspaceRoot: args.workspaceRoot,
        conversationId: args.conversationId,
        parentId: args.activeForkId,
        forkId: nextForkId,
        documentText: freshDoc,
        agentRules: nextModeRuleSet.requirements,
        providerName: args.providerName,
        supervisorProviderName: args.supervisorProviderName,
        model: args.currentModel,
        providerThreadId: undefined,
        supervisorThreadId: args.currentSupervisorThreadId,
        actions: [actionEntry],
        actionSummary: actionEntry.summary,
        forkSummary: summarizeFork({
          review: args.review,
          action: "fork",
          stopReasons: [args.reasonLabel],
        }),
        agentModel: args.currentModel,
        supervisorModel: args.supervisorModel,
      });
      args.ctx.sendNotification({
        method: "fork.created",
        params: { conversationId: args.conversationId, forkId: nextFork.id, headId: nextFork.id },
      });
      args.switchActiveFork(nextFork.id);
      args.ctx.sendNotification({
        method: "conversation.replace",
        params: { docPath: args.docPath, documentText: freshDoc, baseForkId: nextFork.id },
      });
      return {
        docText: freshDoc,
        threadId: undefined,
        supervisorThreadId: args.currentSupervisorThreadId,
        activeTransitionPayload,
        fullResyncNeeded: true,
      };
    }
    let resumedDoc = targetModeFork.documentText ?? "";
    if (handoff.text) {
      resumedDoc = appendChatMessage(
        resumedDoc,
        handoff.messageType,
        handoff.text,
      );
    }
    const nextDoc = updateFrontmatterModePayload(
      applyProcessFrontmatter(
        updateFrontmatterField(
          updateFrontmatterForkId(resumedDoc, args.conversationId, nextForkId),
          "mode",
          requestedMode,
        ),
        processAssignmentForTransition({
          config: args.renderedRunConfig,
          mode: requestedMode,
          transitionPayload: activeTransitionPayload,
        }),
      ),
      nextModePayload,
    );
    const actionEntry = buildSupervisorAction({
      action: "resume_mode_head",
      mode: "hard",
      review: args.review,
      stopReasons: [args.reasonLabel],
      stopDetails: [args.detailLabel],
      budget: {
        timeUsedMs: Date.now() - args.startedAt,
        adjustedTokensUsed: args.budget.adjustedTokensUsed,
      },
      agentModel: args.currentModel,
      supervisorModel: args.supervisorModel,
    });
    const nextFork = await args.ctx.store.createFork({
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      parentId: targetModeFork.id,
      forkId: nextForkId,
      documentText: nextDoc,
      agentRules: targetModeFork.agentRules ?? [],
      providerName: args.providerName,
      supervisorProviderName: args.supervisorProviderName,
      model: args.currentModel,
      providerThreadId: targetModeFork.providerThreadId,
      supervisorThreadId: args.currentSupervisorThreadId,
      actions: [actionEntry],
      actionSummary: actionEntry.summary,
      forkSummary: summarizeFork({
        review: args.review,
        action: "fork",
        stopReasons: [args.reasonLabel],
      }),
      agentModel: args.currentModel,
      supervisorModel: args.supervisorModel,
    });
    args.ctx.sendNotification({
      method: "fork.created",
      params: { conversationId: args.conversationId, forkId: nextFork.id, headId: nextFork.id },
    });
    args.switchActiveFork(nextFork.id);
    args.ctx.sendNotification({
      method: "conversation.replace",
      params: { docPath: args.docPath, documentText: nextDoc, baseForkId: nextFork.id },
    });
    return {
      docText: nextDoc,
      threadId: targetModeFork.providerThreadId,
      supervisorThreadId: args.currentSupervisorThreadId,
      activeTransitionPayload,
      fullResyncNeeded: true,
    };
  }
  const nextModeConfig = resolveModeConfig(effectiveRenderedRunConfig, requestedMode);
  if (requestedMode !== args.activeMode) {
    await maybeCheckpointCurrentMode();
  }
  const modePayload = decisionModePayload({ review: args.review, mode: requestedMode });
  const seeded = applySupervisorTemplateFields(nextModeConfig?.userMessage?.text?.trim() ?? "", modePayload);
  if (!seeded.trim()) {
    throw new Error(`fork_new_conversation requires modes.${requestedMode}.user_message to render non-empty text`);
  }
  const nextModeRuleSet = mergeAgentRuleSet({
    requestRequirements: args.requestAgentRuleRequirements,
    configured: nextModeConfig?.agentRules ?? effectiveRenderedRunConfig?.agentRules,
  });
  const nextForkId = newId("fork");
  const forkDoc = buildFreshModeDocument({
    conversationId: args.conversationId,
    forkId: nextForkId,
    mode: requestedMode,
    processStage: processAssignmentForTransition({ config: effectiveRenderedRunConfig, mode: requestedMode, transitionPayload: activeTransitionPayload }).stageId ?? undefined,
    taskProfile: processAssignmentForTransition({ config: effectiveRenderedRunConfig, mode: requestedMode, transitionPayload: activeTransitionPayload }).profileId ?? undefined,
    systemMessage: buildSessionSystemPromptForMode({ renderedRunConfig: effectiveRenderedRunConfig, mode: requestedMode, modePayload, provider: args.providerName, model: args.currentModel, agentRules: nextModeRuleSet.requirements }),
    userMessage: seeded,
    modePayload,
    agentRuleRequirements: nextModeRuleSet.requirements,
    agentRuleViolations: nextModeRuleSet.violations,
  });
  const nextDoc = handoff.text
    ? appendChatMessage(forkDoc, handoff.messageType, handoff.text)
    : forkDoc;
  const actionEntry = buildSupervisorAction({
    action: "fork",
    mode: "hard",
    review: args.review,
    stopReasons: [args.reasonLabel],
    stopDetails: [args.detailLabel],
    budget: {
      timeUsedMs: Date.now() - args.startedAt,
      adjustedTokensUsed: args.budget.adjustedTokensUsed,
    },
    agentModel: args.currentModel,
    supervisorModel: args.supervisorModel,
  });
  const nextFork = await args.ctx.store.createFork({
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    parentId: args.activeForkId,
    forkId: nextForkId,
    documentText: nextDoc,
    agentRules: nextModeRuleSet.requirements,
    providerName: args.providerName,
    supervisorProviderName: args.supervisorProviderName,
    model: args.currentModel,
    providerThreadId: undefined,
    supervisorThreadId: args.currentSupervisorThreadId,
    actions: [actionEntry],
    actionSummary: actionEntry.summary,
    forkSummary: summarizeFork({
      review: args.review,
      action: "fork",
      stopReasons: [args.reasonLabel],
    }),
    agentModel: args.currentModel,
    supervisorModel: args.supervisorModel,
  });
  args.ctx.sendNotification({
    method: "fork.created",
    params: { conversationId: args.conversationId, forkId: nextFork.id, headId: nextFork.id },
  });
  args.switchActiveFork(nextFork.id);
  args.ctx.sendNotification({
    method: "conversation.replace",
    params: { docPath: args.docPath, documentText: nextDoc, baseForkId: nextFork.id },
  });
  return {
    docText: nextDoc,
    threadId: undefined,
    supervisorThreadId: args.currentSupervisorThreadId,
    activeTransitionPayload,
    fullResyncNeeded: true,
  };
}
