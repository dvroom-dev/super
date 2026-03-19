import type { SupervisorReviewResult } from "../../../supervisor/review_schema.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { BudgetState } from "../supervisor/agent_turn.js";
import { persistAgentTurnWithoutSupervisor } from "../supervisor/no_supervisor_finalize.js";
import { applySupervisorForkDecision } from "./conversation_supervise_inline_mode_helpers.js";
import type { RuntimeContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

type InlineState = {
  currentDocText: string;
  currentThreadId?: string;
  currentSupervisorThreadId?: string;
  activeTransitionPayload: Record<string, string>;
  fullResyncNeeded: boolean;
};

type InlineCheckSupervisorOutcome =
  | {
      kind: "continue";
    }
  | {
      kind: "stop";
      currentDocText: string;
      nextForkId: string;
      stopReasons: string[];
      stopDetails: string[];
    };

export async function applyInlineCheckSupervisorOutcome(args: {
  review: SupervisorReviewResult | undefined;
  reviewTrigger?: "agent_check_supervisor" | "agent_wrapup_certification_request";
  stopReason?: string;
  reasonLabel?: string;
  detailLabel?: string;
  state: InlineState;
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
  startedAt: number;
  budget: BudgetState;
  providerName: "mock" | "codex" | "claude";
  supervisorProviderName: "mock" | "codex" | "claude";
  currentModel: string;
  supervisorModel: string;
  effectiveAgentRequirements: string[];
}): Promise<InlineCheckSupervisorOutcome> {
  if (!args.review) return { kind: "continue" };
  const reviewTrigger = args.reviewTrigger ?? "agent_check_supervisor";
  const stopReason = args.stopReason ?? "check_supervisor";
  const reasonLabel = args.reasonLabel ?? "check_supervisor";
  const detailLabel = args.detailLabel ?? "check_supervisor requested fork";
  if (args.review.decision === "stop_and_return") {
    const reason = args.review.payload.reason || `${stopReason} requested stop`;
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
      stopReasons: [stopReason],
      stopDetails: [reason],
    };
  }
  if (args.review.decision !== "fork_new_conversation" && args.review.decision !== "resume_mode_head") {
    if (args.review.decision === "continue" && args.review.transition_payload) {
      args.state.activeTransitionPayload = { ...args.review.transition_payload };
      args.state.fullResyncNeeded = true;
    }
    return { kind: "continue" };
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
    review: args.review,
    reasonLabel,
    detailLabel,
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
  if (!switchFork) return { kind: "continue" };
  args.state.currentDocText = switchFork.docText;
  args.state.currentThreadId = switchFork.threadId;
  args.state.currentSupervisorThreadId = switchFork.supervisorThreadId;
  args.state.activeTransitionPayload = switchFork.activeTransitionPayload;
  args.state.fullResyncNeeded = switchFork.fullResyncNeeded;
  return { kind: "continue" };
}
