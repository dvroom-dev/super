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
  applyInferredSwitchModeRequestFork,
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

export async function processInlineToolCalls(args: ProcessInlineToolCallsArgs): Promise<InlineToolCallOutcome> {
  const toolCalls = Array.isArray(args.result.toolCalls) ? args.result.toolCalls : [];
  if (!toolCalls.length) {
    return {
      kind: "continue",
      currentDocText: args.currentDocText,
      currentThreadId: args.currentThreadId,
      currentSupervisorThreadId: args.currentSupervisorThreadId,
      fullResyncNeeded: args.fullResyncNeeded,
    };
  }

  let nextDocText = args.currentDocText;
  let nextThreadId = args.currentThreadId;
  let nextSupervisorThreadId = args.currentSupervisorThreadId;
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
    nextResync = interceptionState.fullResyncNeeded;
    return review;
  };
  const continueAfterInlineTermination = (): InlineToolCallOutcome => {
    args.budget.cadenceAnchorAt = Date.now();
    args.budget.cadenceTokensAnchor = args.budget.adjustedTokensUsed;
    return { kind: "continue", currentDocText: nextDocText, currentThreadId: nextThreadId, currentSupervisorThreadId: nextSupervisorThreadId, fullResyncNeeded: nextResync };
  };

  let checkSupervisorReview: SupervisorReviewResult | undefined;
  for (let i = 0; i < toolCalls.length; i += 1) {
    const call = toolCalls[i];
    const switchParse = parseSwitchModeInlineCall({
      call,
      toolConfig: args.toolConfig,
    });
    if (switchParse.kind === "error") {
      const inferredDirect = await applyInferredSwitchModeRequestFork({
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
        assistantText: args.result.assistantText,
        sourceLabel: "agent",
      });
      if (inferredDirect?.kind === "switched") {
        return {
          kind: "continue",
          currentDocText: inferredDirect.docText,
          currentThreadId: inferredDirect.threadId,
          currentSupervisorThreadId: inferredDirect.supervisorThreadId,
          fullResyncNeeded: inferredDirect.fullResyncNeeded,
        };
      }
      appendInlineMarkdown(switchParse.markdown);
      continue;
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
          continue;
        }
        return { kind: "continue", currentDocText: direct.docText, currentThreadId: direct.threadId, currentSupervisorThreadId: direct.supervisorThreadId, fullResyncNeeded: direct.fullResyncNeeded };
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
        return { kind: "continue", currentDocText: forkedFromSwitch.docText, currentThreadId: forkedFromSwitch.threadId, currentSupervisorThreadId: forkedFromSwitch.supervisorThreadId, fullResyncNeeded: forkedFromSwitch.fullResyncNeeded };
      }
      if (
        switchReview.review.decision === "fork_new_conversation"
        || switchReview.review.decision === "resume_mode_head"
      ) {
        appendInlineError("Supervisor requested an invalid mode branch transition for switch_mode request.");
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

      args.budget.cadenceAnchorAt = Date.now();
      args.budget.cadenceTokensAnchor = args.budget.adjustedTokensUsed;
      return { kind: "continue", currentDocText: nextDocText, currentThreadId: nextThreadId, currentSupervisorThreadId: nextSupervisorThreadId, fullResyncNeeded: nextResync };
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
  nextResync = checkSupervisorState.fullResyncNeeded;
  if (checkSupervisorOutcome.kind === "stop") return checkSupervisorOutcome;

  args.budget.cadenceAnchorAt = Date.now();
  args.budget.cadenceTokensAnchor = args.budget.adjustedTokensUsed;
  return { kind: "continue", currentDocText: nextDocText, currentThreadId: nextThreadId, currentSupervisorThreadId: nextSupervisorThreadId, fullResyncNeeded: nextResync };
}
