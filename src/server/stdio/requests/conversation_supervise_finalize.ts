import { describeStopReasons, detectStopReasons } from "../helpers.js";
import type { ProviderPermissionProfile } from "../../../providers/types.js";
import type { BudgetState } from "../supervisor/agent_turn.js";
import { decideSupervisorTurn } from "../supervisor/turn_control.js";
import { persistAgentTurnWithoutSupervisor } from "../supervisor/no_supervisor_finalize.js";
import { emitSupervisorRunStart, emitSupervisorTurnDecision } from "../supervisor/supervise_notifications.js";
import {
  appendTurnTelemetry,
  buildTurnTelemetryBase,
  type TurnTelemetryEntry,
} from "../supervisor/telemetry.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import { runSupervisorReviewAndPersist } from "./conversation_supervise_review.js";
import { writeTurnTelemetrySafely } from "./conversation_supervise_runtime.js";
import type { RuntimeContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export async function finalizeSuperviseTurn(args: {
  ctx: RuntimeContext;
  workspaceRoot: string;
  conversationId: string;
  docPath: string;
  currentDocText: string;
  currentForkId: string;
  currentThreadId?: string;
  currentSupervisorThreadId?: string;
  switchActiveFork: (nextForkId: string) => void;
  turnForkId: string;
  turn: number;
  result: any;
  startedAt: number;
  budget: BudgetState;
  providerName: "mock" | "codex" | "claude";
  turnAgentModel: string;
  supervisorModel: string;
  shouldUseFullPrompt: boolean;
  promptBytes: number;
  sourceBytes: number;
  managedBytes: number;
  managedContextStats: any;
  parseErrorsCount: number;
  effectiveAgentModelReasoningEffort?: string;
  effectiveSupervisorModelReasoningEffort?: string;
  effectiveProviderBuiltinTools?: string[];
  effectiveSupervisor: any;
  disableSupervision: boolean;
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
  effectiveAgentRequirements: string[];
  effectiveAgentViolations: string[];
  effectiveSupervisorInstructions: string[];
  supervisorProviderName: "mock" | "codex" | "claude";
  effectiveSupervisorProviderOptions?: Record<string, unknown>;
  effectiveSupervisorConfiguredSystemMessage?: any;
  effectiveStopCondition: string;
  permissionProfile: ProviderPermissionProfile;
  effectiveHooks: any[];
  agentsText?: string;
  workspaceListingText?: string;
  taggedFiles: any[];
  openFiles: any[];
  utilities: any;
  skills: any[];
  skillsToInvoke: any[];
  skillInstructions: any[];
  fullResyncNeeded: boolean;
  persistedCadenceReviewStep?: any;
  timeBudgetMs: number;
  tokenBudgetAdjusted: number;
  cadenceTimeMs: number;
  cadenceTokensAdjusted: number;
}) {
  const reasons = detectStopReasons({
    assistantText: args.result.assistantText,
    usage: args.result.usage,
    startedAt: args.startedAt,
    supervisor: args.effectiveSupervisor,
    hadError: args.result.hadError,
    timeBudgetHit: args.budget.timeBudgetHit,
    tokenBudgetHit: args.budget.tokenBudgetHit,
    adjustedTokensUsed: args.budget.adjustedTokensUsed,
    elapsedMs: Date.now() - args.startedAt,
  });
  if (args.result.cadenceReason && !reasons.includes(args.result.cadenceReason)) reasons.push(args.result.cadenceReason);
  const hasBudgetReason = reasons.includes("time_budget") || reasons.includes("token_budget") || reasons.includes("cadence_time") || reasons.includes("cadence_tokens");
  if (args.result.interrupted && !hasBudgetReason && !reasons.includes("interrupted")) reasons.push("interrupted");
  if (args.result.streamEnded && !reasons.includes("agent_stop")) reasons.push("agent_stop");
  const stopDetails = describeStopReasons({ reasons, usage: args.result.usage, startedAt: args.startedAt, supervisor: args.effectiveSupervisor, hadError: args.result.hadError });
  const turnDecision = decideSupervisorTurn({ supervisorEnabled: Boolean(args.effectiveSupervisor.enabled), reasons, cadenceHit: args.result.cadenceHit, streamEnded: args.result.streamEnded, hadError: args.result.hadError, interrupted: args.result.interrupted });
  if (!args.disableSupervision) {
    emitSupervisorTurnDecision(args.ctx, { turn: args.turn, mode: turnDecision.supervisorMode ?? "none", reasons, streamEnded: args.result.streamEnded, cadenceHit: args.result.cadenceHit, hadError: args.result.hadError, interrupted: args.result.interrupted });
  }
  const baseTurnTelemetry = buildTurnTelemetryBase({
    conversationId: args.conversationId,
    forkId: args.turnForkId,
    turn: args.turn,
    provider: args.providerName,
    agentModel: args.turnAgentModel,
    supervisorModel: args.supervisorModel,
    promptMode: args.shouldUseFullPrompt ? "full" : "incremental",
    promptBytes: args.promptBytes,
    parseErrors: args.parseErrorsCount,
    agentReasoningEffort: args.effectiveAgentModelReasoningEffort,
    supervisorReasoningEffort: args.effectiveSupervisorModelReasoningEffort,
    providerBuiltinTools: args.effectiveProviderBuiltinTools,
    contextStrategy: args.managedContextStats.strategy,
    sourceBytes: args.sourceBytes,
    managedBytes: args.managedBytes,
    contextStats: args.managedContextStats,
    result: args.result,
    stopReasons: reasons,
    stopDetails,
    adjustedTokensUsed: args.budget.adjustedTokensUsed,
    elapsedMs: Date.now() - args.startedAt,
  });
  const writeTurnTelemetryWithSupervisor = async (supervisorTelemetry: TurnTelemetryEntry["supervisor"]) =>
    writeTurnTelemetrySafely({ ctx: args.ctx, workspaceRoot: args.workspaceRoot, conversationId: args.conversationId, entry: { ...baseTurnTelemetry, supervisor: supervisorTelemetry }, appendTurnTelemetry });
  if (!args.disableSupervision && reasons.length > 0) {
    args.ctx.sendNotification({ method: "conversation.status", params: { message: `supervisor stop: ${stopDetails.join("; ")}` } });
  }
  const supervisorMode = args.persistedCadenceReviewStep ? "soft" : turnDecision.supervisorMode;
  if (!args.effectiveSupervisor.enabled || !supervisorMode) {
    await writeTurnTelemetryWithSupervisor({ triggered: false, mode: turnDecision.supervisorMode ?? "none" });
    const persisted = await persistAgentTurnWithoutSupervisor({
      ctx: args.ctx,
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      currentDocText: args.currentDocText,
      currentForkId: args.currentForkId,
      docPath: args.docPath,
      agentRules: args.effectiveAgentRequirements,
      providerName: args.providerName,
      currentModel: args.turnAgentModel,
      supervisorModel: args.supervisorModel,
      currentThreadId: args.currentThreadId,
      currentSupervisorThreadId: args.currentSupervisorThreadId,
      switchActiveFork: args.switchActiveFork,
    });
    return {
      kind: "done" as const,
      reasons,
      stopDetails,
      status: args.result.hadError ? "error" : args.result.interrupted ? "stopped" : "done",
      nextDocText: persisted.nextDocText,
      nextForkId: persisted.nextForkId,
    };
  }
  emitSupervisorRunStart(args.ctx, { turn: args.turn, mode: supervisorMode, reasons, stopDetails });
  const supervisorPersist = await runSupervisorReviewAndPersist({
    ctx: args.ctx,
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    docPath: args.docPath,
    documentText: args.currentDocText,
    currentDocText: args.currentDocText,
    activeForkId: args.currentForkId,
    currentThreadId: args.currentThreadId,
    currentSupervisorThreadId: args.currentSupervisorThreadId,
    switchActiveFork: args.switchActiveFork,
    renderedRunConfig: args.renderedRunConfig,
    runConfigPath: args.runConfigPath,
    configBaseDir: args.configBaseDir,
    agentBaseDir: args.agentBaseDir,
    supervisorBaseDir: args.supervisorBaseDir,
    supervisorTriggers: args.supervisorTriggers,
    activeMode: args.activeMode,
    activeModePayload: args.activeModePayload,
    allowedNextModes: args.allowedNextModes,
    modePayloadFieldsByMode: args.modePayloadFieldsByMode,
    modeGuidanceByMode: args.modeGuidanceByMode,
    supervisorWorkspaceRoot: args.supervisorWorkspaceRoot,
    requestAgentRuleRequirements: args.requestAgentRuleRequirements,
    agentRules: args.effectiveAgentRequirements,
    agentRuleViolations: args.effectiveAgentViolations,
    supervisorInstructions: args.effectiveSupervisorInstructions,
    result: args.result,
    reasons,
    stopDetails,
    supervisorMode,
    supervisorProviderName: args.supervisorProviderName,
    supervisorProviderOptions: args.effectiveSupervisorProviderOptions,
    supervisor: args.effectiveSupervisor,
    supervisorModel: args.supervisorModel,
    currentModel: args.turnAgentModel,
    agentModelReasoningEffort: args.effectiveAgentModelReasoningEffort,
    supervisorModelReasoningEffort: args.effectiveSupervisorModelReasoningEffort,
    agentsText: args.agentsText,
    workspaceListingText: args.workspaceListingText ?? "",
    taggedFiles: args.taggedFiles,
    openFiles: args.openFiles,
    utilities: args.utilities,
    skills: args.skills,
    skillsToInvoke: args.skillsToInvoke,
    skillInstructions: args.skillInstructions,
    configuredSystemMessage: args.effectiveSupervisorConfiguredSystemMessage,
    permissionProfile: args.permissionProfile,
    stopCondition: args.effectiveStopCondition,
    hooks: args.effectiveHooks,
    startedAt: args.startedAt,
    budget: args.budget,
    timeBudgetMs: args.timeBudgetMs,
    tokenBudgetAdjusted: args.tokenBudgetAdjusted,
    cadenceTimeMs: args.cadenceTimeMs,
    cadenceTokensAdjusted: args.cadenceTokensAdjusted,
    providerName: args.providerName,
    fullResyncNeeded: args.fullResyncNeeded,
    turn: args.turn,
    precomputedReviewStep: args.persistedCadenceReviewStep,
  });
  await writeTurnTelemetryWithSupervisor({
    triggered: true,
    mode: supervisorMode,
    action: supervisorPersist.effectiveAction,
    resume: supervisorPersist.resume,
    edits: 0,
    appendEdits: 0,
    replaceEdits: 0,
    blocks: 0,
    violations: supervisorPersist.reviewFailedRulesCount,
    critique: supervisorPersist.reviewAdvice,
  });
  return {
    kind: "supervised" as const,
    reasons,
    stopDetails,
    supervisorPersist,
    nextDocText: supervisorPersist.nextDocText,
    nextThreadId: supervisorPersist.nextThreadId,
    nextSupervisorThreadId: supervisorPersist.nextSupervisorThreadId,
    fullResyncNeeded: supervisorPersist.fullResyncNeeded,
  };
}
