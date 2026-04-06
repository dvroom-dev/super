import path from "node:path";
import { readJsonIfExists } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { appendEvidence } from "./evidence.js";
import { formatEvidenceForPrompt, formatSeedBundleForPrompt, formatSeedReplayResultForPrompt } from "./json_session_format.js";
import { runFluxProblemCommand } from "./problem_shell.js";
import { enqueueFluxQueueItem } from "./queue.js";
import { loadFluxPromptTemplate } from "./prompt_templates.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { validateFluxSeedBundle } from "./seed_bundle.js";
import { appendFluxMessage, loadFluxSession, saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxQueueItem, FluxRunState, FluxSeedBundle, FluxSessionRecord } from "./types.js";
import { mutateFluxState } from "./state.js";

type ActiveSolverControl = {
  controller: AbortController;
  interruptRequested: boolean;
};

const activeSolverControls = new Map<string, ActiveSolverControl>();

function nowIso(): string {
  return new Date().toISOString();
}

function maxObservedStepCount(payloads: Record<string, unknown>[]): number {
  let maxSteps = 0;
  for (const payload of payloads) {
    const state = payload.state;
    if (state && typeof state === "object" && !Array.isArray(state)) {
      const record = state as Record<string, unknown>;
      maxSteps = Math.max(
        maxSteps,
        Number(record.current_attempt_steps ?? 0) || 0,
        Number(record.total_steps ?? 0) || 0,
      );
    }
    maxSteps = Math.max(maxSteps, Number(payload.action_count ?? 0) || 0);
  }
  return maxSteps;
}

function buildInitialSolverPrompt(args: {
  template: string;
  instancePromptText?: string;
  seedBundle?: FluxSeedBundle | null;
  seedReplayResult?: Record<string, unknown> | null;
}): string {
  const parts = [args.template.trim()];
  if (args.seedBundle && args.seedBundle.syntheticMessages.length === 0) {
    parts.push(formatSeedBundleForPrompt(args.seedBundle));
  }
  if (args.seedReplayResult) {
    parts.push(formatSeedReplayResultForPrompt(args.seedReplayResult));
  }
  if (args.instancePromptText) parts.push(args.instancePromptText.trim());
  return parts.filter(Boolean).join("\n\n");
}

async function loadCurrentSeedBundle(workspaceRoot: string, config: FluxConfig): Promise<FluxSeedBundle | null> {
  const raw = await readJsonIfExists<unknown>(path.resolve(workspaceRoot, config.bootstrapper.seedBundlePath));
  if (!raw) return null;
  const seed = validateFluxSeedBundle(raw);
  const hasMaterial = seed.syntheticMessages.length > 0
    || seed.replayPlan.length > 0
    || seed.assertions.length > 0
    || typeof seed.modelRevisionId === "string"
    || typeof seed.evidenceWatermark === "string";
  return hasMaterial ? seed : null;
}

async function observeAndPublishSolverEvidence(args: {
  workspaceRoot: string;
  config: FluxConfig;
  sessionId: string;
  attemptId: string;
  instanceId: string;
  workingDirectory: string;
  provisioned: Record<string, unknown>;
  replayBaselineSteps: number;
  reason: "solver_running" | "solver_stopped";
  lastWatermark: string;
}): Promise<{
  watermark: string;
  hasRealActionEvidence: boolean;
  evidenceCount: number;
  evidenceRecords: Record<string, unknown>[];
  incompleteSurface: Record<string, unknown> | null;
}> {
  const observed = await runFluxProblemCommand(args.config.problem.observeEvidence, {
    workspaceRoot: args.workspaceRoot,
    attemptId: args.attemptId,
    instanceId: args.instanceId,
    workingDirectory: args.workingDirectory,
    instance: args.provisioned,
  });
  const evidenceList = Array.isArray(observed.evidence) ? observed.evidence : [];
  const evidenceBundleId = typeof observed.evidence_bundle_id === "string" ? observed.evidence_bundle_id : "";
  const evidenceBundlePath = typeof observed.evidence_bundle_path === "string" ? observed.evidence_bundle_path : "";
  const evidenceRecords = evidenceList.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const incompleteSurface = evidenceRecords.find((payload) =>
    Boolean((payload as Record<string, unknown>).artifact_handoff_incomplete),
  ) ?? null;
  if (incompleteSurface) {
    const artifactHandoffIncomplete = (incompleteSurface as Record<string, unknown>).artifact_handoff_incomplete;
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "solver.evidence_surface_incomplete",
      workspaceRoot: args.workspaceRoot,
      sessionType: "solver",
      sessionId: args.sessionId,
      summary: "solver evidence surface is behind the live state; withholding modeler enqueue",
      payload: {
        attemptId: args.attemptId,
        instanceId: args.instanceId,
        artifactHandoffIncomplete,
      },
    }]);
    return {
      watermark: args.lastWatermark,
      hasRealActionEvidence: false,
      evidenceCount: evidenceList.length,
      evidenceRecords,
      incompleteSurface: artifactHandoffIncomplete && typeof artifactHandoffIncomplete === "object" && !Array.isArray(artifactHandoffIncomplete)
        ? artifactHandoffIncomplete as Record<string, unknown>
        : null,
    };
  }
  const observedStepCount = maxObservedStepCount(evidenceRecords);
  const hasRealActionEvidence = evidenceRecords.some((payload) => {
    const record = payload as Record<string, unknown>;
    const state = record.state && typeof record.state === "object" && !Array.isArray(record.state)
      ? record.state as Record<string, unknown>
      : {};
    const totalSteps = Math.max(
      Number(record.action_count ?? 0) || 0,
      Number(state.current_attempt_steps ?? 0) || 0,
      Number(state.total_steps ?? 0) || 0,
    );
    return totalSteps > args.replayBaselineSteps;
  }) || observedStepCount > args.replayBaselineSteps;
  const { watermark, appended } = await appendEvidence(
    args.workspaceRoot,
    args.config,
    evidenceList.map((payload) => ({
      ts: nowIso(),
      attemptId: args.attemptId,
      instanceId: args.instanceId,
      summary: String((payload as any)?.summary ?? "solver evidence"),
      payload: payload as Record<string, unknown>,
    })),
  );
  if (appended.length > 0 && watermark && watermark !== args.lastWatermark) {
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "solver.evidence_observed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "solver",
      sessionId: args.sessionId,
      summary: `observed ${evidenceList.length} evidence records`,
      payload: { attemptId: args.attemptId, instanceId: args.instanceId, watermark, count: evidenceList.length, reason: args.reason },
    }]);
    if (hasRealActionEvidence) {
      await enqueueFluxQueueItem(args.workspaceRoot, args.config, "modeler", {
        id: newId("q"),
        sessionType: "modeler",
        createdAt: nowIso(),
        reason: args.reason === "solver_running" ? "solver_new_evidence" : "solver_stopped",
        dedupeKey: `evidence:${watermark}`,
        payload: {
          attemptId: args.attemptId,
          instanceId: args.instanceId,
          evidenceWatermark: watermark,
          evidenceCount: evidenceList.length,
          latestEvidence: evidenceRecords[evidenceRecords.length - 1] ?? null,
          evidenceBundleId: evidenceBundleId || undefined,
          evidenceBundlePath: evidenceBundlePath || undefined,
        },
      });
    }
  }
  return { watermark, hasRealActionEvidence, evidenceCount: evidenceList.length, evidenceRecords, incompleteSurface: null };
}

function isLevelSolvedFromEvidence(evidenceRecords: Record<string, unknown>[]): boolean {
  const latest = evidenceRecords[evidenceRecords.length - 1];
  const state = latest?.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const record = state as Record<string, unknown>;
  const status = String(record.state ?? "").toUpperCase();
  const levelsCompleted = Number(record.levels_completed ?? 0) || 0;
  const winLevels = Number(record.win_levels ?? 0) || 0;
  return status === "WIN" || status === "FINISHED" || (winLevels > 0 && levelsCompleted >= winLevels);
}

export function buildContinuationPrompt(
  evidenceRecords: Record<string, unknown>[],
  options?: { noProgress?: boolean },
): string {
  const latest = evidenceRecords[evidenceRecords.length - 1] ?? {};
  const latestState = latest.state && typeof latest.state === "object" && !Array.isArray(latest.state)
    ? latest.state as Record<string, unknown>
    : {};
  const currentLevel = Number(latestState.current_level ?? 0) || 0;
  const levelsCompleted = Number(latestState.levels_completed ?? 0) || 0;
  const frontierLine = currentLevel > 1 || levelsCompleted > 0
    ? `- You are already at frontier level ${currentLevel || "unknown"}. Do not redo the solved prefix unless live evidence contradicts it.`
    : "- You are still working on level 1.";
  const noProgressLines = options?.noProgress ? [
    "- Your last turn did not produce new game progress from the current state.",
    "- Do not stop or summarize.",
    "- Immediately try a different concrete branch from the current live state.",
    "- If your last action sequence only reconfirmed an already-known blockage, change the earliest branch choice now.",
    "- If one action is now a no-op at the frontier, try a different action or a different ordering from the same state before considering reset.",
  ] : [];
  return [
    "Continue solving from the current live state.",
    "",
    frontierLine,
    ...noProgressLines,
    "- Do not stop to summarize.",
    "- Keep taking real actions until the level is solved or you are explicitly interrupted.",
    "- Prefer continuing from the current state over resetting.",
    "- Treat compare and BFS output as diagnostic only. Do not assume a no-op or long reachable path is correct until the real game confirms it.",
    "- If a long route snaps back to start, consumes only life/fuel/bar pixels, or reveals a hidden reset, mark that branch invalid at the first trigger step and change the earliest branch choice.",
    "- After a blocked or no-op action from the same state, switch branch instead of repeating the same action again.",
    "",
    "Latest observed evidence:",
    formatEvidenceForPrompt(latest),
  ].join("\n");
}

export function requestActiveSolverInterrupt(sessionId: string): boolean {
  const control = activeSolverControls.get(sessionId);
  if (!control || control.interruptRequested) return false;
  control.interruptRequested = true;
  control.controller.abort();
  return true;
}

export async function runSolverQueueItem(args: {
  workspaceRoot: string;
  config: FluxConfig;
  queueItem: FluxQueueItem;
  state: FluxRunState;
  signal?: AbortSignal;
}): Promise<void> {
  const launchContext = args.queueItem.payload;
  const preplayedInstance = launchContext.preplayedInstance;
  const rawAttemptId = typeof launchContext.attemptId === "string"
    ? String(launchContext.attemptId).trim()
    : "";
  const attemptId = rawAttemptId || newId("attempt");
  const provisioned = preplayedInstance && typeof preplayedInstance === "object" && !Array.isArray(preplayedInstance)
    ? preplayedInstance as Record<string, unknown>
    : await runFluxProblemCommand(args.config.problem.provisionInstance, {
        workspaceRoot: args.workspaceRoot,
        queueItem: args.queueItem,
        attemptId,
      });
  const instanceId = String(provisioned.instance_id ?? newId("instance"));
  const workingDirectory = path.resolve(args.workspaceRoot, String(provisioned.working_directory ?? args.workspaceRoot));
  const sessionId = `solver_${attemptId}`;
  const startingState = await mutateFluxState(args.workspaceRoot, args.config, async (current) => {
    const next = current ?? args.state;
    next.active.solver = {
      sessionId,
      status: "running",
      queueItemId: args.queueItem.id,
      pid: process.pid,
      attemptId,
      instanceId,
      updatedAt: nowIso(),
    };
    return next;
  });
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "solver.instance_provisioned",
    workspaceRoot: args.workspaceRoot,
    sessionType: "solver",
    sessionId,
    queueItemId: args.queueItem.id,
    summary: `solver instance provisioned: ${instanceId}`,
    payload: { attemptId, instanceId, workingDirectory },
  }]);

  const session: FluxSessionRecord = {
    sessionId,
    sessionType: "solver",
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    provider: args.config.solver.provider ?? args.config.runtimeDefaults.provider,
    model: args.config.solver.model ?? args.config.runtimeDefaults.model,
    resumePolicy: "never",
    sessionScope: "per_attempt",
    activeAttemptId: attemptId,
  };
  await saveFluxSession(args.workspaceRoot, args.config, session);

  const seedBundle = (launchContext.seedBundle as FluxSeedBundle | undefined) ?? await loadCurrentSeedBundle(args.workspaceRoot, args.config) ?? undefined;
  if (seedBundle?.syntheticMessages?.length) {
    for (const [index, message] of seedBundle.syntheticMessages.entries()) {
      await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
        messageId: newId("msg"),
        ts: nowIso(),
        turnIndex: index + 1,
        kind: message.role === "assistant" ? "synthetic_assistant" : "user",
        text: message.text,
        synthetic: true,
      });
    }
  }
  let seedReplayResult: Record<string, unknown> | null = launchContext.preplayedReplayResult
    && typeof launchContext.preplayedReplayResult === "object"
    && !Array.isArray(launchContext.preplayedReplayResult)
    ? launchContext.preplayedReplayResult as Record<string, unknown>
    : null;
  let replayBaselineSteps = 0;
  if (!preplayedInstance && seedBundle?.replayPlan?.length) {
    seedReplayResult = await runFluxProblemCommand(args.config.problem.replaySeedOnRealGame, {
      workspaceRoot: args.workspaceRoot,
      attemptId,
      instanceId,
      seedBundle,
      instance: provisioned,
    });
    const replayEvidence = Array.isArray(seedReplayResult.evidence)
      ? seedReplayResult.evidence.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
    replayBaselineSteps = maxObservedStepCount(replayEvidence);
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "solver.seed_replayed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "solver",
      sessionId,
      summary: preplayedInstance ? "attached preplayed seed state before solver turn" : "replayed seed bundle before solver turn",
      payload: { attemptId, instanceId, preplayed: Boolean(preplayedInstance) },
    }]);
  }
  const promptTemplate = await loadFluxPromptTemplate(args.workspaceRoot, args.config.solver.promptFile);
  const promptText = buildInitialSolverPrompt({
    template: promptTemplate,
    seedBundle: seedBundle ?? null,
    seedReplayResult,
    instancePromptText: typeof provisioned.prompt_text === "string" ? String(provisioned.prompt_text) : undefined,
  });
  const promptImageValues = (provisioned as Record<string, unknown>).prompt_images;
  const promptImages = Array.isArray(promptImageValues)
    ? promptImageValues
        .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value: string) => String(value))
    : [];
  await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
    messageId: newId("msg"),
    ts: nowIso(),
    turnIndex: 1,
    kind: "user",
    text: promptText,
  });
  const controller = new AbortController();
  activeSolverControls.set(sessionId, { controller, interruptRequested: false });
  let latestWatermark = "";
  let latestEvidenceRecords: Record<string, unknown>[] = [];
  let latestObservedStepCount = replayBaselineSteps;
  let incompleteSurfaceFingerprint = "";
  let incompleteSurfaceRepeatCount = 0;
  let latchedInfrastructureFailure: { reason: string; payload: Record<string, unknown> } | null = null;
  let pollStopped = false;
  const pollLoop = (async () => {
    while (!pollStopped && !controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, args.config.orchestrator.evidencePollMs));
      if (pollStopped || controller.signal.aborted) break;
      const result = await observeAndPublishSolverEvidence({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        sessionId,
        attemptId,
        instanceId,
        workingDirectory,
        provisioned,
        replayBaselineSteps,
        reason: "solver_running",
        lastWatermark: latestWatermark,
      });
      if (result.watermark) latestWatermark = result.watermark;
      if (result.evidenceRecords.length > 0) {
        latestEvidenceRecords = result.evidenceRecords;
        latestObservedStepCount = Math.max(latestObservedStepCount, maxObservedStepCount(result.evidenceRecords));
      }
      if (result.incompleteSurface) {
        const fingerprint = JSON.stringify(result.incompleteSurface);
        incompleteSurfaceRepeatCount = fingerprint === incompleteSurfaceFingerprint ? incompleteSurfaceRepeatCount + 1 : 1;
        incompleteSurfaceFingerprint = fingerprint;
        if (incompleteSurfaceRepeatCount >= 3 && !latchedInfrastructureFailure) {
          latchedInfrastructureFailure = {
            reason: "evidence_surface_incomplete",
            payload: result.incompleteSurface,
          };
          controller.abort();
          break;
        }
        continue;
      }
      incompleteSurfaceFingerprint = "";
      incompleteSurfaceRepeatCount = 0;
    }
  })();
  let currentPromptText = promptText;
  let turnIndex = 2;
  let turn = await runFluxProviderTurn({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    session,
    sessionType: "solver",
    promptText: currentPromptText,
    promptImages,
    reasoningEffort: args.config.solver.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
    workingDirectory,
    env: typeof provisioned.env === "object" && provisioned.env ? provisioned.env as Record<string, string> : undefined,
    signal: controller.signal,
  });
  let solverStopReason = "completed";
  while (!turn.interrupted) {
    const preTurnObservedStepCount = latestObservedStepCount;
    await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
      messageId: newId("msg"),
      ts: nowIso(),
      turnIndex,
      kind: "assistant",
      text: turn.assistantText,
      providerThreadId: turn.providerThreadId,
    });
    const postTurnObservation = await observeAndPublishSolverEvidence({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      sessionId,
      attemptId,
      instanceId,
      workingDirectory,
      provisioned,
      replayBaselineSteps,
      reason: "solver_running",
      lastWatermark: latestWatermark,
    });
    if (postTurnObservation.watermark) latestWatermark = postTurnObservation.watermark;
    const postTurnEvidenceRecords = postTurnObservation.evidenceRecords.length > 0
      ? postTurnObservation.evidenceRecords
      : latestEvidenceRecords;
    if (postTurnObservation.evidenceRecords.length > 0) latestEvidenceRecords = postTurnObservation.evidenceRecords;
    const postTurnObservedStepCount = maxObservedStepCount(postTurnEvidenceRecords);
    latestObservedStepCount = Math.max(latestObservedStepCount, postTurnObservedStepCount);
    const madeProgressThisTurn = postTurnObservedStepCount > preTurnObservedStepCount;
    if (isLevelSolvedFromEvidence(postTurnEvidenceRecords)) {
      solverStopReason = "solved";
      break;
    }
    if (!postTurnObservation.hasRealActionEvidence) {
      solverStopReason = "no_action_evidence";
      break;
    }
    if (!madeProgressThisTurn) {
      currentPromptText = buildContinuationPrompt(postTurnEvidenceRecords, { noProgress: true });
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "solver.no_progress_nudged",
        workspaceRoot: args.workspaceRoot,
        sessionType: "solver",
        sessionId,
        summary: "solver made no progress; continuing with stronger nudge",
        payload: { attemptId, instanceId, watermark: latestWatermark || null },
      }]);
      await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
        messageId: newId("msg"),
        ts: nowIso(),
        turnIndex: turnIndex + 1,
        kind: "user",
        text: currentPromptText,
      });
      turnIndex += 2;
      turn = await runFluxProviderTurn({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        session,
        sessionType: "solver",
        promptText: currentPromptText,
        reasoningEffort: args.config.solver.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
        workingDirectory,
        env: typeof provisioned.env === "object" && provisioned.env ? provisioned.env as Record<string, string> : undefined,
        signal: controller.signal,
      });
      continue;
    }
    currentPromptText = buildContinuationPrompt(postTurnEvidenceRecords);
    await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
      messageId: newId("msg"),
      ts: nowIso(),
      turnIndex: turnIndex + 1,
      kind: "user",
      text: currentPromptText,
    });
    turnIndex += 2;
    turn = await runFluxProviderTurn({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      session,
      sessionType: "solver",
      promptText: currentPromptText,
      reasoningEffort: args.config.solver.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
      workingDirectory,
      env: typeof provisioned.env === "object" && provisioned.env ? provisioned.env as Record<string, string> : undefined,
      signal: controller.signal,
    });
  }
  pollStopped = true;
  await pollLoop;
  activeSolverControls.delete(sessionId);
  if (turn.interrupted) {
    await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
      messageId: newId("msg"),
      ts: nowIso(),
      turnIndex,
      kind: "assistant",
      text: turn.assistantText,
      providerThreadId: turn.providerThreadId,
    });
  }
  const finalObservation = await observeAndPublishSolverEvidence({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    sessionId,
    attemptId,
    instanceId,
    workingDirectory,
    provisioned,
    replayBaselineSteps,
    reason: "solver_stopped",
    lastWatermark: latestWatermark,
  });
  const watermark = finalObservation.watermark || latestWatermark;
  const hasRealActionEvidence = finalObservation.hasRealActionEvidence;
  if (!latchedInfrastructureFailure && finalObservation.incompleteSurface) {
    latchedInfrastructureFailure = {
      reason: "evidence_surface_incomplete",
      payload: finalObservation.incompleteSurface,
    };
  }
  const interruptedForReplacement = turn.interrupted && !latchedInfrastructureFailure;
  session.status = "stopped";
  session.lastEvidenceWatermark = watermark || session.lastEvidenceWatermark;
  session.stopReason = latchedInfrastructureFailure?.reason
    ?? (interruptedForReplacement ? "interrupted_for_replacement" : solverStopReason);
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  if (latchedInfrastructureFailure) {
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "solver.infrastructure_failure",
      workspaceRoot: args.workspaceRoot,
      sessionType: "solver",
      sessionId,
      summary: "solver stopped after repeated incomplete evidence surface observations",
      payload: {
        attemptId,
        instanceId,
        reason: latchedInfrastructureFailure.reason,
        detail: latchedInfrastructureFailure.payload,
      },
    }]);
  }
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "session.stopped",
    workspaceRoot: args.workspaceRoot,
    sessionType: "solver",
    sessionId,
    summary: latchedInfrastructureFailure
      ? "solver session stopped after infrastructure failure"
      : (interruptedForReplacement ? "solver session interrupted for replacement" : "solver session stopped"),
    payload: {
      attemptId,
      instanceId,
      interrupted: interruptedForReplacement,
      infrastructureFailure: latchedInfrastructureFailure?.reason ?? null,
    },
  }]);
  if (!hasRealActionEvidence && !latchedInfrastructureFailure) {
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "solver", {
      id: newId("q"),
      sessionType: "solver",
      createdAt: nowIso(),
      reason: "solver_retry_no_action_evidence",
      payload: seedBundle ? { seedBundle } : {},
    });
  }
  if (!args.config.retention.keepAllAttempts) {
    await runFluxProblemCommand(args.config.problem.destroyInstance, {
      workspaceRoot: args.workspaceRoot,
      attemptId,
      instanceId,
      workingDirectory,
      instance: provisioned,
    });
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "solver.instance_destroyed",
      workspaceRoot: args.workspaceRoot,
      sessionType: "solver",
      sessionId,
      summary: `solver instance destroyed: ${instanceId}`,
      payload: { attemptId, instanceId },
    }]);
  }
  await mutateFluxState(args.workspaceRoot, args.config, async (current) => {
    const latestState = current ?? startingState;
    let shouldReplaceActiveSlot = latestState.active.solver.sessionId === sessionId || !latestState.active.solver.sessionId;
    if (!shouldReplaceActiveSlot && latestState.active.solver.status === "idle" && latestState.active.solver.sessionId) {
      const activeSession = await loadFluxSession(
        args.workspaceRoot,
        args.config,
        "solver",
        latestState.active.solver.sessionId,
      );
      shouldReplaceActiveSlot = !activeSession || activeSession.status !== "running";
    }
    if (shouldReplaceActiveSlot) {
      latestState.active.solver = {
        sessionId,
        status: "idle",
        queueItemId: undefined,
        pid: undefined,
        attemptId: undefined,
        instanceId: undefined,
        updatedAt: nowIso(),
      };
    }
    if (session.stopReason === "solved") {
      latestState.stopRequested = true;
    }
    return latestState;
  });
}
