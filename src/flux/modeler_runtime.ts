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
import { fluxModelRoot } from "./paths.js";
import { loadFluxState, saveFluxState } from "./state.js";

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

function isProgressAdvance(previous: ModelProgress | null, next: ModelProgress): boolean {
  if (!previous) return next.contiguousMatchedSequences > 0;
  if (next.level !== previous.level) return next.level > previous.level && next.contiguousMatchedSequences > 0;
  return next.contiguousMatchedSequences > previous.contiguousMatchedSequences;
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
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  const latestState = await loadFluxState(args.workspaceRoot, args.config) ?? args.state;
  latestState.active.modeler = {
    sessionId,
    status: "running",
    queueItemId: args.queueItem.id,
    pid: process.pid,
    updatedAt: nowIso(),
  };
  await saveFluxState(args.workspaceRoot, args.config, latestState);

  if (args.config.problem.syncModelWorkspace) {
    await runFluxProblemCommand(args.config.problem.syncModelWorkspace, {
      workspaceRoot: args.workspaceRoot,
      queueItem: args.queueItem,
      reason: args.queueItem.reason,
    });
  }

  const promptTemplate = await loadFluxPromptTemplate(args.workspaceRoot, args.config.modeler.promptFile);
  const promptText = [
    promptTemplate.trim(),
    `Modeling trigger: ${args.queueItem.reason}`,
    JSON.stringify(args.queueItem.payload, null, 2),
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
  const modelOutput = parsedModelOutput ?? fallbackModelOutput(args.queueItem.payload, turn.assistantText, turn.interrupted);
  const acceptance = await runModelAcceptance({ workspaceRoot: args.workspaceRoot, config: args.config, modelOutput });
  const comparePayload = acceptance.payload.compare_payload && typeof acceptance.payload.compare_payload === "object" && !Array.isArray(acceptance.payload.compare_payload)
    ? acceptance.payload.compare_payload as Record<string, unknown>
    : {};
  const currentProgress = computeModelProgress(comparePayload);
  const previousProgress = await loadBestProgress(args.workspaceRoot, args.config);
  const progressAdvanced = isProgressAdvance(previousProgress, currentProgress);
  if (progressAdvanced) {
    await saveBestProgress(args.workspaceRoot, args.config, currentProgress);
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "bootstrapper", {
      id: newId("q"),
      sessionType: "bootstrapper",
      createdAt: nowIso(),
      reason: "model_progress_advanced",
      dedupeKey: `model-progress:${currentProgress.level}:${currentProgress.contiguousMatchedSequences}`,
      payload: {
        modelProgress: currentProgress,
        comparePayload,
        messageForBootstrapper: String(modelOutput.message_for_bootstrapper ?? ""),
        modelOutput,
        sourceEvidence: args.queueItem.payload.latestEvidence ?? null,
        sourceEvidenceWatermark: String(args.queueItem.payload.evidenceWatermark ?? modelOutput.evidence_watermark ?? ""),
      },
    });
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.progress_advanced",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId,
      summary: `modeled contiguous sequence prefix through ${currentProgress.firstFailingSequenceId ? currentProgress.contiguousMatchedSequences : currentProgress.contiguousMatchedSequences}`,
      payload: {
        level: currentProgress.level,
        contiguousMatchedSequences: currentProgress.contiguousMatchedSequences,
        firstFailingSequenceId: currentProgress.firstFailingSequenceId,
        firstFailingReason: currentProgress.firstFailingReason,
      },
    }]);
  }
  if (!acceptance.accepted) {
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
      await enqueueFluxQueueItem(args.workspaceRoot, args.config, "modeler", {
        id: newId("q"),
        sessionType: "modeler",
        createdAt: nowIso(),
        reason: "acceptance_failed_resume",
        payload: {
          acceptance: compactAcceptancePayload(acceptance.payload),
          latestEvidence: args.queueItem.payload.latestEvidence ?? null,
          evidenceWatermark: args.queueItem.payload.evidenceWatermark ?? null,
        },
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
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "bootstrapper", {
      id: newId("q"),
      sessionType: "bootstrapper",
      createdAt: nowIso(),
      reason: "model_accepted",
      dedupeKey: `model:${revisionId}`,
      payload: {
        modelRevisionId: revisionId,
        messageForBootstrapper: String(modelOutput.message_for_bootstrapper ?? ""),
        modelOutput,
        sourceEvidence: args.queueItem.payload.latestEvidence ?? null,
        sourceEvidenceWatermark: String(args.queueItem.payload.evidenceWatermark ?? modelOutput.evidence_watermark ?? ""),
        modelProgress: currentProgress,
        comparePayload,
      },
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
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  latestState.active.modeler = {
    sessionId,
    status: "idle",
    updatedAt: nowIso(),
  };
  await saveFluxState(args.workspaceRoot, args.config, latestState);
}
