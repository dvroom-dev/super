import { renderChat } from "../../../markdown/render.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { ToolInterceptionAction, ToolInterceptionMatch } from "../../../supervisor/tool_interception.js";
import type { BudgetState } from "../supervisor/agent_turn.js";
import { buildSupervisorInjectedMessage } from "../supervisor/supervisor_interjections.js";
import { persistAgentTurnWithoutSupervisor } from "../supervisor/no_supervisor_finalize.js";
import { runSupervisorReview } from "../supervisor/supervisor_run.js";
import type { SupervisorConfig } from "../types.js";
import {
  applySupervisorForkDecision,
  buildSwitchModeSupervisorRequestMessage,
} from "./conversation_supervise_inline_mode_helpers.js";
import {
  buildToolInterceptionReviewMessage,
  isReplaceToolInterceptTemplate,
} from "./conversation_supervise_tool_interception.js";
import { applySwitchModeRequestFork, type SwitchModeRequest } from "./conversation_supervise_switch_mode.js";
import type { RuntimeContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

type InlineToolInterceptionState = {
  currentDocText: string;
  currentThreadId?: string;
  currentSupervisorThreadId?: string;
  activeTransitionPayload: Record<string, string>;
  fullResyncNeeded: boolean;
};

type RunInlineToolInterceptionReviewArgs = {
  match: ToolInterceptionMatch;
  state: InlineToolInterceptionState;
  replaceWithInjectedMessage?: (markdown: string) => void;
  appendInlineMarkdown: (markdown: string) => void;
  appendInlineError: (message: string) => void;
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
  effectiveAgentRequirements: string[];
  effectiveAgentViolations: string[];
  effectiveSupervisorInstructions: string[];
  supervisorProviderName: "mock" | "codex" | "claude";
  supervisorModel: string;
  currentModel: string;
  supervisorModelReasoningEffort?: string;
  supervisorProviderOptions?: Record<string, unknown>;
  effectiveSupervisorConfiguredSystemMessage?: any;
  supervisorTriggers?: NonNullable<RenderedRunConfig>["supervisorTriggers"];
  effectiveStopCondition: string;
  activeMode: string;
  allowedNextModes: string[];
  modePayloadFieldsByMode: Record<string, string[]>;
  modeGuidanceByMode: Record<string, { description?: string; startWhen?: string[]; stopWhen?: string[] }>;
  supervisorWorkspaceRoot: string;
  agentsText?: string;
  workspaceListingText?: string;
  taggedFiles: any[];
  openFiles: any[];
  utilities: any;
  skills: any[];
  skillsToInvoke: any[];
  skillInstructions: any[];
  startedAt: number;
  budget: BudgetState;
  providerName: "mock" | "codex" | "claude";
  effectiveSupervisor: SupervisorConfig;
};

type InlineToolInterceptionReviewOutcome =
  | {
      kind: "continue";
      terminateInlineLoop: boolean;
    }
  | {
      kind: "stop";
      currentDocText: string;
      nextForkId: string;
      stopReasons: string[];
      stopDetails: string[];
    };

export async function runInlineToolInterceptionReview(
  args: RunInlineToolInterceptionReviewArgs,
): Promise<InlineToolInterceptionReviewOutcome> {
  const configuredAction = args.match.rule.action;
  if (configuredAction) {
    return runConfiguredToolInterceptionAction({
      ...args,
      action: configuredAction,
    });
  }

  const requestMessage = buildToolInterceptionReviewMessage(args.match);
  const reviewDocumentText = [args.state.currentDocText.trim(), renderChat("user", requestMessage).trim()]
    .filter(Boolean)
    .join("\n\n");
  const reviewOutcome = await runSupervisorReview({
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    documentText: reviewDocumentText,
    agentRules: args.effectiveAgentRequirements,
    agentRuleViolations: args.effectiveAgentViolations,
    supervisorInstructions: args.effectiveSupervisorInstructions,
    assistantText: requestMessage,
    trigger: "agent_tool_intercept",
    stopReasons: ["tool_intercept"],
    mode: "hard",
    providerName: args.supervisorProviderName,
    model: args.supervisorModel || args.currentModel,
    agentModel: args.currentModel,
    supervisorModel: args.supervisorModel,
    supervisorModelReasoningEffort: args.supervisorModelReasoningEffort,
    providerOptions: args.supervisorProviderOptions,
    agentsText: args.agentsText,
    workspaceListingText: args.workspaceListingText,
    taggedFiles: args.taggedFiles,
    openFiles: args.openFiles,
    utilities: args.utilities,
    skills: args.skills,
    skillsToInvoke: args.skillsToInvoke,
    skillInstructions: args.skillInstructions,
    configuredSystemMessage: args.effectiveSupervisorConfiguredSystemMessage,
    supervisorTriggers: args.supervisorTriggers,
    stopCondition: args.effectiveStopCondition,
    currentMode: args.activeMode,
    allowedNextModes: args.allowedNextModes,
    modePayloadFieldsByMode: args.modePayloadFieldsByMode,
    modeGuidanceByMode: args.modeGuidanceByMode,
    supervisorCarryover: "",
    supervisorWorkspaceRoot: args.supervisorWorkspaceRoot,
    threadId: args.state.currentSupervisorThreadId,
    timeoutMs: args.effectiveSupervisor.reviewTimeoutMs,
    disableSyntheticCheckSupervisorOnRuleFailure:
      args.effectiveSupervisor.disableSyntheticCheckSupervisorOnRuleFailure,
  });
  if (reviewOutcome.threadId) args.state.currentSupervisorThreadId = reviewOutcome.threadId;

  if (reviewOutcome.review.decision === "stop_and_return") {
    const reason = reviewOutcome.review.payload.reason || "tool interception requested stop";
    const persisted = await persistAgentTurnWithoutSupervisor({
      ctx: args.ctx,
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      currentDocText: args.state.currentDocText,
      currentForkId: args.activeForkId,
      docPath: args.docPath,
      agentRules: args.effectiveAgentRequirements,
      providerName: args.providerName,
      currentModel: args.currentModel,
      supervisorModel: args.supervisorModel,
      currentThreadId: args.state.currentThreadId,
      currentSupervisorThreadId: args.state.currentSupervisorThreadId,
      switchActiveFork: args.switchActiveFork,
    });
    return {
      kind: "stop",
      currentDocText: persisted.nextDocText,
      nextForkId: persisted.nextForkId,
      stopReasons: ["tool_intercept"],
      stopDetails: [reason],
    };
  }

  const switchFork = await applySupervisorForkDecision({
    ctx: args.ctx,
    workspaceRoot: args.workspaceRoot,
    docPath: args.docPath,
    conversationId: args.conversationId,
    activeForkId: args.activeForkId,
    switchActiveFork: args.switchActiveFork,
    renderedRunConfig: args.renderedRunConfig,
    runConfigPath: args.runConfigPath,
    configBaseDir: args.configBaseDir,
    agentBaseDir: args.agentBaseDir,
    supervisorBaseDir: args.supervisorBaseDir,
    requestAgentRuleRequirements: args.requestAgentRuleRequirements,
    activeMode: args.activeMode,
    allowedNextModes: args.allowedNextModes,
    review: reviewOutcome.review,
    reasonLabel: "tool_intercept",
    detailLabel: "tool interception requested fork",
    startedAt: args.startedAt,
    budget: args.budget,
    providerName: args.providerName,
    supervisorProviderName: args.supervisorProviderName,
    currentModel: args.currentModel,
    supervisorModel: args.supervisorModel,
    currentDocText: args.state.currentDocText,
    currentThreadId: args.state.currentThreadId,
    currentSupervisorThreadId: args.state.currentSupervisorThreadId,
  });
  if (switchFork) {
    args.state.currentDocText = switchFork.docText;
    args.state.currentThreadId = switchFork.threadId;
    args.state.currentSupervisorThreadId = switchFork.supervisorThreadId;
    args.state.activeTransitionPayload = switchFork.activeTransitionPayload;
    args.state.fullResyncNeeded = switchFork.fullResyncNeeded;
    return { kind: "continue", terminateInlineLoop: true };
  }
  if (
    reviewOutcome.review.decision === "fork_new_conversation"
    || reviewOutcome.review.decision === "resume_mode_head"
  ) {
    args.appendInlineError("Supervisor requested an invalid mode branch transition for tool interception.");
    return { kind: "continue", terminateInlineLoop: false };
  }
  if (reviewOutcome.review.decision !== "append_message_and_continue") {
    return { kind: "continue", terminateInlineLoop: false };
  }

  const injected = buildSupervisorInjectedMessage({
    supervisorMode: "hard",
    reviewTrigger: "agent_tool_intercept",
    review: reviewOutcome.review,
    guidanceText: reviewOutcome.review.payload.message ?? "",
    messageTemplateName: reviewOutcome.review.payload.message_template,
    reasons: ["tool_intercept"],
    stopDetails: [],
    supervisorTriggers: args.supervisorTriggers,
  });
  if (!injected) {
    args.appendInlineError("Supervisor returned append_message_and_continue with no injectable message.");
    return { kind: "continue", terminateInlineLoop: false };
  }
  const replaceByTemplate = isReplaceToolInterceptTemplate(reviewOutcome.review.payload.message_template);
  if (replaceByTemplate && args.replaceWithInjectedMessage) {
    args.replaceWithInjectedMessage(renderChat(injected.messageType, injected.text));
    return { kind: "continue", terminateInlineLoop: true };
  }
  args.appendInlineMarkdown(renderChat(injected.messageType, injected.text));
  return { kind: "continue", terminateInlineLoop: false };
}

async function runConfiguredToolInterceptionAction(
  args: RunInlineToolInterceptionReviewArgs & {
    action: ToolInterceptionAction;
  },
): Promise<InlineToolInterceptionReviewOutcome> {
  const request: SwitchModeRequest = {
    targetMode: args.action.targetMode,
    reason: args.action.reason,
    modePayload: { ...(args.action.modePayload ?? {}) },
    terminal: true,
  };
  if (args.action.type === "runtime_switch_mode") {
    const direct = await applySwitchModeRequestFork({
      ctx: args.ctx,
      workspaceRoot: args.workspaceRoot,
      docPath: args.docPath,
      conversationId: args.conversationId,
      activeForkId: args.activeForkId,
      switchActiveFork: args.switchActiveFork,
      renderedRunConfig: args.renderedRunConfig,
      runConfigPath: args.runConfigPath,
      configBaseDir: args.configBaseDir,
      agentBaseDir: args.agentBaseDir,
      supervisorBaseDir: args.supervisorBaseDir,
      requestAgentRuleRequirements: args.requestAgentRuleRequirements,
      activeMode: args.activeMode,
      allowedNextModes: args.allowedNextModes,
      modePayloadFieldsByMode: args.modePayloadFieldsByMode,
      budget: args.budget,
      providerName: args.providerName,
      supervisorProviderName: args.supervisorProviderName,
      currentModel: args.currentModel,
      supervisorModel: args.supervisorModel,
      currentSupervisorThreadId: args.state.currentSupervisorThreadId,
      request,
      sourceLabel: "supervisor",
    });
    if (direct.kind === "error") {
      args.appendInlineError(direct.markdown);
      return { kind: "continue", terminateInlineLoop: false };
    }
    args.state.currentDocText = direct.docText;
    args.state.currentThreadId = direct.threadId;
    args.state.currentSupervisorThreadId = direct.supervisorThreadId;
    args.state.fullResyncNeeded = direct.fullResyncNeeded;
    return { kind: "continue", terminateInlineLoop: true };
  }

  const requestMessage = buildSwitchModeSupervisorRequestMessage({
    activeMode: args.activeMode,
    request,
    allowedNextModes: args.allowedNextModes,
  });
  const reviewDocumentText = [args.state.currentDocText.trim(), renderChat("user", requestMessage).trim()]
    .filter(Boolean)
    .join("\n\n");
  const reviewOutcome = await runSupervisorReview({
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    documentText: reviewDocumentText,
    agentRules: args.effectiveAgentRequirements,
    agentRuleViolations: args.effectiveAgentViolations,
    supervisorInstructions: args.effectiveSupervisorInstructions,
    assistantText: requestMessage,
    trigger: "agent_switch_mode_request",
    stopReasons: ["agent_switch_mode_request"],
    mode: "hard",
    providerName: args.supervisorProviderName,
    model: args.supervisorModel || args.currentModel,
    agentModel: args.currentModel,
    supervisorModel: args.supervisorModel,
    supervisorModelReasoningEffort: args.supervisorModelReasoningEffort,
    providerOptions: args.supervisorProviderOptions,
    agentsText: args.agentsText,
    workspaceListingText: args.workspaceListingText,
    taggedFiles: args.taggedFiles,
    openFiles: args.openFiles,
    utilities: args.utilities,
    skills: args.skills,
    skillsToInvoke: args.skillsToInvoke,
    skillInstructions: args.skillInstructions,
    configuredSystemMessage: args.effectiveSupervisorConfiguredSystemMessage,
    supervisorTriggers: args.supervisorTriggers,
    stopCondition: args.effectiveStopCondition,
    currentMode: args.activeMode,
    allowedNextModes: args.allowedNextModes,
    modePayloadFieldsByMode: args.modePayloadFieldsByMode,
    modeGuidanceByMode: args.modeGuidanceByMode,
    supervisorCarryover: "",
    supervisorWorkspaceRoot: args.supervisorWorkspaceRoot,
    threadId: args.state.currentSupervisorThreadId,
    timeoutMs: args.effectiveSupervisor.reviewTimeoutMs,
    disableSyntheticCheckSupervisorOnRuleFailure:
      args.effectiveSupervisor.disableSyntheticCheckSupervisorOnRuleFailure,
  });
  if (reviewOutcome.threadId) args.state.currentSupervisorThreadId = reviewOutcome.threadId;
  if (reviewOutcome.review.decision === "stop_and_return") {
    const reason = reviewOutcome.review.payload.reason || "tool interception requested stop";
    const persisted = await persistAgentTurnWithoutSupervisor({
      ctx: args.ctx,
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      currentDocText: args.state.currentDocText,
      currentForkId: args.activeForkId,
      docPath: args.docPath,
      agentRules: args.effectiveAgentRequirements,
      providerName: args.providerName,
      currentModel: args.currentModel,
      supervisorModel: args.supervisorModel,
      currentThreadId: args.state.currentThreadId,
      currentSupervisorThreadId: args.state.currentSupervisorThreadId,
      switchActiveFork: args.switchActiveFork,
    });
    return {
      kind: "stop",
      currentDocText: persisted.nextDocText,
      nextForkId: persisted.nextForkId,
      stopReasons: ["agent_switch_mode_request"],
      stopDetails: [reason],
    };
  }
  const switchFork = await applySupervisorForkDecision({
    ctx: args.ctx,
    workspaceRoot: args.workspaceRoot,
    docPath: args.docPath,
    conversationId: args.conversationId,
    activeForkId: args.activeForkId,
    switchActiveFork: args.switchActiveFork,
    renderedRunConfig: args.renderedRunConfig,
    runConfigPath: args.runConfigPath,
    configBaseDir: args.configBaseDir,
    agentBaseDir: args.agentBaseDir,
    supervisorBaseDir: args.supervisorBaseDir,
    requestAgentRuleRequirements: args.requestAgentRuleRequirements,
    activeMode: args.activeMode,
    allowedNextModes: args.allowedNextModes,
    review: reviewOutcome.review,
    reasonLabel: "tool_intercept",
    detailLabel: "configured tool interception requested switch_mode",
    startedAt: args.startedAt,
    budget: args.budget,
    providerName: args.providerName,
    supervisorProviderName: args.supervisorProviderName,
    currentModel: args.currentModel,
    supervisorModel: args.supervisorModel,
    currentDocText: args.state.currentDocText,
    currentThreadId: args.state.currentThreadId,
    currentSupervisorThreadId: args.state.currentSupervisorThreadId,
    currentAgentRequestMessage: requestMessage,
    transitionTrigger: "agent_switch_mode_request",
  });
  if (switchFork) {
    args.state.currentDocText = switchFork.docText;
    args.state.currentThreadId = switchFork.threadId;
    args.state.currentSupervisorThreadId = switchFork.supervisorThreadId;
    args.state.fullResyncNeeded = switchFork.fullResyncNeeded;
    return { kind: "continue", terminateInlineLoop: true };
  }
  if (
    reviewOutcome.review.decision === "fork_new_conversation"
    || reviewOutcome.review.decision === "resume_mode_head"
  ) {
    args.appendInlineError("Supervisor requested an invalid mode branch transition for configured tool interception switch_mode.");
    return { kind: "continue", terminateInlineLoop: false };
  }
  if (reviewOutcome.review.decision !== "append_message_and_continue") {
    return { kind: "continue", terminateInlineLoop: false };
  }
  const injected = buildSupervisorInjectedMessage({
    supervisorMode: "hard",
    reviewTrigger: "agent_switch_mode_request",
    review: reviewOutcome.review,
    guidanceText: reviewOutcome.review.payload.message ?? "",
    messageTemplateName: reviewOutcome.review.payload.message_template,
    reasons: ["agent_switch_mode_request"],
    stopDetails: [],
    supervisorTriggers: args.supervisorTriggers,
  });
  if (!injected) {
    args.appendInlineError("Supervisor returned append_message_and_continue with no injectable message for configured switch_mode.");
    return { kind: "continue", terminateInlineLoop: false };
  }
  args.appendInlineMarkdown(renderChat(injected.messageType, injected.text));
  return { kind: "continue", terminateInlineLoop: false };
}
