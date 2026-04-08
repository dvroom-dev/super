import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { parseJsonObjectFromAssistantText, schemaForName } from "./json_session_format.js";
import { runModelAcceptance } from "./model_acceptance.js";
import { buildCoverageSummary, classifyModelImprovement, computeModelProgress, preferCoverageSummary, type ModelProgress } from "./model_coverage.js";
import { loadModelCoverageSummary, modelRevisionWorkspaceSource, persistModelRevisionWorkspace, saveCurrentModelHead, saveModelCoverageSummary } from "./model_revision_store.js";
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

async function loadCurrentModelCoverageSummary(
  workspaceRoot: string,
  config: FluxConfig,
): Promise<ReturnType<typeof buildCoverageSummary> | null> {
  try {
    const raw = await fs.readFile(path.join(fluxModelRoot(workspaceRoot, config), "current", "meta.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summary = parsed.summary;
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
      return null;
    }
    const record = summary as Record<string, unknown>;
    return Array.isArray(record.coveredSequenceIds) ? record as ReturnType<typeof buildCoverageSummary> : null;
  } catch {
    return null;
  }
}

function comparePayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function inferAcceptanceInfrastructureFailure(args: {
  workspaceRoot: string;
  config: FluxConfig;
  acceptanceMessage: string;
  comparePayload: Record<string, unknown>;
  existing: Record<string, unknown> | null;
}): Promise<Record<string, unknown> | null> {
  if (args.existing) return args.existing;
  const errorRecord = comparePayloadRecord(args.comparePayload.error);
  const errorType = String(errorRecord.type ?? "").trim();
  const errorMessage = String(errorRecord.message ?? args.acceptanceMessage ?? "").trim();
  if (["missing_level_dir", "missing_sequences", "missing_sequence_dir"].includes(errorType)) {
    return {
      type: errorType,
      message: errorMessage || "compare surface is missing required level artifacts",
    };
  }
  const reports = Array.isArray(args.comparePayload.reports) ? args.comparePayload.reports : [];
  const workspaceDir = modelRevisionWorkspaceSource(args.workspaceRoot, args.config);
  for (const report of reports) {
    if (!report || typeof report !== "object" || Array.isArray(report)) continue;
    const record = report as Record<string, unknown>;
    const sequenceId = String(record.sequence_id ?? "").trim();
    const level = Number(record.level ?? args.comparePayload.level ?? 0) || 0;
    if (!sequenceId || level <= 0) continue;
    const sequencePath = path.join(workspaceDir, `level_${level}`, "sequences", `${sequenceId}.json`);
    try {
      await fs.access(sequencePath);
    } catch {
      return {
        type: "missing_sequence_surface",
        message: `compare referenced level_${level}/${sequenceId}, but ${sequencePath} is not present in the synced model workspace`,
        level,
        sequenceId,
      };
    }
  }
  return null;
}

function isProgressAdvance(previous: ModelProgress | null, next: ModelProgress): boolean {
  const sequenceOrder = (sequenceId: string | null): number => {
    const match = String(sequenceId ?? "").match(/seq_(\d+)/i);
    return match ? Number(match[1]) || 0 : 0;
  };
  const hasOrderedAdvance = (baseline: ModelProgress | null, candidate: ModelProgress): boolean => {
    if (candidate.contiguousMatchedSequences > (baseline?.contiguousMatchedSequences ?? 0)) {
      return true;
    }
    const candidateSequenceOrder = sequenceOrder(candidate.firstFailingSequenceId);
    const baselineSequenceOrder = sequenceOrder(baseline?.firstFailingSequenceId ?? null);
    if (candidateSequenceOrder > Math.max(1, baselineSequenceOrder)) {
      return true;
    }
    if ((candidate.firstFailingStep ?? 0) > 1) {
      return true;
    }
    if (
      baseline?.firstFailingSequenceId
      && candidate.firstFailingSequenceId
      && baseline.firstFailingSequenceId === candidate.firstFailingSequenceId
      && baseline.firstFailingStep != null
      && candidate.firstFailingStep != null
      && candidate.firstFailingStep > baseline.firstFailingStep
    ) {
      return true;
    }
    return false;
  };
  if (!previous) {
    return hasOrderedAdvance(null, next);
  }
  if (next.level !== previous.level) {
    return next.level > previous.level && hasOrderedAdvance(previous, next);
  }
  return hasOrderedAdvance(previous, next);
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
  const candidateSummary = buildCoverageSummary({ comparePayload, accepted: true });
  const currentSummary = await loadCurrentModelCoverageSummary(workspaceRoot, config);
  const seedMeta = await loadSeedMeta(workspaceRoot, config);
  const durableSummary = preferCoverageSummary(
    coverageSummaryFromSeedMeta(seedMeta.lastQueuedBootstrapCoverageSummary)
      ?? coverageSummaryFromSeedMeta(seedMeta.lastBootstrapperCoverageSummary)
      ?? currentSummary,
    candidateSummary,
  );
  await saveModelCoverageSummary({
    workspaceRoot,
    config,
    revisionId,
    summary: durableSummary,
  });
  await saveCurrentModelHead({
    workspaceRoot,
    config,
    revisionId,
    summary: durableSummary,
  });
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
  const promptPayload = args.queueItem.payload;

  if (args.config.problem.syncModelWorkspace) {
    await runFluxProblemCommand(args.config.problem.syncModelWorkspace, {
      workspaceRoot: args.workspaceRoot,
      queueItem: args.queueItem,
      reason: args.queueItem.reason,
      evidenceBundleId: typeof promptPayload.evidenceBundleId === "string" ? promptPayload.evidenceBundleId : undefined,
      evidenceBundlePath: typeof promptPayload.evidenceBundlePath === "string" ? promptPayload.evidenceBundlePath : undefined,
    });
  }

  const promptTemplate = await loadFluxPromptTemplate(args.workspaceRoot, args.config.modeler.promptFile);
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
  const preflightInfrastructureFailure = await inferAcceptanceInfrastructureFailure({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    acceptanceMessage: preflightAcceptance.message,
    comparePayload: preflightComparePayload,
    existing: preflightAcceptance.infrastructureFailure,
  });
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
  if (preflightInfrastructureFailure) {
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
        infrastructureFailure: preflightInfrastructureFailure,
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
  if (args.config.problem.syncModelWorkspace) {
    await runFluxProblemCommand(args.config.problem.syncModelWorkspace, {
      workspaceRoot: args.workspaceRoot,
      queueItem: args.queueItem,
      reason: "post_modeler_turn",
      evidenceBundleId: typeof promptPayload.evidenceBundleId === "string" ? promptPayload.evidenceBundleId : undefined,
      evidenceBundlePath: typeof promptPayload.evidenceBundlePath === "string" ? promptPayload.evidenceBundlePath : undefined,
    });
  }
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
  const inferredInfrastructureFailure = await inferAcceptanceInfrastructureFailure({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    acceptanceMessage: acceptance.message,
    comparePayload,
    existing: acceptance.infrastructureFailure,
  });
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
    const infrastructureFailure = inferredInfrastructureFailure;
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
