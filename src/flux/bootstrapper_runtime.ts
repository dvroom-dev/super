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
import { loadSeedMeta, saveSeedMeta, type FluxSeedMeta } from "./seed_meta.js";
import { validateFluxSeedBundle } from "./seed_bundle.js";
import { appendFluxMessage, loadFluxSession, saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxProblemInstance, FluxQueueItem, FluxRunState, FluxSeedBundle, FluxSessionRecord, FluxSolverInterruptPolicy } from "./types.js";
import { fluxSeedRoot } from "./paths.js";
import { mutateFluxState } from "./state.js";

type SeedRevisionPersistResult = {
  revisionId: string;
  seedHash: string;
  changed: boolean;
  meta: FluxSeedMeta;
};

function nowIso(): string {
  return new Date().toISOString();
}

function bootstrapperSessionId(): string {
  return "bootstrapper_run";
}

function seedBundleCurrentPath(workspaceRoot: string, config: FluxConfig): string {
  return path.resolve(workspaceRoot, config.bootstrapper.seedBundlePath);
}

function seedBundleCandidatePath(workspaceRoot: string, config: FluxConfig): string {
  const currentPath = seedBundleCurrentPath(workspaceRoot, config);
  return path.join(path.dirname(currentPath), "candidate.json");
}

async function ensureSeedCandidateExists(workspaceRoot: string, config: FluxConfig): Promise<void> {
  const candidatePath = seedBundleCandidatePath(workspaceRoot, config);
  const currentPath = seedBundleCurrentPath(workspaceRoot, config);
  if (await readJsonIfExists(candidatePath)) {
    return;
  }
  const currentSeed = await readJsonIfExists<unknown>(currentPath);
  if (!currentSeed) {
    return;
  }
  await fs.mkdir(path.dirname(candidatePath), { recursive: true });
  await writeJsonAtomic(candidatePath, currentSeed);
}

async function loadSeedBundleFromPath(seedPath: string): Promise<FluxSeedBundle | null> {
  const seedBundle = await readJsonIfExists<unknown>(seedPath);
  return seedBundle ? validateFluxSeedBundle(seedBundle) : null;
}

async function persistSeedRevision(workspaceRoot: string, config: FluxConfig, seedBundle: FluxSeedBundle): Promise<SeedRevisionPersistResult> {
  const currentDir = fluxSeedRoot(workspaceRoot, config);
  const currentPath = seedBundleCurrentPath(workspaceRoot, config);
  const candidatePath = seedBundleCandidatePath(workspaceRoot, config);
  const previousMeta = await loadSeedMeta(workspaceRoot, config);
  const seedHash = sha256Hex(JSON.stringify(seedBundle));
  const changed = String(previousMeta.seedHash ?? "") !== seedHash;
  const previousRevisionId = typeof previousMeta.revisionId === "string" && previousMeta.revisionId.trim().length > 0
    ? previousMeta.revisionId
    : null;
  const revisionId = changed || !previousRevisionId ? newId("seed_rev") : previousRevisionId;
  const revisionPath = path.join(currentDir, "revisions", `${revisionId}.json`);
  const nextMeta: FluxSeedMeta = {
    ...previousMeta,
    revisionId,
    seedHash,
    updatedAt: nowIso(),
  };
  await writeJsonAtomic(currentPath, seedBundle);
  await writeJsonAtomic(candidatePath, seedBundle);
  if (changed || !previousRevisionId) {
    await fs.mkdir(path.dirname(revisionPath), { recursive: true });
    await writeJsonAtomic(revisionPath, seedBundle);
  }
  await saveSeedMeta(workspaceRoot, config, nextMeta);
  return { revisionId, seedHash, changed, meta: nextMeta };
}

function currentSeedHasModelRehearsal(meta: FluxSeedMeta, seedHash: string): boolean {
  return Boolean(meta.lastModelRehearsalSucceeded) && String(meta.lastModelRehearsalSeedHash ?? "") === seedHash;
}

function currentSeedHasRealReplay(meta: FluxSeedMeta, seedHash: string): boolean {
  return Boolean(meta.lastRealReplaySucceeded) && String(meta.lastRealReplaySeedHash ?? "") === seedHash;
}

async function recordModelRehearsal(
  workspaceRoot: string,
  config: FluxConfig,
  currentMeta: FluxSeedMeta,
  seedHash: string,
  rehearsalResult: Record<string, unknown>,
): Promise<FluxSeedMeta> {
  const nextMeta: FluxSeedMeta = {
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
  currentMeta: FluxSeedMeta,
  seedHash: string,
  replayResult: Record<string, unknown>,
): Promise<FluxSeedMeta> {
  const nextMeta: FluxSeedMeta = {
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

async function recordSeedReuse(args: {
  workspaceRoot: string;
  config: FluxConfig;
  sessionId: string;
  seedMeta: FluxSeedMeta;
  seedRevisionId: string;
  seedHash: string;
  promptPayload: Record<string, unknown>;
  interruptPolicy: FluxSolverInterruptPolicy;
  seedDeltaKind: string;
}): Promise<FluxSeedMeta> {
  const nextMeta: FluxSeedMeta = {
    ...args.seedMeta,
    lastBootstrapperModelRevisionId: typeof args.promptPayload.baselineModelRevisionId === "string"
      ? args.promptPayload.baselineModelRevisionId
      : args.seedMeta.lastBootstrapperModelRevisionId,
    lastBootstrapperCoverageSummary: coverageSummaryFromPromptPayload(args.promptPayload.coverageSummary) ?? args.seedMeta.lastBootstrapperCoverageSummary,
    lastQueuedBootstrapCoverageSummary: coverageSummaryFromPromptPayload(args.promptPayload.coverageSummary) ?? args.seedMeta.lastQueuedBootstrapCoverageSummary,
    lastAttestedSeedRevisionId: args.seedRevisionId,
    lastAttestedSeedHash: args.seedHash,
    lastInterruptPolicy: args.interruptPolicy,
    lastSeedDeltaKind: args.seedDeltaKind || args.seedMeta.lastSeedDeltaKind,
  };
  await saveSeedMeta(args.workspaceRoot, args.config, nextMeta);
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "bootstrapper.reuse_accepted",
    workspaceRoot: args.workspaceRoot,
    sessionType: "bootstrapper",
    sessionId: args.sessionId,
    summary: `seed revision ${args.seedRevisionId} already attested; reusing accepted seed`,
    payload: {
      seedHash: args.seedHash,
      seedRevisionId: args.seedRevisionId,
      changed: false,
      interruptPolicy: args.interruptPolicy,
      seedDeltaKind: args.seedDeltaKind || null,
      baselineModelRevisionId: typeof args.promptPayload.baselineModelRevisionId === "string" ? args.promptPayload.baselineModelRevisionId : null,
    },
  }]);
  return nextMeta;
}

function normalizeInterruptPolicy(value: unknown): FluxSolverInterruptPolicy {
  const normalized = String(value ?? "").trim();
  if (normalized === "queue_and_interrupt" || normalized === "queue_without_interrupt" || normalized === "no_action") {
    return normalized;
  }
  return "queue_without_interrupt";
}

function coverageSummaryFromPromptPayload(value: unknown): FluxSeedMeta["lastBootstrapperCoverageSummary"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.coveredSequenceIds) ? record as FluxSeedMeta["lastBootstrapperCoverageSummary"] : undefined;
}

function expectedFrontierLevelFromPromptPayload(payload: Record<string, unknown>): number | null {
  const coverageSummary = coverageSummaryFromPromptPayload(payload.coverageSummary);
  const explicit = Number(coverageSummary?.frontierLevel ?? payload.frontierLevel ?? payload.modelFrontierLevel ?? 0) || 0;
  if (explicit > 0) return explicit;
  const progress = payload.modelProgress && typeof payload.modelProgress === "object" && !Array.isArray(payload.modelProgress)
    ? payload.modelProgress as Record<string, unknown>
    : {};
  const fallback = Number(progress.level ?? coverageSummary?.level ?? 0) || 0;
  return fallback > 0 ? fallback : null;
}

function rehearsalReachedFrontier(rehearsalResult: Record<string, unknown>, expectedFrontierLevel: number | null): boolean {
  const ok = Boolean(rehearsalResult.rehearsal_ok ?? rehearsalResult.ok ?? false);
  if (!ok) return false;
  const statusAfter = rehearsalResult.status_after && typeof rehearsalResult.status_after === "object" && !Array.isArray(rehearsalResult.status_after)
    ? rehearsalResult.status_after as Record<string, unknown>
    : {};
  const comparePayload = rehearsalResult.compare_payload && typeof rehearsalResult.compare_payload === "object" && !Array.isArray(rehearsalResult.compare_payload)
    ? rehearsalResult.compare_payload as Record<string, unknown>
    : {};
  const compareAllMatch = Boolean(comparePayload.all_match);
  const comparedSequences = Number(comparePayload.compared_sequences ?? 0) || 0;
  const eligibleSequences = Number(comparePayload.eligible_sequences ?? 0) || 0;
  if ((comparedSequences > 0 || eligibleSequences > 0) && !compareAllMatch) {
    return false;
  }
  if (!expectedFrontierLevel || expectedFrontierLevel <= 0) return true;
  const reachedLevel = Math.max(
    Number(statusAfter.current_level ?? 0) || 0,
    Number(comparePayload.frontier_level ?? comparePayload.level ?? 0) || 0,
  );
  return reachedLevel >= expectedFrontierLevel;
}

async function setBootstrapperIdle(
  workspaceRoot: string,
  config: FluxConfig,
  state: FluxRunState,
  session: FluxSessionRecord,
): Promise<void> {
  session.status = "idle";
  session.stopReason = undefined;
  session.updatedAt = nowIso();
  await saveFluxSession(workspaceRoot, config, session);
  await mutateFluxState(workspaceRoot, config, async (current) => {
    const latestState = current ?? state;
    latestState.active.bootstrapper = {
      sessionId: session.sessionId,
      status: "idle",
      updatedAt: nowIso(),
    };
    return latestState;
  });
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
  session.stopReason = undefined;
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  const latestState = await mutateFluxState(args.workspaceRoot, args.config, async (current) => {
    const next = current ?? args.state;
    next.active.bootstrapper = {
      sessionId,
      status: "running",
      queueItemId: args.queueItem.id,
      pid: process.pid,
      updatedAt: nowIso(),
    };
    return next;
  });
  await ensureSeedCandidateExists(args.workspaceRoot, args.config);

  const promptTemplate = await loadFluxPromptTemplate(args.workspaceRoot, args.config.bootstrapper.promptFile);
  const promptPayload = args.queueItem.payload;
  const promptText = [
    promptTemplate.trim(),
    `Bootstrap trigger: ${args.queueItem.reason}`,
    JSON.stringify(promptPayload, null, 2),
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
  const interruptPolicy = normalizeInterruptPolicy(decisionPayload.solver_action);
  const seedDeltaKind = String(decisionPayload.seed_delta_kind ?? "");
  let seedBundle: FluxSeedBundle | null = null;
  const candidatePath = seedBundleCandidatePath(args.workspaceRoot, args.config);
  try {
    seedBundle = await loadSeedBundleFromPath(candidatePath);
  } catch (error) {
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "bootstrapper.seed_invalid",
      workspaceRoot: args.workspaceRoot,
      sessionType: "bootstrapper",
      sessionId,
      summary: String(error instanceof Error ? error.message : error),
      payload: {
        decision,
        interruptPolicy,
        seedDeltaKind: seedDeltaKind || null,
        candidatePath,
      },
    }]);
    await enqueueBootstrapperContinuation({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      sessionId,
      reason: "bootstrapper_invalid_seed",
      payload: {
        ...promptPayload,
        validationError: String(error instanceof Error ? error.message : error),
        candidatePath,
      },
    });
    await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
    return;
  }
  if (!seedBundle) {
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "bootstrapper.seed_missing",
      workspaceRoot: args.workspaceRoot,
      sessionType: "bootstrapper",
      sessionId,
      summary: `missing seed bundle candidate at ${candidatePath}`,
    }]);
    await enqueueBootstrapperContinuation({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      sessionId,
      reason: "bootstrapper_missing_seed",
      payload: {
        ...promptPayload,
        validationError: `missing seed bundle candidate at ${candidatePath}`,
        candidatePath,
      },
    });
    await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
    return;
  }
  const persistedSeed = await persistSeedRevision(args.workspaceRoot, args.config, seedBundle);
  const seedRevisionId = persistedSeed.revisionId;
  const seedHash = persistedSeed.seedHash;
  let seedMeta = persistedSeed.meta;

  const requiresModelRehearsal = args.config.bootstrapper.requireModelRehearsalBeforeFinalize;
  let hasModelRehearsal = currentSeedHasModelRehearsal(seedMeta, seedHash);
  const hasRealReplay = currentSeedHasRealReplay(seedMeta, seedHash);
  const seedChangedSinceModelRehearsal = !hasModelRehearsal;
  const expectedFrontierLevel = expectedFrontierLevelFromPromptPayload(promptPayload);

  if (
    decision === "finalize_seed"
    && !persistedSeed.changed
    && hasModelRehearsal
    && hasRealReplay
    && String(seedMeta.lastAttestedSeedHash ?? "") === seedHash
  ) {
    await recordSeedReuse({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      sessionId,
      seedMeta,
      seedRevisionId,
      seedHash,
      promptPayload,
      interruptPolicy,
      seedDeltaKind,
    });
    await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
    return;
  }

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
      modelRevisionId: promptPayload.baselineModelRevisionId,
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
    hasModelRehearsal = currentSeedHasModelRehearsal(seedMeta, seedHash);
    const rehearsalSatisfiedFrontier = rehearsalReachedFrontier(rehearsalResult, expectedFrontierLevel);
    if (!rehearsalSatisfiedFrontier) {
      if (decision === "finalize_seed" && requiresModelRehearsal) {
        await appendFluxEvents(args.workspaceRoot, args.config, [{
          eventId: newId("evt"),
          ts: nowIso(),
          kind: "bootstrapper.finalize_rejected_pending_rehearsal",
          workspaceRoot: args.workspaceRoot,
          sessionType: "bootstrapper",
          sessionId,
          summary: `seed ${seedRevisionId} did not reach frontier level ${expectedFrontierLevel ?? "?"} during rehearsal`,
          payload: { seedHash, seedRevisionId, expectedFrontierLevel, rehearsalResult },
        }]);
      }
      await enqueueBootstrapperContinuation({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        sessionId,
        reason: "bootstrapper_retry_after_model_rehearsal",
        payload: {
          ...promptPayload,
          rehearsalResult,
          seedRevisionId,
          seedHash,
          expectedFrontierLevel,
        },
        modelRehearsalResult: rehearsalResult,
      });
      await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
      return;
    }
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "bootstrapper.auto_accepted_after_rehearsal",
      workspaceRoot: args.workspaceRoot,
      sessionType: "bootstrapper",
      sessionId,
      summary: `seed ${seedRevisionId} reached frontier level ${expectedFrontierLevel ?? "?"} during rehearsal; auto-accepting`,
      payload: { seedHash, seedRevisionId, expectedFrontierLevel, originalDecision: decision || "continue_refining" },
    }]);
  }

  if (seedChangedSinceModelRehearsal && decision !== "finalize_seed") {
    // A changed seed that already replays to the model frontier does not need a second bootstrapper turn.
    // Continue through real replay/finalization using the original solver action and delta classification.
  } else if (decision === "finalize_seed" && requiresModelRehearsal && !hasModelRehearsal) {
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

  if (!seedChangedSinceModelRehearsal && decision !== "finalize_seed") {
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
        payload: {
          ...promptPayload,
          rehearsalResult,
          seedRevisionId,
          seedHash,
        },
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
      payload: {
        ...promptPayload,
        realReplayResult,
        seedRevisionId,
        seedHash,
      },
      realReplayResult,
    });
    await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
    return;
  }

  const shouldQueueSolver = interruptPolicy !== "no_action" && !(hasRealReplay && !persistedSeed.changed);
  if (shouldQueueSolver) {
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "solver", {
      id: newId("q"),
      sessionType: "solver",
      createdAt: nowIso(),
      reason: "bootstrapper_finalized_seed",
      dedupeKey: `solver-seed:${seedHash}`,
      payload: {
        reason: "bootstrapper_finalized_seed",
        seedRevisionId,
        seedHash,
      attemptId: String((provisioned.attempt_id as string | undefined) ?? ""),
      preplayedInstance: provisioned as FluxProblemInstance & Record<string, unknown>,
      preplayedReplayResult: realReplayResult,
      seedBundle,
      interruptPolicy,
    },
  });
  }
  seedMeta = {
    ...seedMeta,
    lastBootstrapperModelRevisionId: typeof promptPayload.baselineModelRevisionId === "string" ? promptPayload.baselineModelRevisionId : seedMeta.lastBootstrapperModelRevisionId,
    lastBootstrapperCoverageSummary: coverageSummaryFromPromptPayload(promptPayload.coverageSummary) ?? seedMeta.lastBootstrapperCoverageSummary,
    lastQueuedBootstrapCoverageSummary: coverageSummaryFromPromptPayload(promptPayload.coverageSummary) ?? seedMeta.lastQueuedBootstrapCoverageSummary,
    lastAttestedSeedRevisionId: seedRevisionId,
    lastAttestedSeedHash: seedHash,
    lastQueuedSolverSeedHash: shouldQueueSolver ? seedHash : seedMeta.lastQueuedSolverSeedHash,
    lastInterruptPolicy: interruptPolicy,
    lastSeedDeltaKind: seedDeltaKind || seedMeta.lastSeedDeltaKind,
  };
  await saveSeedMeta(args.workspaceRoot, args.config, seedMeta);
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
    payload: {
      seedHash,
      changed: persistedSeed.changed,
      queuedSolver: shouldQueueSolver,
      interruptPolicy,
      seedDeltaKind: seedDeltaKind || null,
      baselineModelRevisionId: typeof promptPayload.baselineModelRevisionId === "string" ? promptPayload.baselineModelRevisionId : null,
    },
  }]);

  await setBootstrapperIdle(args.workspaceRoot, args.config, args.state, session);
}
