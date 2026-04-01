import fs from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../lib/fs.js";
import { sha256Hex } from "../utils/hash.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { parseJsonObjectFromAssistantText, schemaForName } from "./json_session_format.js";
import { runFluxProblemCommand } from "./problem_shell.js";
import { enqueueFluxQueueItem } from "./queue.js";
import { loadFluxPromptTemplate, renderTemplate } from "./prompt_templates.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { appendFluxMessage, loadFluxSession, saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxProblemInstance, FluxQueueItem, FluxRunState, FluxSeedBundle, FluxSessionRecord } from "./types.js";
import { fluxSeedRoot } from "./paths.js";
import { loadFluxState, saveFluxState } from "./state.js";

type SeedMeta = {
  revisionId?: string;
  seedHash?: string;
  updatedAt?: string;
  lastModelRehearsalSeedHash?: string;
  lastModelRehearsalSucceeded?: boolean;
  lastModelRehearsalAt?: string;
  lastModelRehearsalResult?: Record<string, unknown>;
  lastRealReplaySeedHash?: string;
  lastRealReplaySucceeded?: boolean;
  lastRealReplayAt?: string;
  lastRealReplayResult?: Record<string, unknown>;
};

type SeedRevisionPersistResult = {
  revisionId: string;
  seedHash: string;
  changed: boolean;
  meta: SeedMeta;
};

function nowIso(): string {
  return new Date().toISOString();
}

function bootstrapperSessionId(): string {
  return "bootstrapper_run";
}

async function loadSeedBundle(workspaceRoot: string, config: FluxConfig): Promise<FluxSeedBundle | null> {
  return await readJsonIfExists<FluxSeedBundle>(path.resolve(workspaceRoot, config.bootstrapper.seedBundlePath));
}

async function loadSeedMeta(workspaceRoot: string, config: FluxConfig): Promise<SeedMeta> {
  return await readJsonIfExists<SeedMeta>(path.join(fluxSeedRoot(workspaceRoot, config), "current_meta.json")) ?? {};
}

async function saveSeedMeta(workspaceRoot: string, config: FluxConfig, meta: SeedMeta): Promise<void> {
  await writeJsonAtomic(path.join(fluxSeedRoot(workspaceRoot, config), "current_meta.json"), meta);
}

async function persistSeedRevision(workspaceRoot: string, config: FluxConfig, seedBundle: FluxSeedBundle): Promise<SeedRevisionPersistResult> {
  const revisionId = newId("seed_rev");
  const currentDir = fluxSeedRoot(workspaceRoot, config);
  const revisionPath = path.join(currentDir, "revisions", `${revisionId}.json`);
  const previousMeta = await loadSeedMeta(workspaceRoot, config);
  const seedHash = sha256Hex(JSON.stringify(seedBundle));
  const changed = String(previousMeta.seedHash ?? "") !== seedHash;
  const nextMeta: SeedMeta = {
    ...previousMeta,
    revisionId,
    seedHash,
    updatedAt: nowIso(),
  };
  await fs.mkdir(path.dirname(revisionPath), { recursive: true });
  await writeJsonAtomic(path.resolve(workspaceRoot, config.bootstrapper.seedBundlePath), seedBundle);
  await writeJsonAtomic(revisionPath, seedBundle);
  await saveSeedMeta(workspaceRoot, config, nextMeta);
  return { revisionId, seedHash, changed, meta: nextMeta };
}

function currentSeedHasModelRehearsal(meta: SeedMeta, seedHash: string): boolean {
  return Boolean(meta.lastModelRehearsalSucceeded) && String(meta.lastModelRehearsalSeedHash ?? "") === seedHash;
}

function currentSeedHasRealReplay(meta: SeedMeta, seedHash: string): boolean {
  return Boolean(meta.lastRealReplaySucceeded) && String(meta.lastRealReplaySeedHash ?? "") === seedHash;
}

async function recordModelRehearsal(
  workspaceRoot: string,
  config: FluxConfig,
  currentMeta: SeedMeta,
  seedHash: string,
  rehearsalResult: Record<string, unknown>,
): Promise<SeedMeta> {
  const nextMeta: SeedMeta = {
    ...currentMeta,
    lastModelRehearsalSeedHash: seedHash,
    lastModelRehearsalSucceeded: Boolean(rehearsalResult.rehearsal_ok ?? rehearsalResult.ok ?? false),
    lastModelRehearsalAt: nowIso(),
    lastModelRehearsalResult: rehearsalResult,
  };
  await saveSeedMeta(workspaceRoot, config, nextMeta);
  return nextMeta;
}

async function recordRealReplay(
  workspaceRoot: string,
  config: FluxConfig,
  currentMeta: SeedMeta,
  seedHash: string,
  replayResult: Record<string, unknown>,
): Promise<SeedMeta> {
  const nextMeta: SeedMeta = {
    ...currentMeta,
    lastRealReplaySeedHash: seedHash,
    lastRealReplaySucceeded: Boolean(replayResult.replay_ok ?? replayResult.ok ?? false),
    lastRealReplayAt: nowIso(),
    lastRealReplayResult: replayResult,
  };
  await saveSeedMeta(workspaceRoot, config, nextMeta);
  return nextMeta;
}

async function enqueueBootstrapperContinuation(args: {
  workspaceRoot: string;
  config: FluxConfig;
  sessionId: string;
  reason: string;
  payload: Record<string, unknown>;
  modelRehearsalResult?: Record<string, unknown>;
  realReplayResult?: Record<string, unknown>;
}): Promise<void> {
  const template = await loadFluxPromptTemplate(args.workspaceRoot, args.config.bootstrapper.replay.continueMessageTemplateFile);
  const continueText = renderTemplate(template, {
    replay_results: JSON.stringify(args.realReplayResult ?? args.modelRehearsalResult ?? args.payload, null, 2),
    model_rehearsal_results: JSON.stringify(args.modelRehearsalResult ?? {}, null, 2),
    real_replay_results: JSON.stringify(args.realReplayResult ?? {}, null, 2),
  });
  await appendFluxMessage(args.workspaceRoot, args.config, "bootstrapper", args.sessionId, {
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
    reason: args.reason,
    payload: args.payload,
  });
}

async function setBootstrapperIdle(
  workspaceRoot: string,
  config: FluxConfig,
  state: FluxRunState,
  session: FluxSessionRecord,
): Promise<void> {
  session.status = "idle";
  session.updatedAt = nowIso();
  await saveFluxSession(workspaceRoot, config, session);
  const latestState = await loadFluxState(workspaceRoot, config) ?? state;
  latestState.active.bootstrapper = {
    sessionId: session.sessionId,
    status: "idle",
    updatedAt: nowIso(),
  };
  await saveFluxState(workspaceRoot, config, latestState);
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

  const decisionPayload = parseJsonObjectFromAssistantText(turn.assistantText || "") ?? {};
  const decision = String(decisionPayload.decision ?? "");
  const seedBundle = await loadSeedBundle(args.workspaceRoot, args.config);
  if (!seedBundle) throw new Error(`missing seed bundle at ${args.config.bootstrapper.seedBundlePath}`);
  const persistedSeed = await persistSeedRevision(args.workspaceRoot, args.config, seedBundle);
  const seedRevisionId = persistedSeed.revisionId;
  const seedHash = persistedSeed.seedHash;
  let seedMeta = persistedSeed.meta;

  const requiresModelRehearsal = args.config.bootstrapper.requireModelRehearsalBeforeFinalize;
  const hasModelRehearsal = currentSeedHasModelRehearsal(seedMeta, seedHash);
  const hasRealReplay = currentSeedHasRealReplay(seedMeta, seedHash);
  const seedChangedSinceModelRehearsal = !hasModelRehearsal;

  if (seedChangedSinceModelRehearsal) {
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "bootstrapper.model_rehearsal_started",
      workspaceRoot: args.workspaceRoot,
      sessionType: "bootstrapper",
      sessionId,
      summary: `running model rehearsal for ${seedRevisionId}`,
      payload: { seedHash, seedRevisionId, requestedDecision: decision || "continue_refining" },
    }]);
    const rehearsalResult = await runFluxProblemCommand(args.config.problem.rehearseSeedOnModel, {
      workspaceRoot: args.workspaceRoot,
      queueItem: args.queueItem,
      seedBundle,
      seedHash,
      seedRevisionId,
    });
    seedMeta = await recordModelRehearsal(args.workspaceRoot, args.config, seedMeta, seedHash, rehearsalResult);
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: Boolean(rehearsalResult.rehearsal_ok ?? rehearsalResult.ok ?? false)
        ? "bootstrapper.model_rehearsal_passed"
        : "bootstrapper.model_rehearsal_failed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "bootstrapper",
      sessionId,
      summary: `model rehearsal completed for ${seedRevisionId}`,
      payload: { seedHash, seedRevisionId, rehearsalResult },
    }]);
    if (decision === "finalize_seed" && requiresModelRehearsal) {
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "bootstrapper.finalize_rejected_pending_rehearsal",
        workspaceRoot: args.workspaceRoot,
        sessionType: "bootstrapper",
        sessionId,
        summary: `seed ${seedRevisionId} changed since the last rehearsal; rerunning on model before finalize`,
        payload: { seedHash, seedRevisionId },
      }]);
    }
    await enqueueBootstrapperContinuation({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      sessionId,
      reason: "bootstrapper_retry_after_model_rehearsal",
      payload: { rehearsalResult, seedRevisionId, seedHash },
      modelRehearsalResult: rehearsalResult,
    });
    await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
    return;
  }

  if (decision !== "finalize_seed") {
    const rehearsalResult = seedMeta.lastModelRehearsalResult ?? {};
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "bootstrapper.attested_retry",
      workspaceRoot: args.workspaceRoot,
      sessionType: "bootstrapper",
      sessionId,
      summary: `bootstrapper requested another pass for ${seedRevisionId}`,
      payload: { seedHash, seedRevisionId, changed: persistedSeed.changed },
    }]);
    if (persistedSeed.changed) {
      await enqueueBootstrapperContinuation({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        sessionId,
        reason: "bootstrapper_retry_after_model_rehearsal",
        payload: { rehearsalResult, seedRevisionId, seedHash },
        modelRehearsalResult: rehearsalResult,
      });
    } else {
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "bootstrapper.waiting_for_new_inputs",
        workspaceRoot: args.workspaceRoot,
        sessionType: "bootstrapper",
        sessionId,
        summary: `bootstrapper made no seed changes for ${seedRevisionId}; waiting for new model/evidence inputs`,
        payload: { seedHash, seedRevisionId },
      }]);
    }
    await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
    return;
  }

  if (requiresModelRehearsal && !hasModelRehearsal) {
    throw new Error(`seed ${seedRevisionId} cannot finalize without model rehearsal`);
  }

  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "bootstrapper.real_replay_started",
    workspaceRoot: args.workspaceRoot,
    sessionType: "bootstrapper",
    sessionId,
    summary: `running real replay for ${seedRevisionId}`,
    payload: { seedHash, seedRevisionId },
  }]);
  const provisioned = await runFluxProblemCommand(args.config.problem.provisionInstance, {
    workspaceRoot: args.workspaceRoot,
    queueItem: args.queueItem,
    replay: true,
    seedRevisionId,
  });
  const realReplayResult = await runFluxProblemCommand(args.config.problem.replaySeedOnRealGame, {
    workspaceRoot: args.workspaceRoot,
    seedBundle,
    seedHash,
    seedRevisionId,
    instance: provisioned,
  });
  seedMeta = await recordRealReplay(args.workspaceRoot, args.config, seedMeta, seedHash, realReplayResult);

  if (!Boolean(realReplayResult.replay_ok ?? realReplayResult.ok ?? false)) {
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "bootstrapper.real_replay_failed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "bootstrapper",
      sessionId,
      summary: `real replay failed for ${seedRevisionId}`,
      payload: { seedHash, seedRevisionId, realReplayResult },
    }]);
    await enqueueBootstrapperContinuation({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      sessionId,
      reason: "bootstrapper_retry_after_real_replay",
      payload: { realReplayResult, seedRevisionId, seedHash },
      realReplayResult,
    });
    await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
    return;
  }

  if (!(hasRealReplay && !persistedSeed.changed)) {
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "solver", {
      id: newId("q"),
      sessionType: "solver",
      createdAt: nowIso(),
      reason: "bootstrapper_finalized_seed",
      dedupeKey: `solver-seed:${seedHash}`,
      payload: {
        seedBundle,
        seedRevisionId,
        seedHash,
        attemptId: String((provisioned.attempt_id as string | undefined) ?? ""),
        preplayedInstance: provisioned as FluxProblemInstance & Record<string, unknown>,
        preplayedReplayResult: realReplayResult,
      },
    });
  }
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "bootstrapper.real_replay_passed",
    workspaceRoot: args.workspaceRoot,
    sessionType: "bootstrapper",
    sessionId,
    summary: `real replay passed for ${seedRevisionId}`,
    payload: { seedHash, seedRevisionId, hasRealReplay, realReplayResult },
  }, {
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "bootstrapper.attested_satisfactory",
    workspaceRoot: args.workspaceRoot,
    sessionType: "bootstrapper",
    sessionId,
    summary: `seed revision ${seedRevisionId} finalized`,
    payload: { seedHash, changed: persistedSeed.changed, queuedSolver: !(hasRealReplay && !persistedSeed.changed) },
  }]);

  await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
}
