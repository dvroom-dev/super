import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { schemaForName } from "./json_session_format.js";
import { runModelAcceptance } from "./model_acceptance.js";
import { enqueueFluxQueueItem } from "./queue.js";
import { loadFluxPromptTemplate, renderTemplate } from "./prompt_templates.js";
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
  const turn = await runFluxProviderTurn({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    session,
    sessionType: "modeler",
    promptText,
    reasoningEffort: args.config.modeler.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
    outputSchema: schemaForName(args.config.modeler.outputSchema),
    workingDirectory: path.resolve(args.workspaceRoot, args.config.modeler.workingDirectory ?? "."),
  });
  await appendFluxMessage(args.workspaceRoot, args.config, "modeler", sessionId, {
    messageId: newId("msg"),
    ts: nowIso(),
    turnIndex: Date.now(),
    kind: "assistant",
    text: turn.assistantText,
    providerThreadId: turn.providerThreadId,
  });
  const modelOutput = JSON.parse(turn.assistantText || "{}") as Record<string, unknown>;
  const acceptance = await runModelAcceptance({ workspaceRoot: args.workspaceRoot, config: args.config, modelOutput });
  if (!acceptance.accepted) {
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
      payload: { acceptance: acceptance.payload },
    });
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.acceptance_failed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId,
      summary: acceptance.message || "model acceptance failed",
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
