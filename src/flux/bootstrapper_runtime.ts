import fs from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { appendEvidence } from "./evidence.js";
import { schemaForName } from "./json_session_format.js";
import { runFluxProblemCommand } from "./problem_shell.js";
import { enqueueFluxQueueItem } from "./queue.js";
import { loadFluxPromptTemplate, renderTemplate } from "./prompt_templates.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { appendFluxMessage, loadFluxSession, saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxQueueItem, FluxRunState, FluxSeedBundle, FluxSessionRecord } from "./types.js";
import { fluxSeedRoot } from "./paths.js";
import { loadFluxState, saveFluxState } from "./state.js";

function nowIso(): string {
  return new Date().toISOString();
}

function bootstrapperSessionId(): string {
  return "bootstrapper_run";
}

async function loadSeedBundle(workspaceRoot: string, config: FluxConfig): Promise<FluxSeedBundle | null> {
  return await readJsonIfExists<FluxSeedBundle>(path.resolve(workspaceRoot, config.bootstrapper.seedBundlePath));
}

async function persistSeedRevision(workspaceRoot: string, config: FluxConfig, seedBundle: FluxSeedBundle): Promise<string> {
  const revisionId = newId("seed_rev");
  const currentDir = fluxSeedRoot(workspaceRoot, config);
  const revisionPath = path.join(currentDir, "revisions", `${revisionId}.json`);
  await fs.mkdir(path.dirname(revisionPath), { recursive: true });
  await writeJsonAtomic(path.resolve(workspaceRoot, config.bootstrapper.seedBundlePath), seedBundle);
  await writeJsonAtomic(revisionPath, seedBundle);
  await writeJsonAtomic(path.join(currentDir, "current_meta.json"), { revisionId, updatedAt: nowIso() });
  return revisionId;
}

export async function runBootstrapperQueueItem(args: {
  workspaceRoot: string;
  config: FluxConfig;
  queueItem: FluxQueueItem;
  state: FluxRunState;
}): Promise<void> {
  const sessionId = bootstrapperSessionId();
  const existing = await loadFluxSession(args.workspaceRoot, args.config, "bootstrapper", sessionId);
  const session: FluxSessionRecord = existing ?? {
    sessionId,
    sessionType: "bootstrapper",
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    provider: args.config.bootstrapper.provider ?? args.config.runtimeDefaults.provider,
    model: args.config.bootstrapper.model ?? args.config.runtimeDefaults.model,
    resumePolicy: "always",
    sessionScope: "run",
  };
  session.status = "running";
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  const latestState = await loadFluxState(args.workspaceRoot, args.config) ?? args.state;
  latestState.active.bootstrapper = {
    sessionId,
    status: "running",
    queueItemId: args.queueItem.id,
    pid: process.pid,
    updatedAt: nowIso(),
  };
  await saveFluxState(args.workspaceRoot, args.config, latestState);

  const promptTemplate = await loadFluxPromptTemplate(args.workspaceRoot, args.config.bootstrapper.promptFile);
  const promptText = [
    promptTemplate.trim(),
    `Bootstrap trigger: ${args.queueItem.reason}`,
    JSON.stringify(args.queueItem.payload, null, 2),
  ].join("\n\n");
  await appendFluxMessage(args.workspaceRoot, args.config, "bootstrapper", sessionId, {
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
    sessionType: "bootstrapper",
    promptText,
    reasoningEffort: args.config.bootstrapper.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
    outputSchema: schemaForName(args.config.bootstrapper.outputSchema),
    workingDirectory: path.resolve(args.workspaceRoot, args.config.bootstrapper.workingDirectory ?? "."),
  });
  await appendFluxMessage(args.workspaceRoot, args.config, "bootstrapper", sessionId, {
    messageId: newId("msg"),
    ts: nowIso(),
    turnIndex: Date.now(),
    kind: "assistant",
    text: turn.assistantText,
    providerThreadId: turn.providerThreadId,
  });
  const attestation = JSON.parse(turn.assistantText || "{}") as Record<string, unknown>;
  const seedBundle = await loadSeedBundle(args.workspaceRoot, args.config);
  if (!seedBundle) throw new Error(`missing seed bundle at ${args.config.bootstrapper.seedBundlePath}`);
  const seedRevisionId = await persistSeedRevision(args.workspaceRoot, args.config, seedBundle);
  const replayProvision = await runFluxProblemCommand(args.config.problem.provisionInstance, {
    workspaceRoot: args.workspaceRoot,
    queueItem: args.queueItem,
    replay: true,
    seedRevisionId,
  });
  const replayResult = await runFluxProblemCommand(args.config.problem.replaySeed, {
    workspaceRoot: args.workspaceRoot,
    seedBundle,
    seedRevisionId,
    instance: replayProvision,
  });
  const replayEvidence = Array.isArray(replayResult.evidence) ? replayResult.evidence : [];
  const appended = await appendEvidence(
    args.workspaceRoot,
    args.config,
    replayEvidence.map((payload) => ({
      ts: nowIso(),
      instanceId: String((replayProvision.instance_id as string | undefined) ?? ""),
      summary: String((payload as any)?.summary ?? "bootstrapper replay evidence"),
      payload: payload as Record<string, unknown>,
    })),
  );
  if (appended.appended.length > 0) {
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "modeler", {
      id: newId("q"),
      sessionType: "modeler",
      createdAt: nowIso(),
      reason: "bootstrapper_replay_evidence",
      payload: { evidenceWatermark: appended.watermark, replayResult },
    });
  }
  if (!args.config.retention.keepAllAttempts) {
    await runFluxProblemCommand(args.config.problem.destroyInstance, {
      workspaceRoot: args.workspaceRoot,
      instance: replayProvision,
    });
  }

  const decision = String(attestation.decision ?? "");
  if (decision === "replay_satisfactory") {
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "solver", {
      id: newId("q"),
      sessionType: "solver",
      createdAt: nowIso(),
      reason: "bootstrapper_approved_seed",
      payload: { seedBundle, seedRevisionId },
    });
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "bootstrapper.attested_satisfactory",
      workspaceRoot: args.workspaceRoot,
      sessionType: "bootstrapper",
      sessionId,
      summary: `seed revision ${seedRevisionId} approved`,
    }]);
  } else {
    const template = await loadFluxPromptTemplate(args.workspaceRoot, args.config.bootstrapper.replay.continueMessageTemplateFile);
    const continueText = renderTemplate(template, {
      replay_results: JSON.stringify(replayResult, null, 2),
    });
    await appendFluxMessage(args.workspaceRoot, args.config, "bootstrapper", sessionId, {
      messageId: newId("msg"),
      ts: nowIso(),
      turnIndex: Date.now(),
      kind: "user",
      text: continueText,
    });
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "bootstrapper", {
      id: newId("q"),
      sessionType: "bootstrapper",
      createdAt: nowIso(),
      reason: "bootstrapper_retry_after_replay",
      payload: { replayResult, seedRevisionId },
    });
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "bootstrapper.attested_retry",
      workspaceRoot: args.workspaceRoot,
      sessionType: "bootstrapper",
      sessionId,
      summary: `seed revision ${seedRevisionId} needs another pass`,
    }]);
  }
  session.status = "idle";
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  latestState.active.bootstrapper = {
    sessionId,
    status: "idle",
    updatedAt: nowIso(),
  };
  await saveFluxState(args.workspaceRoot, args.config, latestState);
}
