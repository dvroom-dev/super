import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { parseJsonObjectFromAssistantText, schemaForName } from "./json_session_format.js";
import { runModelAcceptance } from "./model_acceptance.js";
import { buildCoverageSummary, classifyModelImprovement, computeModelProgress, type ModelProgress } from "./model_coverage.js";
import { loadModelCoverageSummary, modelRevisionWorkspaceSource, persistModelRevisionWorkspace, saveModelCoverageSummary } from "./model_revision_store.js";
import { enqueueFluxQueueItem } from "./queue.js";
import { loadFluxPromptTemplate } from "./prompt_templates.js";
import { runFluxProblemCommand } from "./problem_shell.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { loadSeedMeta, saveSeedMeta } from "./seed_meta.js";
import { appendFluxMessage, loadFluxSession, saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxQueueItem, FluxRunState, FluxSessionRecord } from "./types.js";
import { fluxModelRoot } from "./paths.js";
import { mutateFluxState } from "./state.js";

function nowIso(): string {
  return new Date().toISOString();
}

function modelSessionId(): string {
  return "modeler_run";
}

function fallbackModelOutput(queuePayload: Record<string, unknown>, assistantText: string, interrupted: boolean): Record<string, unknown> {
  return {
    decision: "updated_model",
    summary: interrupted ? "interrupted modeler turn; evaluate current workspace state" : "modeler output was not valid JSON; evaluate current workspace state",
    message_for_bootstrapper: "",
    artifacts_updated: [],
    evidence_watermark: String(queuePayload.evidenceWatermark ?? ""),
    raw_assistant_text: assistantText,
  };
}

function isBlockedModelOutput(modelOutput: Record<string, unknown>): boolean {
  return String(modelOutput.decision ?? "").trim().toLowerCase() === "blocked";
}

async function loadBestProgress(workspaceRoot: string, config: FluxConfig): Promise<ModelProgress | null> {
  try {
    const raw = await fs.readFile(path.join(fluxModelRoot(workspaceRoot, config), "current", "progress.json"), "utf8");
    return JSON.parse(raw) as ModelProgress;
  } catch {
    return null;
  }
}

async function saveBestProgress(workspaceRoot: string, config: FluxConfig, progress: ModelProgress): Promise<void> {
  await writeJsonAtomic(path.join(fluxModelRoot(workspaceRoot, config), "current", "progress.json"), {
    ...progress,
    updatedAt: nowIso(),
  });
}

async function loadCurrentModelRevisionId(workspaceRoot: string, config: FluxConfig): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(fluxModelRoot(workspaceRoot, config), "current", "meta.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const revisionId = parsed.revisionId;
    return typeof revisionId === "string" && revisionId.trim().length > 0 ? revisionId : null;
  } catch {
    return null;
  }
}

function isProgressAdvance(previous: ModelProgress | null, next: ModelProgress): boolean {
  if (!previous) {
    return next.contiguousMatchedSequences > 0 || next.firstFailingStep != null || next.firstFailingSequenceId != null;
  }
  if (next.level !== previous.level) {
    return next.level > previous.level
      && (next.contiguousMatchedSequences > 0 || next.firstFailingStep != null || next.firstFailingSequenceId != null);
  }
  if (
    previous.firstFailingSequenceId
    && next.firstFailingSequenceId
    && previous.firstFailingSequenceId === next.firstFailingSequenceId
    && previous.firstFailingStep != null
    && next.firstFailingStep != null
    && next.firstFailingStep > previous.firstFailingStep
  ) {
    return true;
  }
  return next.contiguousMatchedSequences > previous.contiguousMatchedSequences;
}

function coverageSummaryFromSeedMeta(value: unknown): ReturnType<typeof buildCoverageSummary> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.coveredSequenceIds)) {
    return null;
  }
  return record as ReturnType<typeof buildCoverageSummary>;
}

async function publishBootstrapSignals(args: {
  workspaceRoot: string;
  config: FluxConfig;
  comparePayload: Record<string, unknown>;
  currentProgress: ModelProgress;
  previousProgress: ModelProgress | null;
  modelOutput: Record<string, unknown>;
  modelRevisionId?: string | null;
  promptPayload: Record<string, unknown>;
  sessionId: string;
}): Promise<void> {
  const modelRevisionId = typeof args.modelRevisionId === "string" && args.modelRevisionId ? args.modelRevisionId : null;
  if (!modelRevisionId) return;
  const currentSummary = buildCoverageSummary({ comparePayload: args.comparePayload, accepted: true });
  const persistedSummary = await saveModelCoverageSummary({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    revisionId: modelRevisionId,
    summary: currentSummary,
  });
  const seedMeta = await loadSeedMeta(args.workspaceRoot, args.config);
  const baselineRevisionId = seedMeta.lastQueuedBootstrapModelRevisionId ?? seedMeta.lastBootstrapperModelRevisionId ?? null;
  const baselineSummary =
    coverageSummaryFromSeedMeta(seedMeta.lastQueuedBootstrapCoverageSummary)
    ?? coverageSummaryFromSeedMeta(seedMeta.lastBootstrapperCoverageSummary)
    ?? (baselineRevisionId ? await loadModelCoverageSummary(args.workspaceRoot, args.config, baselineRevisionId) : null);
  const improvementKind = classifyModelImprovement(baselineSummary, persistedSummary);
  if (isProgressAdvance(args.previousProgress, args.currentProgress)) {
    await saveBestProgress(args.workspaceRoot, args.config, args.currentProgress);
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.progress_advanced",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId: args.sessionId,
      summary: `modeled contiguous sequence prefix through ${args.currentProgress.contiguousMatchedSequences}`,
      payload: {
        level: args.currentProgress.level,
        contiguousMatchedSequences: args.currentProgress.contiguousMatchedSequences,
        firstFailingSequenceId: args.currentProgress.firstFailingSequenceId,
        firstFailingStep: args.currentProgress.firstFailingStep,
        firstFailingReason: args.currentProgress.firstFailingReason,
      },
    }]);
  }
  if (improvementKind === "no_improvement") {
    return;
  }
  await enqueueFluxQueueItem(args.workspaceRoot, args.config, "bootstrapper", {
    id: newId("q"),
    sessionType: "bootstrapper",
    createdAt: nowIso(),
    reason: improvementKind === "frontier_advanced" ? "model_progress_advanced" : "model_accepted",
    dedupeKey: `bootstrap:${modelRevisionId}`,
    payload: {
      baselineModelRevisionId: modelRevisionId,
      improvementKind,
      modelRevisionId,
      messageForBootstrapper: String(args.modelOutput.message_for_bootstrapper ?? ""),
      modelOutput: args.modelOutput,
      sourceEvidence: args.promptPayload.latestEvidence ?? null,
      sourceEvidenceWatermark: String(args.promptPayload.evidenceWatermark ?? args.modelOutput.evidence_watermark ?? ""),
      modelProgress: args.currentProgress,
      comparePayload: args.comparePayload,
      coverageSummary: persistedSummary,
    },
  });
  const nextSeedMeta = {
    ...seedMeta,
    lastQueuedBootstrapModelRevisionId: modelRevisionId,
    lastQueuedBootstrapCoverageSummary: persistedSummary,
  };
  await saveSeedMeta(args.workspaceRoot, args.config, nextSeedMeta);
}

async function publishProgressAdvance(args: {
  workspaceRoot: string;
  config: FluxConfig;
  currentProgress: ModelProgress;
  previousProgress: ModelProgress | null;
  comparePayload: Record<string, unknown>;
  modelOutput: Record<string, unknown>;
  promptPayload: Record<string, unknown>;
  sessionId: string;
  modelRevisionId?: string | null;
}): Promise<void> {
  if (!isProgressAdvance(args.previousProgress, args.currentProgress)) {
    return;
  }
  await saveBestProgress(args.workspaceRoot, args.config, args.currentProgress);
  const revisionId = args.modelRevisionId ?? newId("model_rev");
  const revisionDir = path.join(fluxModelRoot(args.workspaceRoot, args.config), "revisions", revisionId);
  const summary = buildCoverageSummary({ comparePayload: args.comparePayload, accepted: false });
  await fs.mkdir(revisionDir, { recursive: true });
  await writeJsonAtomic(path.join(revisionDir, "model_update.json"), args.modelOutput);
  await persistModelRevisionWorkspace({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    revisionId,
    sourceWorkspaceDir: modelRevisionWorkspaceSource(args.workspaceRoot, args.config),
  });
  const persistedSummary = await saveModelCoverageSummary({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    revisionId,
    summary,
  });
  await enqueueFluxQueueItem(args.workspaceRoot, args.config, "bootstrapper", {
    id: newId("q"),
    sessionType: "bootstrapper",
    createdAt: nowIso(),
    reason: "model_progress_advanced",
    dedupeKey: `bootstrap-progress:${revisionId}`,
    payload: {
      baselineModelRevisionId: revisionId,
      improvementKind: "frontier_advanced",
      modelRevisionId: revisionId,
      messageForBootstrapper: String(args.modelOutput.message_for_bootstrapper ?? ""),
      modelOutput: args.modelOutput,
      sourceEvidence: args.promptPayload.latestEvidence ?? null,
      sourceEvidenceWatermark: String(args.promptPayload.evidenceWatermark ?? args.modelOutput.evidence_watermark ?? ""),
      modelProgress: args.currentProgress,
      comparePayload: args.comparePayload,
      coverageSummary: persistedSummary,
    },
  });
  const seedMeta = await loadSeedMeta(args.workspaceRoot, args.config);
  await saveSeedMeta(args.workspaceRoot, args.config, {
    ...seedMeta,
    lastQueuedBootstrapModelRevisionId: revisionId,
    lastQueuedBootstrapCoverageSummary: persistedSummary,
  });
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "modeler.progress_advanced",
    workspaceRoot: args.workspaceRoot,
    sessionType: "modeler",
    sessionId: args.sessionId,
    summary: `modeled contiguous sequence prefix through ${args.currentProgress.firstFailingSequenceId ? args.currentProgress.contiguousMatchedSequences : args.currentProgress.contiguousMatchedSequences}`,
    payload: {
      level: args.currentProgress.level,
      contiguousMatchedSequences: args.currentProgress.contiguousMatchedSequences,
      firstFailingSequenceId: args.currentProgress.firstFailingSequenceId,
      firstFailingStep: args.currentProgress.firstFailingStep,
      firstFailingReason: args.currentProgress.firstFailingReason,
    },
  }]);
}

async function persistAcceptedModel(
  workspaceRoot: string,
  config: FluxConfig,
  modelOutput: Record<string, unknown>,
  comparePayload: Record<string, unknown>,
): Promise<string> {
  const revisionId = newId("model_rev");
  const currentDir = path.join(fluxModelRoot(workspaceRoot, config), "current");
  const revisionDir = path.join(fluxModelRoot(workspaceRoot, config), "revisions", revisionId);
  await fs.mkdir(currentDir, { recursive: true });
  await fs.mkdir(revisionDir, { recursive: true });
  await writeJsonAtomic(path.join(revisionDir, "model_update.json"), modelOutput);
  await writeJsonAtomic(path.join(currentDir, "model_update.json"), modelOutput);
  await persistModelRevisionWorkspace({
    workspaceRoot,
    config,
    revisionId,
    sourceWorkspaceDir: modelRevisionWorkspaceSource(workspaceRoot, config),
  });
  await saveModelCoverageSummary({
    workspaceRoot,
    config,
    revisionId,
    summary: buildCoverageSummary({ comparePayload, accepted: true }),
  });
  await writeJsonAtomic(path.join(currentDir, "meta.json"), { revisionId, updatedAt: nowIso() });
  return revisionId;
}

export async function runModelerQueueItem(args: {
  workspaceRoot: string;
  config: FluxConfig;
  queueItem: FluxQueueItem;
  state: FluxRunState;
}): Promise<void> {
  const sessionId = modelSessionId();
  const existing = await loadFluxSession(args.workspaceRoot, args.config, "modeler", sessionId);
  const session: FluxSessionRecord = existing ?? {
    sessionId,
    sessionType: "modeler",
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    provider: args.config.modeler.provider ?? args.config.runtimeDefaults.provider,
    model: args.config.modeler.model ?? args.config.runtimeDefaults.model,
    resumePolicy: "always",
    sessionScope: "run",
  };
  session.status = "running";
  session.stopReason = undefined;
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  const latestState = await mutateFluxState(args.workspaceRoot, args.config, async (current) => {
    const next = current ?? args.state;
    next.active.modeler = {
      sessionId,
      status: "running",
      queueItemId: args.queueItem.id,
      pid: process.pid,
      updatedAt: nowIso(),
    };
    return next;
  });

  if (args.config.problem.syncModelWorkspace) {
    await runFluxProblemCommand(args.config.problem.syncModelWorkspace, {
      workspaceRoot: args.workspaceRoot,
      queueItem: args.queueItem,
      reason: args.queueItem.reason,
    });
  }

  const promptTemplate = await loadFluxPromptTemplate(args.workspaceRoot, args.config.modeler.promptFile);
  const promptPayload = args.queueItem.payload;
  const preflightModelOutput = {
    decision: "checked_current_model",
    summary: "preflight compare of current model against latest evidence",
    message_for_bootstrapper: "",
    artifacts_updated: [],
    evidence_watermark: String(promptPayload.evidenceWatermark ?? ""),
  };
  const preflightAcceptance = await runModelAcceptance({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    modelOutput: preflightModelOutput,
    modelRevisionId: await loadCurrentModelRevisionId(args.workspaceRoot, args.config),
    evidenceBundleId: typeof promptPayload.evidenceBundleId === "string" ? promptPayload.evidenceBundleId : null,
    evidenceBundlePath: typeof promptPayload.evidenceBundlePath === "string" ? promptPayload.evidenceBundlePath : null,
  });
  const preflightComparePayload = preflightAcceptance.payload.compare_payload
    && typeof preflightAcceptance.payload.compare_payload === "object"
    && !Array.isArray(preflightAcceptance.payload.compare_payload)
    ? preflightAcceptance.payload.compare_payload as Record<string, unknown>
    : {};
  const previousProgress = await loadBestProgress(args.workspaceRoot, args.config);
  const preflightProgress = computeModelProgress(preflightComparePayload);
  if (preflightAcceptance.accepted) {
    const currentRevisionId = await loadCurrentModelRevisionId(args.workspaceRoot, args.config)
      ?? await persistAcceptedModel(args.workspaceRoot, args.config, preflightModelOutput, preflightComparePayload);
    await publishBootstrapSignals({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      comparePayload: preflightComparePayload,
      currentProgress: preflightProgress,
      previousProgress,
      modelOutput: preflightModelOutput,
      modelRevisionId: currentRevisionId,
      promptPayload,
      sessionId,
    });
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.acceptance_passed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId,
      summary: "current model already matches latest evidence",
      payload: { revisionId: currentRevisionId },
    }]);
    session.status = "idle";
    session.stopReason = undefined;
    session.updatedAt = nowIso();
    await saveFluxSession(args.workspaceRoot, args.config, session);
    await mutateFluxState(args.workspaceRoot, args.config, async (current) => {
      const next = current ?? latestState;
      next.active.modeler = {
        sessionId,
        status: "idle",
        updatedAt: nowIso(),
      };
      return next;
    });
    return;
  }
  if (preflightAcceptance.infrastructureFailure) {
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.acceptance_failed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId,
      summary: preflightAcceptance.message || "model preflight compare failed",
      payload: {
        blocked: false,
        infrastructureFailure: preflightAcceptance.infrastructureFailure,
      },
    }]);
    session.status = "idle";
    session.stopReason = undefined;
    session.updatedAt = nowIso();
    await saveFluxSession(args.workspaceRoot, args.config, session);
    await mutateFluxState(args.workspaceRoot, args.config, async (current) => {
      const next = current ?? latestState;
      next.active.modeler = {
        sessionId,
        status: "idle",
        updatedAt: nowIso(),
      };
      return next;
    });
    return;
  }
  const promptText = [
    promptTemplate.trim(),
    `Modeling trigger: ${args.queueItem.reason}`,
    JSON.stringify(promptPayload, null, 2),
  ].join("\n\n");
  await appendFluxMessage(args.workspaceRoot, args.config, "modeler", sessionId, {
    messageId: newId("msg"),
    ts: nowIso(),
    turnIndex: Date.now(),
    kind: "user",
    text: promptText,
  });
  const controller = args.config.modeler.turnTimeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), args.config.modeler.turnTimeoutMs) : null;
  const turn = await runFluxProviderTurn({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    session,
    sessionType: "modeler",
    promptText,
    reasoningEffort: args.config.modeler.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
    outputSchema: args.config.modeler.turnTimeoutMs ? undefined : schemaForName(args.config.modeler.outputSchema),
    workingDirectory: path.resolve(args.workspaceRoot, args.config.modeler.workingDirectory ?? "."),
    signal: controller?.signal,
  });
  if (timeout) clearTimeout(timeout);
  await appendFluxMessage(args.workspaceRoot, args.config, "modeler", sessionId, {
    messageId: newId("msg"),
    ts: nowIso(),
    turnIndex: Date.now(),
    kind: "assistant",
    text: turn.assistantText,
    providerThreadId: turn.providerThreadId,
  });
  const parsedModelOutput = parseJsonObjectFromAssistantText(turn.assistantText || "");
  const modelOutput = parsedModelOutput ?? fallbackModelOutput(promptPayload, turn.assistantText, turn.interrupted);
  const acceptance = await runModelAcceptance({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    modelOutput,
    evidenceBundleId: typeof promptPayload.evidenceBundleId === "string" ? promptPayload.evidenceBundleId : null,
    evidenceBundlePath: typeof promptPayload.evidenceBundlePath === "string" ? promptPayload.evidenceBundlePath : null,
  });
  const comparePayload = acceptance.payload.compare_payload && typeof acceptance.payload.compare_payload === "object" && !Array.isArray(acceptance.payload.compare_payload)
    ? acceptance.payload.compare_payload as Record<string, unknown>
    : {};
  const currentProgress = computeModelProgress(comparePayload);
  if (!acceptance.accepted) {
    await publishProgressAdvance({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      currentProgress,
      previousProgress,
      comparePayload,
      modelOutput,
      promptPayload,
      sessionId,
    });
    const blocked = isBlockedModelOutput(modelOutput);
    const infrastructureFailure = acceptance.infrastructureFailure;
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.acceptance_failed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId,
      summary: acceptance.message || (blocked ? "model acceptance blocked" : "model acceptance failed"),
      payload: {
        blocked,
        infrastructureFailure,
      },
    }]);
  } else {
    const revisionId = await persistAcceptedModel(args.workspaceRoot, args.config, modelOutput, comparePayload);
    await publishBootstrapSignals({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      comparePayload,
      currentProgress,
      previousProgress,
      modelOutput,
      modelRevisionId: revisionId,
      promptPayload,
      sessionId,
    });
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.acceptance_passed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId,
      summary: `accepted model revision ${revisionId}`,
      payload: { revisionId },
    }]);
  }
  session.status = "idle";
  session.stopReason = undefined;
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  await mutateFluxState(args.workspaceRoot, args.config, async (current) => {
    const next = current ?? latestState;
    next.active.modeler = {
      sessionId,
      status: "idle",
      updatedAt: nowIso(),
    };
    return next;
  });
}
