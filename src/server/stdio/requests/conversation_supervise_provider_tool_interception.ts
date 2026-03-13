import { renderToolResult } from "../../../markdown/render.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { BudgetState, ProviderToolInterceptionEvent, TurnResult as AgentTurnResult } from "../supervisor/agent_turn.js";
import { combineTranscript } from "../helpers.js";
import type { SupervisorConfig } from "../types.js";
import {
  matchInlineToolInterceptionInvocation,
  matchInlineToolInterceptionResponse,
  toolInterceptionContextForTool,
} from "./conversation_supervise_tool_interception.js";
import { runInlineToolInterceptionReview } from "./conversation_supervise_tool_interception_review.js";
import type { RuntimeContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export type ProcessProviderToolInterceptionsArgs = {
  ctx: RuntimeContext;
  workspaceRoot: string;
  docPath: string;
  conversationId: string;
  result: AgentTurnResult;
  currentDocText: string;
  currentThreadId?: string;
  currentSupervisorThreadId?: string;
  activeForkId: string;
  switchActiveFork: (nextForkId: string) => void;
  fullResyncNeeded: boolean;
  renderedRunConfig: RenderedRunConfig | null;
  runConfigPath?: string;
  configBaseDir: string;
  agentBaseDir: string;
  supervisorBaseDir: string;
  toolConfig?: NonNullable<RenderedRunConfig>["tools"];
  disableSupervision: boolean;
  effectiveSupervisor: SupervisorConfig;
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
};

export type ProviderToolInterceptionOutcome =
  | {
      kind: "none";
      currentDocText: string;
      currentThreadId?: string;
      currentSupervisorThreadId?: string;
      activeTransitionPayload: Record<string, string>;
      fullResyncNeeded: boolean;
    }
  | {
      kind: "continue";
      currentDocText: string;
      currentThreadId?: string;
      currentSupervisorThreadId?: string;
      activeTransitionPayload: Record<string, string>;
      fullResyncNeeded: boolean;
    }
  | {
      kind: "stop";
      currentDocText: string;
      nextForkId: string;
      stopReasons: string[];
      stopDetails: string[];
    };

function responseText(event: ProviderToolInterceptionEvent): string {
  return String(event.outputText ?? "");
}

export async function processProviderToolInterceptions(
  args: ProcessProviderToolInterceptionsArgs,
): Promise<ProviderToolInterceptionOutcome> {
  const providerToolEvents = Array.isArray(args.result.providerToolEvents) ? args.result.providerToolEvents : [];
  const rules = args.effectiveSupervisor.toolInterception?.rules;
  const interceptionEnabled =
    !args.disableSupervision
    && args.effectiveSupervisor.enabled !== false
    && Array.isArray(rules)
    && rules.length > 0;
  if (!interceptionEnabled || providerToolEvents.length === 0) {
    return {
      kind: "none",
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
  let matchedAny = false;

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
        ["(ok=false)", "", "[error]", String(message ?? "").trim()].join("\n"),
      ),
    );
  };

  for (const event of providerToolEvents) {
    const context = toolInterceptionContextForTool({
      toolName: event.toolName,
      toolArgs: event.args,
      toolConfig: args.toolConfig,
    });
    if (!context) continue;
    const match = event.when === "invocation"
      ? matchInlineToolInterceptionInvocation({ context, rules })
      : matchInlineToolInterceptionResponse({ context, rules, outputText: responseText(event) });
    if (!match) continue;
    matchedAny = true;
    const state = {
      currentDocText: nextDocText,
      currentThreadId: nextThreadId,
      currentSupervisorThreadId: nextSupervisorThreadId,
      activeTransitionPayload: nextTransitionPayload,
      fullResyncNeeded: nextResync,
    };
    const review = await runInlineToolInterceptionReview({
      ...args,
      match,
      state,
      appendInlineMarkdown,
      appendInlineError,
    });
    nextDocText = state.currentDocText;
    nextThreadId = state.currentThreadId;
    nextSupervisorThreadId = state.currentSupervisorThreadId;
    nextTransitionPayload = state.activeTransitionPayload;
    nextResync = state.fullResyncNeeded;
    if (review.kind === "stop") return review;
    if (review.terminateInlineLoop) {
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
  }

  if (!matchedAny) {
    return {
      kind: "none",
      currentDocText: nextDocText,
      currentThreadId: nextThreadId,
      currentSupervisorThreadId: nextSupervisorThreadId,
      activeTransitionPayload: nextTransitionPayload,
      fullResyncNeeded: nextResync,
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
