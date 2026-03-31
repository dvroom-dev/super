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
  if (!acceptance.accepted) {
    const blocked = isBlockedModelOutput(modelOutput);
    if (!blocked) {
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
        payload: { acceptance: compactAcceptancePayload(acceptance.payload) },
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
      payload: { blocked },
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
