import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { parseJsonObjectFromAssistantText, schemaForName } from "./json_session_format.js";
import { runModelAcceptance } from "./model_acceptance.js";
import { enqueueFluxQueueItem } from "./queue.js";
import { loadFluxPromptTemplate, renderTemplate } from "./prompt_templates.js";
import { runFluxProblemCommand } from "./problem_shell.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { appendFluxMessage, loadFluxSession, saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxQueueItem, FluxRunState, FluxSessionRecord } from "./types.js";
import { fluxModelRoot, fluxModelTriggerPath, fluxBootstrapTriggerPath } from "./paths.js";
import { loadFluxState, mutateFluxState, saveFluxState } from "./state.js";

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

function compactAcceptancePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const comparePayload = payload.compare_payload && typeof payload.compare_payload === "object" && !Array.isArray(payload.compare_payload)
    ? payload.compare_payload as Record<string, unknown>
    : {};
  const reports = Array.isArray(comparePayload.reports) ? comparePayload.reports : [];
  const firstReport = reports[0] && typeof reports[0] === "object" && !Array.isArray(reports[0])
    ? reports[0] as Record<string, unknown>
    : {};
  return {
    accepted: Boolean(payload.accepted),
    message: String(payload.message ?? ""),
    model_output: payload.model_output,
    compare_summary: {
      all_match: Boolean(comparePayload.all_match),
      compared_sequences: Number(comparePayload.compared_sequences ?? 0),
      diverged_sequences: Number(comparePayload.diverged_sequences ?? 0),
      divergence_reason: String(firstReport.divergence_reason ?? ""),
      report_file: String(firstReport.report_file ?? ""),
      sequence_id: String(firstReport.sequence_id ?? ""),
    },
  };
}

function isBlockedModelOutput(modelOutput: Record<string, unknown>): boolean {
  return String(modelOutput.decision ?? "").trim().toLowerCase() === "blocked";
}

type ModelProgress = {
  level: number;
  contiguousMatchedSequences: number;
  firstFailingSequenceId: string | null;
  firstFailingReason: string | null;
};

function sequenceNumber(sequenceId: string): number | null {
  const match = sequenceId.match(/seq_(\d+)/i);
  return match ? Number(match[1]) : null;
}

function computeModelProgress(comparePayload: Record<string, unknown>): ModelProgress {
  const reports = Array.isArray(comparePayload.reports) ? comparePayload.reports : [];
  const skipped = Array.isArray(comparePayload.skipped_sequences) ? comparePayload.skipped_sequences : [];
  const bySequence = new Map<number, { matched: boolean; reason: string | null; sequenceId: string }>();
  for (const report of reports) {
    if (!report || typeof report !== "object" || Array.isArray(report)) continue;
    const record = report as Record<string, unknown>;
    const sequenceId = String(record.sequence_id ?? "");
    const order = sequenceNumber(sequenceId);
    if (!order) continue;
    bySequence.set(order, {
      matched: Boolean(record.matched),
      reason: String(record.divergence_reason ?? "") || null,
      sequenceId,
    });
  }
  for (const skippedRecord of skipped) {
    if (!skippedRecord || typeof skippedRecord !== "object" || Array.isArray(skippedRecord)) continue;
    const record = skippedRecord as Record<string, unknown>;
    const sequenceId = String(record.sequence_id ?? "");
    const order = sequenceNumber(sequenceId);
    if (!order || bySequence.has(order)) continue;
    bySequence.set(order, {
      matched: false,
      reason: String(record.reason ?? record.end_reason ?? "") || null,
      sequenceId,
    });
  }
  const ordered = [...bySequence.entries()].sort((left, right) => left[0] - right[0]);
  let contiguousMatchedSequences = 0;
  let firstFailingSequenceId: string | null = null;
  let firstFailingReason: string | null = null;
  for (const [order, item] of ordered) {
    const expected = contiguousMatchedSequences + 1;
    if (order !== expected || !item.matched) {
      firstFailingSequenceId = item.sequenceId || `seq_${String(expected).padStart(4, "0")}`;
      firstFailingReason = item.reason;
      break;
    }
    contiguousMatchedSequences = order;
  }
  return {
    level: Number(comparePayload.level ?? 1) || 1,
    contiguousMatchedSequences,
    firstFailingSequenceId,
    firstFailingReason,
  };
}

function acceptanceBootstrapTriggerKey(comparePayload: Record<string, unknown>, progress: ModelProgress): string {
  const reports = Array.isArray(comparePayload.reports) ? comparePayload.reports : [];
  const firstReport = reports[0] && typeof reports[0] === "object" && !Array.isArray(reports[0])
    ? reports[0] as Record<string, unknown>
    : {};
  return [
    "bootstrap-accepted",
    String(comparePayload.level ?? progress.level ?? 1),
    String(progress.contiguousMatchedSequences),
    String(Boolean(comparePayload.all_match)),
    String(firstReport.sequence_id ?? ""),
    String(firstReport.divergence_step ?? ""),
    String(firstReport.divergence_reason ?? ""),
    String(firstReport.report_file ?? ""),
  ].join(":");
}

async function loadLastBootstrapTriggerKey(workspaceRoot: string, config: FluxConfig): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(fluxModelRoot(workspaceRoot, config), "current", "bootstrap_trigger.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.key === "string" && parsed.key.trim().length > 0 ? parsed.key : null;
  } catch {
    return null;
  }
}

async function saveLastBootstrapTriggerKey(workspaceRoot: string, config: FluxConfig, key: string): Promise<void> {
  await writeJsonAtomic(path.join(fluxModelRoot(workspaceRoot, config), "current", "bootstrap_trigger.json"), {
    key,
    updatedAt: nowIso(),
  });
}

async function loadModelerTriggerContext(workspaceRoot: string, config: FluxConfig): Promise<Record<string, unknown>> {
  return await fs.readFile(fluxModelTriggerPath(workspaceRoot, config), "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => ({}));
}

async function saveModelerTriggerContext(workspaceRoot: string, config: FluxConfig, reason: string, payload: Record<string, unknown>): Promise<void> {
  await writeJsonAtomic(fluxModelTriggerPath(workspaceRoot, config), {
    reason,
    payload,
    updatedAt: nowIso(),
  });
}

async function saveBootstrapperTriggerContext(workspaceRoot: string, config: FluxConfig, reason: string, payload: Record<string, unknown>): Promise<void> {
  await writeJsonAtomic(fluxBootstrapTriggerPath(workspaceRoot, config), {
    reason,
    payload,
    updatedAt: nowIso(),
  });
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
  if (!previous) return next.contiguousMatchedSequences > 0;
  if (next.level !== previous.level) return next.level > previous.level && next.contiguousMatchedSequences > 0;
  return next.contiguousMatchedSequences > previous.contiguousMatchedSequences;
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
  const progressAdvanced = isProgressAdvance(args.previousProgress, args.currentProgress);
  if (progressAdvanced) {
    await saveBestProgress(args.workspaceRoot, args.config, args.currentProgress);
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "bootstrapper", {
      id: newId("q"),
      sessionType: "bootstrapper",
      createdAt: nowIso(),
      reason: "model_progress_advanced",
      dedupeKey: `model-progress:${args.currentProgress.level}:${args.currentProgress.contiguousMatchedSequences}`,
      payload: {},
    });
    await saveBootstrapperTriggerContext(args.workspaceRoot, args.config, "model_progress_advanced", {
      modelProgress: args.currentProgress,
      comparePayload: args.comparePayload,
      modelRevisionId: args.modelRevisionId ?? undefined,
      messageForBootstrapper: String(args.modelOutput.message_for_bootstrapper ?? ""),
      modelOutput: args.modelOutput,
      sourceEvidence: args.promptPayload.latestEvidence ?? null,
      sourceEvidenceWatermark: String(args.promptPayload.evidenceWatermark ?? args.modelOutput.evidence_watermark ?? ""),
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
        firstFailingReason: args.currentProgress.firstFailingReason,
      },
    }]);
  }
  const triggerKey = acceptanceBootstrapTriggerKey(args.comparePayload, args.currentProgress);
  const lastTriggerKey = await loadLastBootstrapTriggerKey(args.workspaceRoot, args.config);
  if (lastTriggerKey !== triggerKey) {
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "bootstrapper", {
      id: newId("q"),
      sessionType: "bootstrapper",
      createdAt: nowIso(),
      reason: "model_accepted",
      dedupeKey: triggerKey,
      payload: {},
    });
    await saveBootstrapperTriggerContext(args.workspaceRoot, args.config, "model_accepted", {
      modelRevisionId: args.modelRevisionId ?? undefined,
      messageForBootstrapper: String(args.modelOutput.message_for_bootstrapper ?? ""),
      modelOutput: args.modelOutput,
      sourceEvidence: args.promptPayload.latestEvidence ?? null,
      sourceEvidenceWatermark: String(args.promptPayload.evidenceWatermark ?? args.modelOutput.evidence_watermark ?? ""),
      modelProgress: args.currentProgress,
      comparePayload: args.comparePayload,
    });
    await saveLastBootstrapTriggerKey(args.workspaceRoot, args.config, triggerKey);
  }
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
  await enqueueFluxQueueItem(args.workspaceRoot, args.config, "bootstrapper", {
    id: newId("q"),
    sessionType: "bootstrapper",
    createdAt: nowIso(),
    reason: "model_progress_advanced",
    dedupeKey: `model-progress:${args.currentProgress.level}:${args.currentProgress.contiguousMatchedSequences}`,
    payload: {},
  });
  await saveBootstrapperTriggerContext(args.workspaceRoot, args.config, "model_progress_advanced", {
    modelProgress: args.currentProgress,
    comparePayload: args.comparePayload,
    modelRevisionId: args.modelRevisionId ?? undefined,
    messageForBootstrapper: String(args.modelOutput.message_for_bootstrapper ?? ""),
    modelOutput: args.modelOutput,
    sourceEvidence: args.promptPayload.latestEvidence ?? null,
    sourceEvidenceWatermark: String(args.promptPayload.evidenceWatermark ?? args.modelOutput.evidence_watermark ?? ""),
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
      firstFailingReason: args.currentProgress.firstFailingReason,
    },
  }]);
}

async function persistAcceptedModel(
  workspaceRoot: string,
  config: FluxConfig,
  modelOutput: Record<string, unknown>,
): Promise<string> {
  const revisionId = newId("model_rev");
  const currentDir = path.join(fluxModelRoot(workspaceRoot, config), "current");
  const revisionDir = path.join(fluxModelRoot(workspaceRoot, config), "revisions", revisionId);
  await fs.mkdir(currentDir, { recursive: true });
  await fs.mkdir(revisionDir, { recursive: true });
  await writeJsonAtomic(path.join(revisionDir, "model_update.json"), modelOutput);
  await writeJsonAtomic(path.join(currentDir, "model_update.json"), modelOutput);
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
  const triggerContext = await loadModelerTriggerContext(args.workspaceRoot, args.config);
  const promptPayload = Object.keys(args.queueItem.payload).length > 0
    ? args.queueItem.payload
    : ((triggerContext.payload && typeof triggerContext.payload === "object" && !Array.isArray(triggerContext.payload))
      ? triggerContext.payload as Record<string, unknown>
      : {});
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
  });
  const preflightComparePayload = preflightAcceptance.payload.compare_payload
    && typeof preflightAcceptance.payload.compare_payload === "object"
    && !Array.isArray(preflightAcceptance.payload.compare_payload)
    ? preflightAcceptance.payload.compare_payload as Record<string, unknown>
    : {};
  const previousProgress = await loadBestProgress(args.workspaceRoot, args.config);
  const preflightProgress = computeModelProgress(preflightComparePayload);
  if (preflightAcceptance.accepted) {
    const currentRevisionId = await loadCurrentModelRevisionId(args.workspaceRoot, args.config);
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
  const acceptance = await runModelAcceptance({ workspaceRoot: args.workspaceRoot, config: args.config, modelOutput });
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
    if (!blocked && !infrastructureFailure) {
      const template = await loadFluxPromptTemplate(args.workspaceRoot, args.config.modeler.acceptance.continueMessageTemplateFile);
      const continueText = renderTemplate(template, {
        acceptance_message: acceptance.message || JSON.stringify(acceptance.payload, null, 2),
      });
      await appendFluxMessage(args.workspaceRoot, args.config, "modeler", sessionId, {
        messageId: newId("msg"),
        ts: nowIso(),
        turnIndex: Date.now(),
        kind: "user",
        text: continueText,
      });
      await saveModelerTriggerContext(args.workspaceRoot, args.config, "acceptance_failed_resume", {
        acceptance: compactAcceptancePayload(acceptance.payload),
        latestEvidence: promptPayload.latestEvidence ?? null,
        evidenceWatermark: promptPayload.evidenceWatermark ?? null,
      });
      await enqueueFluxQueueItem(args.workspaceRoot, args.config, "modeler", {
        id: newId("q"),
        sessionType: "modeler",
        createdAt: nowIso(),
        reason: "acceptance_failed_resume",
        payload: {},
      });
    }
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
    const revisionId = await persistAcceptedModel(args.workspaceRoot, args.config, modelOutput);
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
