import path from "node:path";
import type { ProviderPermissionProfile } from "../../../providers/types.js";
import { toolDefinitionsMarkdown } from "../../../tools/definitions.js";
import { compileFullPrompt, compileIncrementalPrompt } from "../../../supervisor/compile.js";
import { combineTranscript, normalizeRules, normalizeFileContexts } from "../helpers.js";
import { loadAgentsInstructions, workspaceListing, taggedFileContexts } from "../workspace.js";
import { getUtilities } from "../utilities.js";
import { loadSkills } from "../../../skills/loader.js";
import { newId } from "../../../utils/ids.js";
import type { SupervisorConfig } from "../types.js";
import { loadForkSafe, selectBaseForkId } from "./common.js";
import type { RuntimeContext } from "./context.js";
import { type BudgetState } from "../supervisor/agent_turn.js";
import { emitSuperviseTurnSettings } from "../supervisor/supervise_notifications.js";
import { sendBudgetUpdateNotification } from "../supervisor/budget.js";
import { loadRunConfigForDirectory, renderRunConfig } from "../../../supervisor/run_config.js";
import { loadLastTurnTelemetryTurn } from "../supervisor/telemetry.js";
import { promptContentByteLength } from "../../../utils/prompt_content.js";
import { applySdkBuiltinToolsToProviderOptions } from "../../../providers/sdk_builtin_tools.js";
import { resolveProviderFilesystemPolicy } from "../../../providers/filesystem_permissions.js";
import { mergeInstructionLists, mergeAgentRuleSet, modeGuidanceByMode, modePayloadFieldsByMode, resolveActiveMode, resolveModeConfig, resolveModePayload, resolveModeReasoningEfforts } from "../supervisor/mode_runtime.js";
import { resolveConfiguredSystemMessage } from "../supervisor/system_message_runtime.js";
import { processInlineToolCalls, runAgentTurnWithHooks } from "./conversation_supervise_steps.js";
import { applyTurnTransitions } from "./conversation_supervise_transition.js";
import { finalizeSuperviseTurn } from "./conversation_supervise_finalize.js";
import { runSupervisorSchemaPreflight } from "../supervisor/schema_preflight.js";
import { createCadenceParallelController } from "./cadence_parallel.js";
import { mergeSdkBuiltinTools } from "../../../supervisor/run_config_sdk_builtin_tools.js";
import { allowedNextModesFor, createRunLifecycle, shouldUseFullPromptForSupervise } from "./conversation_supervise_runtime.js";
import { buildManagedSuperviseContext, emitManagedSuperviseContextStats } from "./conversation_supervise_context.js";
export { shouldUseFullPromptForSupervise } from "./conversation_supervise_runtime.js"; export async function handleConversationSupervise(ctx: RuntimeContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  const agentWorkspaceRoot = path.resolve(workspaceRoot, String((params as any)?.agentBaseDir ?? workspaceRoot));
  const docPath = String((params as any)?.docPath ?? "untitled");
  const documentText = String((params as any)?.documentText ?? "");
  const conversationId = await ctx.store.conversationIdFromDocument(docPath, documentText);
  const models = Array.isArray((params as any)?.models) ? (params as any).models.map((m: any) => String(m)) : [];
  const providerName = String((params as any)?.provider ?? "codex") as any;
  const supervisorProviderName = String((params as any)?.supervisorProvider ?? providerName) as any;
  const agentProviderOptions = (params as any)?.agentProviderOptions as Record<string, unknown> | undefined; const supervisorProviderOptions = (params as any)?.supervisorProviderOptions as Record<string, unknown> | undefined;
  const sandboxMode = String((params as any)?.sandboxMode ?? "workspace-write"); const requestAgentRuleRequirements = normalizeRules((params as any)?.agentRules);
  const legacyReasoningEffort = (params as any)?.modelReasoningEffort ? String((params as any).modelReasoningEffort) : undefined;
  const agentModelReasoningEffort = (params as any)?.agentModelReasoningEffort ? String((params as any).agentModelReasoningEffort) : legacyReasoningEffort;
  const supervisorModelReasoningEffort = (params as any)?.supervisorModelReasoningEffort ? String((params as any).supervisorModelReasoningEffort) : agentModelReasoningEffort;
  const disableSupervision = Boolean((params as any)?.disableSupervision ?? false); const disableHooks = Boolean((params as any)?.disableHooks ?? false);
  const permissionProfile: ProviderPermissionProfile = Boolean((params as any)?.yolo ?? false) ? "yolo" : "workspace_no_network";
  const cycleLimitRaw = (params as any)?.cycleLimit;
  const cycleLimitNumber = cycleLimitRaw == null ? NaN : Number(cycleLimitRaw);
  const cycleLimit = cycleLimitRaw == null ? undefined : Math.floor(cycleLimitNumber);
  if (cycleLimitRaw != null && (!Number.isFinite(cycleLimitNumber) || (cycleLimit ?? 0) <= 0)) throw new Error("cycleLimit must be a positive number");
  const runConfigPath = typeof (params as any)?.runConfigPath === "string" ? String((params as any).runConfigPath) : undefined;
  const supervisor: SupervisorConfig = (params as any)?.supervisor ?? {};
  const toolOutput = (params as any)?.toolOutput ?? null;
  const configBaseDir = path.resolve(workspaceRoot, String((params as any)?.configBaseDir ?? workspaceRoot));
  const runConfig = await loadRunConfigForDirectory(workspaceRoot, { explicitConfigPath: runConfigPath });
  const supervisorWorkspaceRoot = path.resolve(workspaceRoot, String((params as any)?.supervisorBaseDir ?? path.join(workspaceRoot, runConfig?.supervisor?.workspaceSubdir ?? ".ai-supervisor/supervisor", conversationId)));
  const initialRunConfig = await renderRunConfig(runConfig, { configBaseDir, agentBaseDir: agentWorkspaceRoot, supervisorBaseDir: supervisorWorkspaceRoot });
  const agentsMd = await loadAgentsInstructions(agentWorkspaceRoot);
  const workspaceListingText = await workspaceListing(agentWorkspaceRoot);
  const taggedFiles = await taggedFileContexts(agentWorkspaceRoot, documentText);
  const openFiles = normalizeFileContexts((params as any)?.openFiles);
  const utilities = await getUtilities(ctx.state);
  const supervisorBase: SupervisorConfig = { ...(initialRunConfig?.supervisor ?? {}), ...supervisor };
  const skillsOutcome = await loadSkills(agentWorkspaceRoot);
  const skills = skillsOutcome.skills;
  const skillsToInvoke: typeof skills = [];
  const skillInstructions: any[] = [];
  const agentsText = agentsMd;
  if (!models.length) throw new Error("models[] required"); if (models.length > 1) throw new Error("conversation.supervise supports a single model only"); if (!documentText.trim()) throw new Error("documentText required");
  const model = models[0];
  const supervisorModel = String((params as any)?.supervisorModel ?? model);
  const idx = await ctx.store.loadIndex(workspaceRoot, conversationId);
  const docForkId = ctx.store.forkIdFromDocument(documentText);
  const explicitBaseForkId = typeof (params as any)?.baseForkId === "string" ? String((params as any).baseForkId) : undefined;
  const baseForkId = selectBaseForkId({ explicitBaseForkId, docForkId, indexHeadId: idx.headId, knownForkIds: idx.forks.map((fork) => fork.id) });
  let base = baseForkId ? await loadForkSafe(ctx, workspaceRoot, conversationId, baseForkId) : undefined;
  if (!base && idx.headId && idx.headId !== baseForkId) base = await loadForkSafe(ctx, workspaceRoot, conversationId, idx.headId);
  // Cache-sensitive transcript blocks must stay byte-stable across resume.
  // Re-render config for future decisions, but never rewrite already-persisted
  // system/user conversation text when loading the current document.
  const historyEdited = base ? ctx.store.isHistoryEdited(base.documentText ?? "", documentText) : true;
  const preferReuse = !historyEdited && base?.providerThreadId;
  const threadIdToReuse = preferReuse ? base?.providerThreadId : undefined;
  const supervisorThreadIdToReuse = !historyEdited ? base?.supervisorThreadId : undefined;
  const fork = await ctx.store.createFork({
    workspaceRoot,
    conversationId,
    parentId: base?.id,
    documentText,
    forkId: base ? undefined : docForkId,
    agentRules: [...requestAgentRuleRequirements, ...(initialRunConfig?.agentRules.requirements ?? [])],
    providerName,
    model,
    providerThreadId: threadIdToReuse,
    supervisorThreadId: supervisorThreadIdToReuse,
    actionSummary: "supervise:start",
    agentModel: model,
    supervisorModel,
  });
  ctx.sendNotification({ method: "fork.created", params: { conversationId, forkId: fork.id, headId: fork.id } });
  const activeRuns = (ctx.state.activeRuns = ctx.state.activeRuns ?? {}), activeRunsByForkId = (ctx.state.activeRunsByForkId = ctx.state.activeRunsByForkId ?? {}), activeRunMeta = (ctx.state.activeRunMeta = ctx.state.activeRunMeta ?? {});
  const lifecycle = createRunLifecycle({ ctx, docPath, conversationId, activeRuns, activeRunsByForkId, activeRunMeta, activeForkId: fork.id });
  ctx.sendNotification({ method: "conversation.run_started", params: { conversationId, forkId: fork.id, docPath } });
  let currentDocText = documentText;
  let currentThreadId: string | undefined = threadIdToReuse;
  let currentSupervisorThreadId: string | undefined = supervisorThreadIdToReuse;
  let fullResyncNeeded = historyEdited;
  let currentModel = model;
  let turnIndex = await loadLastTurnTelemetryTurn(workspaceRoot, conversationId);
  let cycleTurnCount = 0;
  const startedAt = Date.now();
  const timeBudgetMs = disableSupervision ? 0 : (supervisorBase.timeBudgetMs ?? 0), tokenBudgetAdjusted = disableSupervision ? 0 : (supervisorBase.tokenBudgetAdjusted ?? 0);
  const cadenceTimeMs = disableSupervision ? 0 : (supervisorBase.cadenceTimeMs ?? 0), cadenceTokensAdjusted = disableSupervision ? 0 : (supervisorBase.cadenceTokensAdjusted ?? 0);
  const pricing = supervisorBase.pricing;
  const budget: BudgetState = {
    startedAt,
    timeBudgetMs,
    tokenBudgetAdjusted,
    cadenceTimeMs,
    cadenceTokensAdjusted,
    adjustedTokensUsed: 0,
    budgetMultiplier: 1,
    cadenceAnchorAt: startedAt,
    cadenceTokensAnchor: 0,
    timeBudgetHit: false,
    tokenBudgetHit: false,
  };
  const sendBudgetUpdate = () => sendBudgetUpdateNotification({ ctx, startedAt, budget, currentModel, supervisorModel, timeBudgetMs, tokenBudgetAdjusted, cadenceTimeMs, cadenceTokensAdjusted });
  let stopReasons: string[] = [], stopDetails: string[] = [];
  const renderedRunConfig = initialRunConfig;
  const runtimeStateForDocument = (docText: string) => ({
    activeMode: resolveActiveMode(docText, renderedRunConfig),
    activeModePayload: resolveModePayload(docText),
  });
  let supervisorSchemaPreflightDone = false;
  try {
    while (true) {
    const turnForkId = lifecycle.currentForkId();
    const turnAgentModel = currentModel;
    const effectiveCycleLimit = cycleLimit ?? renderedRunConfig?.cycleLimit;
    if (effectiveCycleLimit && cycleTurnCount >= effectiveCycleLimit) {
      stopReasons = ["cycle_limit"]; stopDetails = [`cycle limit reached (${effectiveCycleLimit})`];
      ctx.sendNotification({ method: "conversation.status", params: { message: stopDetails[0] } });
      lifecycle.finishRun("stopped");
      return { conversationId, forkId: lifecycle.currentForkId(), mode: "supervise", stopReasons, stopDetails, ...runtimeStateForDocument(currentDocText) };
    }
    const activeMode = resolveActiveMode(currentDocText, renderedRunConfig), modeConfig = resolveModeConfig(renderedRunConfig, activeMode);
    const { agentModelReasoningEffort: effectiveAgentModelReasoningEffort, supervisorModelReasoningEffort: effectiveSupervisorModelReasoningEffort } = resolveModeReasoningEfforts({ modeConfig, defaultAgentReasoningEffort: agentModelReasoningEffort, defaultSupervisorReasoningEffort: supervisorModelReasoningEffort });
    const effectiveToolConfig = modeConfig?.tools ?? renderedRunConfig?.tools;
    const activeModePayload = resolveModePayload(currentDocText);
    const effectiveAgentConfiguredSystemMessage = resolveConfiguredSystemMessage({
      configuredSystemMessage: modeConfig?.systemMessage ?? renderedRunConfig?.systemMessage,
      modePayload: activeModePayload,
    });
    const effectiveSupervisorConfiguredSystemMessage = resolveConfiguredSystemMessage({
      configuredSystemMessage: renderedRunConfig?.supervisorSystemMessage, modePayload: activeModePayload,
    });
    const effectiveHooks = disableHooks ? [] : (renderedRunConfig?.hooks ?? []);
    const effectiveAgentRuleSet = mergeAgentRuleSet({
      requestRequirements: requestAgentRuleRequirements,
      configured: modeConfig?.agentRules ?? renderedRunConfig?.agentRules,
    });
    const effectiveAgentRequirements = effectiveAgentRuleSet.requirements;
    const effectiveAgentViolations = effectiveAgentRuleSet.violations;
    const effectiveSupervisorInstructions = mergeInstructionLists([], modeConfig?.supervisorInstructions ?? renderedRunConfig?.supervisorInstructions ?? []);
    const effectiveStopCondition = (supervisorBase.stopCondition ?? renderedRunConfig?.stopCondition ?? "").trim();
    const effectiveSdkBuiltinTools = mergeSdkBuiltinTools(
      renderedRunConfig?.sdkBuiltinTools,
      effectiveToolConfig?.providerBuiltinTools,
    );
    const effectiveProviderBuiltinTools = effectiveSdkBuiltinTools?.[providerName as keyof typeof effectiveSdkBuiltinTools]?.names;
    const effectiveAgentProviderOptions = applySdkBuiltinToolsToProviderOptions({
      provider: providerName,
      providerOptions: agentProviderOptions,
      sdkBuiltinTools: effectiveSdkBuiltinTools,
      label: "tools.provider_builtin_tools",
    });
    const effectiveSupervisorProviderOptions = supervisorProviderOptions;
    const effectiveAgentFilesystemPolicy = resolveProviderFilesystemPolicy({
      provider: providerName,
      policies: effectiveToolConfig?.providerFilesystem,
      label: "tools.provider_filesystem",
    });
    const effectiveSupervisor: SupervisorConfig = disableSupervision
      ? { ...supervisorBase, enabled: false, timeBudgetMs: 0, tokenBudgetAdjusted: 0, cadenceTimeMs: 0, cadenceTokensAdjusted: 0 }
      : { ...supervisorBase, enabled: supervisorBase.enabled ?? true };
    const allowedNextModes = allowedNextModesFor({ renderedRunConfig, activeMode });
    const modePayloadFields = modePayloadFieldsByMode(renderedRunConfig, allowedNextModes);
    const modeGuidance = modeGuidanceByMode(renderedRunConfig, allowedNextModes, activeMode);
    if (!disableSupervision && effectiveSupervisor.enabled !== false && !effectiveStopCondition) throw new Error("supervised runs require supervisor.stop_condition in config.yaml");
    if (!supervisorSchemaPreflightDone && !disableSupervision && effectiveSupervisor.enabled !== false) { await runSupervisorSchemaPreflight({ supervisorWorkspaceRoot, providerName: supervisorProviderName, supervisorModel, supervisorModelReasoningEffort: effectiveSupervisorModelReasoningEffort, permissionProfile, supervisorProviderOptions: effectiveSupervisorProviderOptions, allowedNextModes, modePayloadFieldsByMode: modePayloadFields, supervisorTriggers: renderedRunConfig?.supervisorTriggers, timeoutMs: effectiveSupervisor.reviewTimeoutMs }); supervisorSchemaPreflightDone = true; }
    const managedContext = await buildManagedSuperviseContext({ documentText: currentDocText, workspaceRoot, conversationId, strategy: renderedRunConfig?.contextManagementStrategy });
    const shouldUseFullPrompt = shouldUseFullPromptForSupervise(fullResyncNeeded, currentThreadId);
    const compileArgs = { documentText: managedContext.documentText, workspaceRoot, provider: providerName, agentRules: effectiveAgentRequirements, currentMode: activeMode, allowedNextModes, modePayloadFieldsByMode: modePayloadFields, modeGuidanceByMode: modeGuidance, availableToolsMarkdown: toolDefinitionsMarkdown(effectiveToolConfig), agentRuleViolations: effectiveAgentViolations, model: currentModel, agentsMd: agentsText, workspaceListing: workspaceListingText, taggedFiles, openFiles, utilities, skills, skillsToInvoke, skillInstructions, configuredSystemMessage: effectiveAgentConfiguredSystemMessage, defaultSystemMessage: disableSupervision ? undefined : renderedRunConfig?.supervisor?.agentDefaultSystemMessage };
    const compile = shouldUseFullPrompt ? compileFullPrompt(compileArgs) : compileIncrementalPrompt(compileArgs);
    const sourceBytes = Buffer.byteLength(currentDocText, "utf8");
    const managedBytes = Buffer.byteLength(managedContext.documentText, "utf8");
    const promptBytes = promptContentByteLength(compile.prompt);
    emitManagedSuperviseContextStats({ ctx, docPath, contextLimit: supervisor.contextLimit ?? null, sourceBytes, managedBytes, managedContext, fullPrompt: shouldUseFullPrompt });
    if (compile.parseErrors.length) ctx.sendNotification({ method: "log", params: { level: "warn", message: `Parse warnings: ${compile.parseErrors.join("; ")}` } });
    const cadenceController = createCadenceParallelController({ ctx, disableSupervision, effectiveSupervisor, renderedRunConfig, workspaceRoot, conversationId, documentText, currentDocText, currentSupervisorThreadId, effectiveAgentRequirements, effectiveAgentViolations, effectiveSupervisorInstructions, supervisorProviderName, effectiveSupervisorProviderOptions, permissionProfile, supervisorModel, currentModel, supervisorModelReasoningEffort: effectiveSupervisorModelReasoningEffort, agentsText, workspaceListingText, taggedFiles, openFiles, utilities, skills, skillsToInvoke, skillInstructions, effectiveSupervisorConfiguredSystemMessage, effectiveStopCondition, activeMode, allowedNextModes, modePayloadFields: modePayloadFields, modeGuidance, supervisorWorkspaceRoot });
    emitSuperviseTurnSettings(ctx, {
      turn: turnIndex + 1,
      mode: activeMode,
      agentReasoningEffort: effectiveAgentModelReasoningEffort,
      supervisorReasoningEffort: effectiveSupervisorModelReasoningEffort,
      providerBuiltinTools: effectiveProviderBuiltinTools,
      promptMode: shouldUseFullPrompt ? "full" : "incremental",
    });
    const turnResult = await runAgentTurnWithHooks({
      ctx,
      workspaceRoot,
      agentWorkspaceRoot,
      docPath,
      conversationId,
      providerName,
      currentModel,
      sandboxMode,
      permissionProfile,
      skipGitRepoCheck: Boolean((params as any)?.skipGitRepoCheck ?? true),
      shouldUseFullPrompt,
      currentThreadId,
      agentModelReasoningEffort: effectiveAgentModelReasoningEffort,
      providerOptions: effectiveAgentProviderOptions,
      toolConfig: effectiveToolConfig,
      providerFilesystemPolicy: effectiveAgentFilesystemPolicy,
      customTools: effectiveToolConfig?.customTools,
      compilePrompt: compile.prompt,
      outputSchema: renderedRunConfig?.outputSchema,
      effectiveSupervisor,
      budget,
      pricing,
      sendBudgetUpdate,
      toolOutput,
      activeRuns,
      activeRunsByForkId,
      activeForkId: lifecycle.currentForkId(),
      currentDocText,
      fullResyncNeeded,
      hooks: effectiveHooks,
      turn: turnIndex + 1,
      onCadenceHit: cadenceController.onCadenceHit, onToolBoundary: cadenceController.onToolBoundary, onAppendMarkdown: cadenceController.onAppendMarkdown, onAssistantText: cadenceController.onAssistantText,
    });
    const cadenceFinalize = await cadenceController.finalize();
    if (cadenceFinalize.supervisorThreadId && cadenceFinalize.supervisorThreadId !== currentSupervisorThreadId) currentSupervisorThreadId = cadenceFinalize.supervisorThreadId;
    if (cadenceFinalize.appendedMarkdowns.length > 0) {
      currentDocText = combineTranscript(currentDocText, cadenceFinalize.appendedMarkdowns);
      fullResyncNeeded = true;
    }
    const persistedCadenceReviewStep = cadenceFinalize.reviewStep;
    const result = turnResult.result;
    currentDocText = turnResult.nextDocText;
    fullResyncNeeded = turnResult.fullResyncNeeded;
    if (result.newThreadId && result.newThreadId !== currentThreadId) currentThreadId = result.newThreadId;
    if (shouldUseFullPrompt && currentThreadId) fullResyncNeeded = false;
    if (result.toolCalls && result.toolCalls.length) {
      const toolOutcome = await processInlineToolCalls({
        ctx,
        workspaceRoot,
        agentWorkspaceRoot,
        docPath,
        conversationId,
        result,
        currentDocText,
        currentThreadId,
        currentSupervisorThreadId,
        activeForkId: lifecycle.currentForkId(),
        switchActiveFork: lifecycle.switchActiveFork,
        fullResyncNeeded,
        renderedRunConfig,
        runConfigPath,
        configBaseDir,
        agentBaseDir: agentWorkspaceRoot,
        supervisorBaseDir: supervisorWorkspaceRoot,
        toolConfig: effectiveToolConfig,
        toolOutput,
        disableSupervision,
        effectiveSupervisor,
        requestAgentRuleRequirements,
        effectiveAgentRequirements,
        effectiveAgentViolations,
        effectiveSupervisorInstructions,
        supervisorProviderName,
        supervisorModel,
        currentModel,
        supervisorModelReasoningEffort: effectiveSupervisorModelReasoningEffort,
        supervisorProviderOptions: effectiveSupervisorProviderOptions,
        effectiveSupervisorConfiguredSystemMessage,
        supervisorTriggers: renderedRunConfig?.supervisorTriggers,
        effectiveStopCondition,
        activeMode,
        allowedNextModes,
        modePayloadFieldsByMode: modePayloadFields,
        modeGuidanceByMode: modeGuidance,
        supervisorWorkspaceRoot,
        agentsText,
        workspaceListingText,
        taggedFiles,
        openFiles,
        utilities,
        skills,
        skillsToInvoke,
        skillInstructions,
        startedAt,
        budget,
        providerName,
      });
      if (toolOutcome.kind === "stop") {
        stopReasons = toolOutcome.stopReasons;
        stopDetails = toolOutcome.stopDetails;
        currentDocText = toolOutcome.currentDocText;
        lifecycle.finishRun("stopped");
        return { conversationId, forkId: toolOutcome.nextForkId, mode: "supervise", stopReasons, stopDetails, ...runtimeStateForDocument(currentDocText) };
      }
      currentDocText = toolOutcome.currentDocText;
      currentThreadId = toolOutcome.currentThreadId;
      currentSupervisorThreadId = toolOutcome.currentSupervisorThreadId;
      fullResyncNeeded = toolOutcome.fullResyncNeeded;
      turnIndex += 1;
      cycleTurnCount += 1;
      continue;
    }
    const transitionOutcome = await applyTurnTransitions({
      ctx,
      workspaceRoot,
      docPath,
      conversationId,
      result,
      currentDocText,
      currentThreadId,
      currentSupervisorThreadId,
      activeForkId: lifecycle.currentForkId(),
      switchActiveFork: lifecycle.switchActiveFork,
      fullResyncNeeded,
      renderedRunConfig,
      runConfigPath,
      configBaseDir,
      agentBaseDir: agentWorkspaceRoot,
      supervisorBaseDir: supervisorWorkspaceRoot,
      toolConfig: effectiveToolConfig,
      disableSupervision,
      effectiveSupervisor,
      requestAgentRuleRequirements,
      effectiveAgentRequirements,
      effectiveAgentViolations,
      effectiveSupervisorInstructions,
      supervisorProviderName,
      supervisorModel,
      currentModel,
      supervisorModelReasoningEffort: effectiveSupervisorModelReasoningEffort,
      supervisorProviderOptions: effectiveSupervisorProviderOptions,
      effectiveSupervisorConfiguredSystemMessage,
      supervisorTriggers: renderedRunConfig?.supervisorTriggers,
      effectiveStopCondition,
      activeMode,
      allowedNextModes,
      modePayloadFieldsByMode: modePayloadFields,
      modeGuidanceByMode: modeGuidance,
      supervisorWorkspaceRoot,
      agentsText,
      workspaceListingText,
      taggedFiles,
      openFiles,
      utilities,
      skills,
      skillsToInvoke,
      skillInstructions,
      startedAt,
      budget,
      providerName,
    });
    if (transitionOutcome.kind === "stop") { stopReasons = transitionOutcome.stopReasons; stopDetails = transitionOutcome.stopDetails; currentDocText = transitionOutcome.currentDocText; lifecycle.finishRun("stopped"); return { conversationId, forkId: transitionOutcome.nextForkId, mode: "supervise", stopReasons, stopDetails, ...runtimeStateForDocument(currentDocText) }; }
    if (transitionOutcome.kind === "continue") { currentDocText = transitionOutcome.currentDocText; currentThreadId = transitionOutcome.currentThreadId; currentSupervisorThreadId = transitionOutcome.currentSupervisorThreadId; fullResyncNeeded = transitionOutcome.fullResyncNeeded; turnIndex += 1; cycleTurnCount += 1; continue; }
    const finalizeOutcome = await finalizeSuperviseTurn({
      ctx,
      workspaceRoot,
      conversationId,
      docPath,
      currentDocText,
      currentForkId: lifecycle.currentForkId(),
      currentThreadId,
      currentSupervisorThreadId,
      switchActiveFork: lifecycle.switchActiveFork,
      turnForkId,
      turn: turnIndex + 1,
      result,
      startedAt,
      budget,
      providerName,
      turnAgentModel,
      supervisorModel,
      shouldUseFullPrompt,
      promptBytes,
      sourceBytes,
      managedBytes,
      managedContextStats: managedContext.stats,
      parseErrorsCount: compile.parseErrors.length,
      effectiveAgentModelReasoningEffort,
      effectiveSupervisorModelReasoningEffort,
      effectiveProviderBuiltinTools,
      effectiveSupervisor,
      disableSupervision,
      renderedRunConfig,
      runConfigPath,
      configBaseDir,
      agentBaseDir: agentWorkspaceRoot,
      supervisorBaseDir: supervisorWorkspaceRoot,
      supervisorTriggers: renderedRunConfig?.supervisorTriggers,
      activeMode,
      activeModePayload,
      allowedNextModes,
      modePayloadFieldsByMode: modePayloadFields,
      modeGuidanceByMode: modeGuidance,
      supervisorWorkspaceRoot,
      requestAgentRuleRequirements,
      effectiveAgentRequirements,
      effectiveAgentViolations,
      effectiveSupervisorInstructions,
      supervisorProviderName,
      effectiveSupervisorProviderOptions,
      effectiveSupervisorConfiguredSystemMessage,
      effectiveStopCondition,
      permissionProfile,
      effectiveHooks,
      agentsText,
      workspaceListingText,
      taggedFiles,
      openFiles,
      utilities,
      skills,
      skillsToInvoke,
      skillInstructions,
      fullResyncNeeded,
      persistedCadenceReviewStep,
      timeBudgetMs,
      tokenBudgetAdjusted,
      cadenceTimeMs,
      cadenceTokensAdjusted,
    });
    stopReasons = finalizeOutcome.reasons;
    stopDetails = finalizeOutcome.stopDetails;
    currentDocText = finalizeOutcome.nextDocText;
    if (finalizeOutcome.kind === "done") {
      lifecycle.finishRun(finalizeOutcome.status);
      return { conversationId, forkId: finalizeOutcome.nextForkId, mode: "supervise", stopReasons, stopDetails, ...runtimeStateForDocument(currentDocText) };
    }
    if (finalizeOutcome.supervisorPersist.nextModel) {
      currentModel = finalizeOutcome.supervisorPersist.nextModel;
      sendBudgetUpdate();
    }
    currentThreadId = finalizeOutcome.nextThreadId;
    currentSupervisorThreadId = finalizeOutcome.nextSupervisorThreadId;
    fullResyncNeeded = finalizeOutcome.fullResyncNeeded;
    if (finalizeOutcome.supervisorPersist.resume) {
      if (finalizeOutcome.supervisorPersist.historyRewritten || finalizeOutcome.supervisorPersist.supervisorHookChanged || finalizeOutcome.supervisorPersist.effectiveAction === "fork") {
        fullResyncNeeded = true;
      }
      budget.cadenceAnchorAt = Date.now();
      budget.cadenceTokensAnchor = budget.adjustedTokensUsed;
      turnIndex += 1;
      cycleTurnCount += 1;
      continue;
    }
    lifecycle.finishRun(result.hadError ? "error" : result.interrupted ? "stopped" : "done");
    return { conversationId, forkId: finalizeOutcome.supervisorPersist.nextForkId, mode: "supervise", stopReasons, stopDetails, ...runtimeStateForDocument(currentDocText) };
    }
  } catch (err: any) { lifecycle.finishRun("error"); throw err; }
}
