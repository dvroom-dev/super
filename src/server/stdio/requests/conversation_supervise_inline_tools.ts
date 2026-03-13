import { renderChat, renderToolResult } from "../../../markdown/render.js";
import type { SupervisorReviewResult } from "../../../supervisor/review_schema.js";
import { combineTranscript } from "../helpers.js";
import { replaceLastBlocks } from "../supervisor/fork_utils.js";
import { buildSupervisorInjectedMessage } from "../supervisor/supervisor_interjections.js";
import { persistAgentTurnWithoutSupervisor } from "../supervisor/no_supervisor_finalize.js";
import { runSupervisorReview } from "../supervisor/supervisor_run.js";
import { executeInlineToolCall } from "../supervisor/tool_calls.js";
import {
  applySupervisorForkDecision,
  buildSwitchModeSupervisorRequestMessage,
} from "./conversation_supervise_inline_mode_helpers.js";
import { applyInlineCheckSupervisorOutcome } from "./conversation_supervise_check_supervisor.js";
import {
  applySwitchModeRequestFork,
  parseSwitchModeInlineCall,
} from "./conversation_supervise_switch_mode.js";
import {
  inlineToolInterceptionContext,
  matchInlineToolInterceptionInvocation,
  matchInlineToolInterceptionResponse,
} from "./conversation_supervise_tool_interception.js";
import { runInlineToolInterceptionReview } from "./conversation_supervise_tool_interception_review.js";
import type { InlineToolCallOutcome, ProcessInlineToolCallsArgs } from "./conversation_supervise_inline_tools_types.js";

function normalizeInlineToolName(name: string): string {
  const trimmed = String(name ?? "").trim();
  const mcpPrefix = "mcp__super_custom_tools__";
  const normalized = trimmed.startsWith(mcpPrefix) ? trimmed.slice(mcpPrefix.length).trim() : trimmed;
  return normalized === "check_rules" ? "check_supervisor" : normalized;
}

export async function processInlineToolCalls(args: ProcessInlineToolCallsArgs): Promise<InlineToolCallOutcome> {
  const toolCalls = Array.isArray(args.result.toolCalls) ? args.result.toolCalls : [];
  if (!toolCalls.length) {
    return {
      kind: "continue",
      currentDocText: args.currentDocText,
      currentThreadId: args.currentThreadId,
      currentSupervisorThreadId: args.currentSupervisorThreadId,
      activeTransitionPayload: {},
      fullResyncNeeded: args.fullResyncNeeded,
    };
  }

  let nextDocText = args.currentDocText;
  let nextThreadId = args.currentThreadId;
  let nextSupervisorThreadId = args.currentSupervisorThreadId;
  let nextTransitionPayload: Record<string, string> = {};
  let nextResync = args.fullResyncNeeded;
  const appendInlineMarkdown = (markdown: string) => {
    args.ctx.sendNotification({ method: "conversation.append", params: { docPath: args.docPath, markdown } });
    const trimmed = markdown.trim();
    if (!trimmed) return;
    nextDocText = combineTranscript(nextDocText, [trimmed]);
    nextResync = true;
  };
  const appendInlineError = (message: string) => {
    appendInlineMarkdown(
      renderToolResult(
        [`(ok=false)`, "", `[error]`, String(message ?? "").trim()].join("\n"),
      ),
    );
  };

  const rulesCheckBaseContext = args.disableSupervision
    ? undefined
    : {
        workspaceRoot: args.workspaceRoot,
        conversationId: args.conversationId,
        agentRules: args.effectiveAgentRequirements,
        agentRuleViolations: args.effectiveAgentViolations,
        supervisorInstructions: args.effectiveSupervisorInstructions,
        providerName: args.supervisorProviderName,
        model: args.supervisorModel || args.currentModel,
        agentModel: args.currentModel,
        supervisorModel: args.supervisorModel,
        supervisorModelReasoningEffort: args.supervisorModelReasoningEffort,
        providerOptions: args.supervisorProviderOptions,
        trigger: "agent_check_supervisor" as const,
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
      };
  const toolInterceptionRules = args.effectiveSupervisor.toolInterception?.rules;
  const toolInterceptionEnabled = !args.disableSupervision && args.effectiveSupervisor.enabled !== false && Array.isArray(toolInterceptionRules) && toolInterceptionRules.length > 0;
  const runToolInterception = async (
    match: NonNullable<ReturnType<typeof matchInlineToolInterceptionInvocation>>,
    replaceWithInjectedMessage?: (markdown: string) => void,
  ) => {
    const interceptionState = {
      currentDocText: nextDocText,
      currentThreadId: nextThreadId,
      currentSupervisorThreadId: nextSupervisorThreadId,
      activeTransitionPayload: nextTransitionPayload,
      fullResyncNeeded: nextResync,
    };
    const review = await runInlineToolInterceptionReview({
      ...args,
      match,
      state: interceptionState,
      replaceWithInjectedMessage,
      appendInlineMarkdown,
      appendInlineError,
    });
    nextDocText = interceptionState.currentDocText;
    nextThreadId = interceptionState.currentThreadId;
    nextSupervisorThreadId = interceptionState.currentSupervisorThreadId;
    nextTransitionPayload = interceptionState.activeTransitionPayload;
    nextResync = interceptionState.fullResyncNeeded;
    return review;
  };
  const continueAfterInlineTermination = (): InlineToolCallOutcome => {
    args.budget.cadenceAnchorAt = Date.now();
    args.budget.cadenceTokensAnchor = args.budget.adjustedTokensUsed;
    return {
      kind: "continue",
      currentDocText: nextDocText,
      currentThreadId: nextThreadId,
      currentSupervisorThreadId: nextSupervisorThreadId,
      activeTransitionPayload: nextTransitionPayload,
      fullResyncNeeded: nextResync,
    };
  };

  let checkSupervisorReview: SupervisorReviewResult | undefined;
  for (let i = 0; i < toolCalls.length; i += 1) {
    const call = toolCalls[i];
    const toolName = normalizeInlineToolName(call.name);
    const switchParse = parseSwitchModeInlineCall({
      call,
      toolConfig: args.toolConfig,
    });
    if (toolName === "switch_mode" && switchParse.kind === "not_switch_mode") {
      appendInlineError(
        "switch_mode requests must come from the runtime CLI capture path. Inline/custom switch_mode tool calls are not supported.",
      );
      return continueAfterInlineTermination();
    }
    if (switchParse.kind === "error") {
      appendInlineMarkdown(switchParse.markdown);
      return continueAfterInlineTermination();
    }
    if (switchParse.kind === "request") {
      if (args.disableSupervision || args.effectiveSupervisor.enabled === false) {
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
          currentModel: args.currentModel,
          supervisorModel: args.supervisorModel,
          currentSupervisorThreadId: args.currentSupervisorThreadId,
          request: switchParse.request,
          sourceLabel: "agent",
        });
        if (direct.kind === "error") {
          appendInlineMarkdown(direct.markdown);
          return continueAfterInlineTermination();
        }
        return {
          kind: "continue",
          currentDocText: direct.docText,
          currentThreadId: direct.threadId,
          currentSupervisorThreadId: direct.supervisorThreadId,
          activeTransitionPayload: {},
          fullResyncNeeded: direct.fullResyncNeeded,
        };
      }

      const requestMessage = buildSwitchModeSupervisorRequestMessage({
        activeMode: args.activeMode,
        request: switchParse.request,
        allowedNextModes: args.allowedNextModes,
      });
      const reviewDocumentText = combineTranscript(nextDocText, [renderChat("user", requestMessage)]);
      const switchReview = await runSupervisorReview({
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
        threadId: nextSupervisorThreadId,
        timeoutMs: args.effectiveSupervisor.reviewTimeoutMs,
        disableSyntheticCheckSupervisorOnRuleFailure:
          args.effectiveSupervisor.disableSyntheticCheckSupervisorOnRuleFailure,
      });
      if (switchReview.threadId) nextSupervisorThreadId = switchReview.threadId;

      if (switchReview.review.decision === "stop_and_return") {
        const reason = switchReview.review.payload.reason || "switch_mode request requested stop";
        const persisted = await persistAgentTurnWithoutSupervisor({
          ctx: args.ctx,
          workspaceRoot: args.workspaceRoot,
          conversationId: args.conversationId,
          currentDocText: nextDocText,
          currentForkId: args.activeForkId,
          docPath: args.docPath,
          agentRules: args.effectiveAgentRequirements,
          providerName: args.providerName,
          currentModel: args.currentModel,
          supervisorModel: args.supervisorModel,
          currentThreadId: args.currentThreadId,
          currentSupervisorThreadId: nextSupervisorThreadId,
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

      const forkedFromSwitch = await applySupervisorForkDecision({
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
        review: switchReview.review,
        reasonLabel: "agent_switch_mode_request",
        detailLabel: "switch_mode request triggered fork",
        startedAt: args.startedAt,
        budget: args.budget,
        providerName: args.providerName,
        currentModel: args.currentModel,
        supervisorModel: args.supervisorModel,
        currentDocText: nextDocText,
        currentThreadId: nextThreadId,
        currentSupervisorThreadId: nextSupervisorThreadId,
        currentAssistantText: args.result.assistantText,
        currentAgentRequestMessage: requestMessage,
        transitionTrigger: "agent_switch_mode_request",
      });
      if (forkedFromSwitch) {
        return {
          kind: "continue",
          currentDocText: forkedFromSwitch.docText,
          currentThreadId: forkedFromSwitch.threadId,
          currentSupervisorThreadId: forkedFromSwitch.supervisorThreadId,
          activeTransitionPayload: forkedFromSwitch.activeTransitionPayload,
          fullResyncNeeded: forkedFromSwitch.fullResyncNeeded,
        };
      }
      if (
        switchReview.review.decision === "fork_new_conversation"
        || switchReview.review.decision === "resume_mode_head"
      ) {
        appendInlineError("Supervisor requested an invalid mode branch transition for switch_mode request.");
        return continueAfterInlineTermination();
      }

      if (switchReview.review.decision === "append_message_and_continue") {
        const injected = buildSupervisorInjectedMessage({
          supervisorMode: "hard",
          reviewTrigger: "agent_switch_mode_request",
          review: switchReview.review,
          guidanceText: switchReview.review.payload.message ?? "",
          messageTemplateName: switchReview.review.payload.message_template,
          reasons: ["agent_switch_mode_request"],
          stopDetails: [],
          supervisorTriggers: args.supervisorTriggers,
        });
        if (!injected) {
          appendInlineError("Supervisor returned append_message_and_continue with no injectable message.");
          return continueAfterInlineTermination();
        } else {
          const remainingToolCalls = toolCalls.length - i;
          nextDocText = replaceLastBlocks(
            nextDocText,
            remainingToolCalls,
            renderChat(injected.messageType, injected.text),
            ["tool_call"],
          );
          nextResync = true;
          args.ctx.sendNotification({
            method: "conversation.replace",
            params: { docPath: args.docPath, documentText: nextDocText },
          });
        }
      }

      if (switchReview.review.decision === "continue") {
        const accepted = await applySwitchModeRequestFork({
          ctx: args.ctx,
          workspaceRoot: args.workspaceRoot,
          docPath: args.docPath,
          conversationId: args.conversationId,
          activeForkId: args.activeForkId,
          switchActiveFork: args.switchActiveFork,
          renderedRunConfig: args.renderedRunConfig,
          requestAgentRuleRequirements: args.requestAgentRuleRequirements,
          activeMode: args.activeMode,
          allowedNextModes: args.allowedNextModes,
          modePayloadFieldsByMode: args.modePayloadFieldsByMode,
          runConfigPath: args.runConfigPath,
          configBaseDir: args.configBaseDir,
          agentBaseDir: args.agentBaseDir,
          supervisorBaseDir: args.supervisorBaseDir,
          budget: args.budget,
          providerName: args.providerName,
          currentModel: args.currentModel,
          supervisorModel: args.supervisorModel,
          currentSupervisorThreadId: nextSupervisorThreadId,
          request: switchParse.request,
          sourceLabel: "agent",
        });
        if (accepted.kind === "error") {
          appendInlineMarkdown(accepted.markdown);
          return continueAfterInlineTermination();
        }
        return {
          kind: "continue",
          currentDocText: accepted.docText,
          currentThreadId: accepted.threadId,
          currentSupervisorThreadId: accepted.supervisorThreadId,
          activeTransitionPayload:
            switchReview.review.transition_payload && typeof switchReview.review.transition_payload === "object"
              ? { ...switchReview.review.transition_payload }
              : {},
          fullResyncNeeded: accepted.fullResyncNeeded,
        };
      }

      args.budget.cadenceAnchorAt = Date.now();
      args.budget.cadenceTokensAnchor = args.budget.adjustedTokensUsed;
      return {
        kind: "continue",
        currentDocText: nextDocText,
        currentThreadId: nextThreadId,
        currentSupervisorThreadId: nextSupervisorThreadId,
        activeTransitionPayload: nextTransitionPayload,
        fullResyncNeeded: nextResync,
      };
    }

    const interceptContext = inlineToolInterceptionContext({
      call,
      toolConfig: args.toolConfig,
    });
    const invocationMatch = toolInterceptionEnabled ? matchInlineToolInterceptionInvocation({ context: interceptContext, rules: toolInterceptionRules }) : undefined;
    if (invocationMatch) {
      const interceptReview = await runToolInterception(
        invocationMatch,
        (markdown) => {
          const remainingToolCalls = toolCalls.length - i;
          nextDocText = replaceLastBlocks(
            nextDocText,
            remainingToolCalls,
            markdown,
            ["tool_call"],
          );
          nextResync = true;
          args.ctx.sendNotification({
            method: "conversation.replace",
            params: { docPath: args.docPath, documentText: nextDocText },
          });
        },
      );
      if (interceptReview.kind === "stop") {
        return interceptReview;
      }
      if (interceptReview.terminateInlineLoop) {
        return continueAfterInlineTermination();
      }
    }

    const execution = await executeInlineToolCall({
      call,
      workspaceRoot: args.workspaceRoot,
      toolWorkspaceRoot: args.agentWorkspaceRoot,
      conversationId: args.conversationId,
      toolOutput: args.toolOutput,
      toolConfig: args.toolConfig,
      rulesCheck: rulesCheckBaseContext
        ? { ...rulesCheckBaseContext, documentText: nextDocText, threadId: nextSupervisorThreadId }
        : undefined,
    });
    appendInlineMarkdown(execution.markdown);
    if (execution.supervisorThreadId) nextSupervisorThreadId = execution.supervisorThreadId;
    if (execution.supervisorReview) checkSupervisorReview = execution.supervisorReview;
    const responseOutputText = [String(execution.output ?? "").trim(), execution.error ? `[error]\n${execution.error}` : ""].filter(Boolean).join("\n\n").trim();
    const responseMatch = toolInterceptionEnabled ? matchInlineToolInterceptionResponse({ context: interceptContext, rules: toolInterceptionRules, outputText: responseOutputText }) : undefined;
    if (responseMatch) {
      const interceptReview = await runToolInterception(
        responseMatch,
        (markdown) => {
          const remainingToolCalls = toolCalls.length - i;
          nextDocText = replaceLastBlocks(nextDocText, remainingToolCalls, "", ["tool_call"]);
          nextDocText = replaceLastBlocks(nextDocText, 1, markdown, ["tool_result"]);
          nextResync = true;
          args.ctx.sendNotification({
            method: "conversation.replace",
            params: { docPath: args.docPath, documentText: nextDocText },
          });
        },
      );
      if (interceptReview.kind === "stop") {
        return interceptReview;
      }
      if (interceptReview.terminateInlineLoop) {
        return continueAfterInlineTermination();
      }
    }
  }

  const checkSupervisorState = {
    currentDocText: nextDocText,
    currentThreadId: nextThreadId,
    currentSupervisorThreadId: nextSupervisorThreadId,
    activeTransitionPayload: nextTransitionPayload,
    fullResyncNeeded: nextResync,
  };
  const checkSupervisorOutcome = await applyInlineCheckSupervisorOutcome({
    review: checkSupervisorReview,
    state: checkSupervisorState,
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
    startedAt: args.startedAt,
    budget: args.budget,
    providerName: args.providerName,
    currentModel: args.currentModel,
    supervisorModel: args.supervisorModel,
    effectiveAgentRequirements: args.effectiveAgentRequirements,
  });
  nextDocText = checkSupervisorState.currentDocText;
  nextThreadId = checkSupervisorState.currentThreadId;
  nextSupervisorThreadId = checkSupervisorState.currentSupervisorThreadId;
  nextTransitionPayload = checkSupervisorState.activeTransitionPayload;
  nextResync = checkSupervisorState.fullResyncNeeded;
  if (checkSupervisorOutcome.kind === "stop") return checkSupervisorOutcome;

  args.budget.cadenceAnchorAt = Date.now();
  args.budget.cadenceTokensAnchor = args.budget.adjustedTokensUsed;
  return {
    kind: "continue",
    currentDocText: nextDocText,
    currentThreadId: nextThreadId,
    currentSupervisorThreadId: nextSupervisorThreadId,
    activeTransitionPayload: nextTransitionPayload,
    fullResyncNeeded: nextResync,
  };
}
