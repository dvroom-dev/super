import path from "node:path";
import { readJsonIfExists } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { appendEvidence } from "./evidence.js";
import { markFluxInvocationStatus, persistFluxInvocationInput, saveFluxInvocationResult } from "./invocations.js";
import { appendProjectionEventsAndRebuild } from "./projections.js";
import { formatEvidenceForPrompt, formatSeedBundleForPrompt, formatSeedReplayResultForPrompt } from "./json_session_format.js";
import { runFluxProblemCommand } from "./problem_shell.js";
import { enqueueFluxQueueItem } from "./queue.js";
import { loadFluxPromptTemplate } from "./prompt_templates.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { validateFluxSeedBundle } from "./seed_bundle.js";
import { appendFluxMessage, loadFluxSession, saveFluxSession } from "./session_store.js";
import { preflightCurrentModelMatchesEvidence } from "./solver_modeler_preflight.js";
import type { FluxConfig, FluxQueueItem, FluxRunState, FluxSeedBundle, FluxSessionRecord } from "./types.js";
import { loadFluxState } from "./state.js";
import {
  buildContinuationPrompt,
  buildPolicyViolationPrompt,
  maybeClearSatisfiedSolverTheoryRequirement,
  solverTheoryRelativePath,
  writeSolverTheoryRequirement,
} from "./solver_runtime_support.js";

type ActiveSolverControl = {
  controller: AbortController;
  interruptRequested: boolean;
};

const activeSolverControls = new Map<string, ActiveSolverControl>();
const MAX_CONSECUTIVE_NO_PROGRESS_TURNS = 3;

function nowIso(): string {
  return new Date().toISOString();
}

function initialFrontierLevelFromReplay(result: Record<string, unknown> | null): number {
  const evidence = Array.isArray(result?.evidence)
    ? result?.evidence.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  return currentFrontierLevelFromEvidence(evidence);
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
  if (args.seedBundle) {
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
      const latestEvidence = evidenceRecords[evidenceRecords.length - 1] ?? null;
      const alreadyMatched = await preflightCurrentModelMatchesEvidence({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        sessionId: args.sessionId,
        attemptId: args.attemptId,
        instanceId: args.instanceId,
        watermark,
        evidenceCount: evidenceList.length,
        latestEvidence,
        evidenceBundleId,
        evidenceBundlePath,
      });
      if (!alreadyMatched) {
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
            latestEvidence,
            evidenceBundleId: evidenceBundleId || undefined,
            evidenceBundlePath: evidenceBundlePath || undefined,
          },
        });
      }
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

function currentFrontierLevelFromEvidence(evidenceRecords: Record<string, unknown>[]): number {
  const latest = evidenceRecords[evidenceRecords.length - 1];
  const state = latest?.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return 0;
  const record = state as Record<string, unknown>;
  return Number(record.current_level ?? 0) || 0;
}

export { buildContinuationPrompt } from "./solver_runtime_support.js";

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
  const invocationId = args.queueItem.id;
  await persistFluxInvocationInput(args.workspaceRoot, args.config, {
    invocationId,
    invocationType: "solver_invocation",
    sessionType: "solver",
    createdAt: args.queueItem.createdAt,
    reason: args.queueItem.reason,
    payload: { ...args.queueItem.payload },
  });
  await appendProjectionEventsAndRebuild({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    configPath: args.state.configPath,
    events: [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "projection.slot_updated",
      workspaceRoot: args.workspaceRoot,
      sessionType: "solver",
      sessionId,
      invocationId,
      summary: `active solver invocation ${invocationId} started`,
      payload: {
        active: {
          sessionId,
          invocationId,
          status: "running",
          queueItemId: args.queueItem.id,
          pid: process.pid,
          attemptId,
          instanceId,
          updatedAt: nowIso(),
        },
      },
    }],
  });
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "solver.instance_provisioned",
    workspaceRoot: args.workspaceRoot,
    invocationId,
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
    activeInvocationId: invocationId,
    activeAttemptId: attemptId,
    lastFrontierLevel: 0,
  };
  await saveFluxSession(args.workspaceRoot, args.config, session);
  await markFluxInvocationStatus({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    invocationId,
    sessionType: "solver",
    status: "running",
    sessionId,
    attemptId,
  });

  const seedBundle = (launchContext.seedBundle as FluxSeedBundle | undefined) ?? await loadCurrentSeedBundle(args.workspaceRoot, args.config) ?? undefined;
  if (seedBundle?.syntheticMessages?.length) {
    for (const [index, message] of seedBundle.syntheticMessages.entries()) {
      await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
        messageId: newId("msg"),
        ts: nowIso(),
        turnIndex: index + 1,
        invocationId,
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
    invocationId,
    sessionType: "solver",
      sessionId,
      summary: preplayedInstance ? "attached preplayed seed state before solver turn" : "replayed seed bundle before solver turn",
      payload: { attemptId, instanceId, preplayed: Boolean(preplayedInstance) },
    }]);
  }
  session.lastFrontierLevel = initialFrontierLevelFromReplay(seedReplayResult);
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
    invocationId,
    kind: "user",
    text: promptText,
  });
  const controller = new AbortController();
  activeSolverControls.set(sessionId, { controller, interruptRequested: false });
  let latestWatermark = "";
  let latestEvidenceRecords: Record<string, unknown>[] = [];
  let latestObservedStepCount = replayBaselineSteps;
  let consecutiveNoProgressTurns = 0;
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
  await maybeClearSatisfiedSolverTheoryRequirement({
    session,
    workingDirectory,
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    invocationId,
    sessionId,
    attemptId,
    instanceId,
  });
  let turn = await runFluxProviderTurn({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    session,
    sessionType: "solver",
    invocationId,
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
      invocationId,
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
    const observedFrontierLevel = currentFrontierLevelFromEvidence(postTurnEvidenceRecords);
    const priorFrontierLevel = session.lastFrontierLevel ?? 0;
    if (observedFrontierLevel > priorFrontierLevel) {
      session.lastFrontierLevel = observedFrontierLevel;
      session.updatedAt = nowIso();
      const shouldResetForLevelTransition = observedFrontierLevel > 1;
      if (shouldResetForLevelTransition) {
        const requestedAt = nowIso();
        session.pendingSolverTheoryLevel = Math.max(1, observedFrontierLevel - 1);
        session.pendingSolverTheoryFrontierLevel = observedFrontierLevel;
        session.pendingSolverTheoryRequestedAt = requestedAt;
        session.providerThreadId = undefined;
        await saveFluxSession(args.workspaceRoot, args.config, session);
        await writeSolverTheoryRequirement({
          workingDirectory,
          theoryLevel: session.pendingSolverTheoryLevel,
          frontierLevel: observedFrontierLevel,
          requestedAt,
        });
        await appendFluxEvents(args.workspaceRoot, args.config, [{
          eventId: newId("evt"),
          ts: nowIso(),
          kind: "solver.level_transition_reset",
          workspaceRoot: args.workspaceRoot,
          invocationId,
          sessionType: "solver",
          sessionId,
          summary: `solver reached level ${observedFrontierLevel}; resetting provider thread before the next turn`,
          payload: {
            attemptId,
            instanceId,
            previousLevel: priorFrontierLevel,
            currentLevel: observedFrontierLevel,
            requiredTheoryLevel: session.pendingSolverTheoryLevel,
            requiredTheoryPath: solverTheoryRelativePath(),
          },
        }]);
      } else {
        await saveFluxSession(args.workspaceRoot, args.config, session);
      }
    }
    await maybeClearSatisfiedSolverTheoryRequirement({
      session,
      workingDirectory,
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      invocationId,
      sessionId,
      attemptId,
      instanceId,
    });
    if (turn.policyViolation) {
      consecutiveNoProgressTurns += 1;
      session.providerThreadId = undefined;
      session.updatedAt = nowIso();
      await saveFluxSession(args.workspaceRoot, args.config, session);
      currentPromptText = buildPolicyViolationPrompt({
        violation: turn.policyViolation,
        evidenceRecords: postTurnEvidenceRecords,
        pendingTheoryLevel: session.pendingSolverTheoryLevel,
      });
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "solver.policy_violation",
        workspaceRoot: args.workspaceRoot,
        invocationId,
        sessionType: "solver",
        sessionId,
        summary: turn.policyViolation,
        payload: {
          attemptId,
          instanceId,
          watermark: latestWatermark || null,
        },
      }]);
      await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
        messageId: newId("msg"),
        ts: nowIso(),
        turnIndex: turnIndex + 1,
        invocationId,
        kind: "user",
        text: currentPromptText,
      });
      turnIndex += 2;
      turn = await runFluxProviderTurn({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        session,
        sessionType: "solver",
        invocationId,
        promptText: currentPromptText,
        reasoningEffort: args.config.solver.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
        workingDirectory,
        env: typeof provisioned.env === "object" && provisioned.env ? provisioned.env as Record<string, string> : undefined,
        signal: controller.signal,
      });
      continue;
    }
    if (isLevelSolvedFromEvidence(postTurnEvidenceRecords)) {
      solverStopReason = "solved";
      break;
    }
    if (!postTurnObservation.hasRealActionEvidence) {
      solverStopReason = "no_action_evidence";
      break;
    }
    if (!madeProgressThisTurn) {
      consecutiveNoProgressTurns += 1;
      currentPromptText = buildContinuationPrompt(postTurnEvidenceRecords, { noProgress: true });
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "solver.no_progress_nudged",
        workspaceRoot: args.workspaceRoot,
        invocationId,
        sessionType: "solver",
        sessionId,
        summary: "solver made no progress; continuing with stronger nudge",
        payload: { attemptId, instanceId, watermark: latestWatermark || null },
      }]);
      if (consecutiveNoProgressTurns >= MAX_CONSECUTIVE_NO_PROGRESS_TURNS) {
        solverStopReason = "stalled_after_nudges";
        await appendFluxEvents(args.workspaceRoot, args.config, [{
          eventId: newId("evt"),
          ts: nowIso(),
          kind: "solver.stalled_after_nudges",
          workspaceRoot: args.workspaceRoot,
          invocationId,
          sessionType: "solver",
          sessionId,
          summary: "solver produced no new progress after repeated nudges; yielding control",
          payload: {
            attemptId,
            instanceId,
            watermark: latestWatermark || null,
            consecutiveNoProgressTurns,
          },
        }]);
        break;
      }
      await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
        messageId: newId("msg"),
        ts: nowIso(),
        turnIndex: turnIndex + 1,
        invocationId,
        kind: "user",
        text: currentPromptText,
      });
      turnIndex += 2;
      turn = await runFluxProviderTurn({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        session,
        sessionType: "solver",
        invocationId,
        promptText: currentPromptText,
        reasoningEffort: args.config.solver.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
        workingDirectory,
        env: typeof provisioned.env === "object" && provisioned.env ? provisioned.env as Record<string, string> : undefined,
        signal: controller.signal,
      });
      continue;
    }
    consecutiveNoProgressTurns = 0;
    currentPromptText = buildContinuationPrompt(postTurnEvidenceRecords, {
      pendingTheoryLevel: session.pendingSolverTheoryLevel,
      pendingTheoryFrontierLevel: session.pendingSolverTheoryFrontierLevel,
    });
    await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
      messageId: newId("msg"),
      ts: nowIso(),
      turnIndex: turnIndex + 1,
      invocationId,
      kind: "user",
      text: currentPromptText,
    });
    turnIndex += 2;
    turn = await runFluxProviderTurn({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      session,
      sessionType: "solver",
      invocationId,
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
      invocationId,
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
  await maybeClearSatisfiedSolverTheoryRequirement({
    session,
    workingDirectory,
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    invocationId,
    sessionId,
    attemptId,
    instanceId,
  });
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
      invocationId,
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
    invocationId,
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
  const latestState = await loadFluxState(args.workspaceRoot, args.config) ?? args.state;
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
  const projectionEvents = [] as Array<{
    eventId: string;
    ts: string;
    kind: string;
    workspaceRoot: string;
    sessionType?: "solver";
    sessionId?: string;
    invocationId?: string;
    summary?: string;
    payload?: Record<string, unknown>;
  }>;
  if (shouldReplaceActiveSlot) {
    projectionEvents.push({
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "projection.slot_updated",
      workspaceRoot: args.workspaceRoot,
      sessionType: "solver",
      sessionId,
      invocationId,
      summary: `active solver invocation ${invocationId} cleared`,
      payload: {
        active: {
          sessionId,
          invocationId,
          status: "idle",
          updatedAt: nowIso(),
        },
      },
    });
  }
  if (session.stopReason === "solved") {
    projectionEvents.push({
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "projection.run_stop_requested",
      workspaceRoot: args.workspaceRoot,
      invocationId,
      summary: "solver reached solved state; stop requested",
      payload: {},
    });
  }
  if (projectionEvents.length > 0) {
    await appendProjectionEventsAndRebuild({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      configPath: args.state.configPath,
      events: projectionEvents,
    });
  }
  await saveFluxInvocationResult(args.workspaceRoot, args.config, {
    invocationId,
    invocationType: "solver_invocation",
    sessionType: "solver",
    status: latchedInfrastructureFailure ? "failed" : "completed",
    recordedAt: nowIso(),
    summary: session.stopReason ?? solverStopReason,
    payload: {
      sessionId,
      attemptId,
      instanceId,
      stopReason: session.stopReason ?? solverStopReason,
      watermark: watermark || null,
      interruptedForReplacement,
      hasRealActionEvidence,
      infrastructureFailure: latchedInfrastructureFailure?.payload ?? null,
    },
  });
  await markFluxInvocationStatus({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    invocationId,
    sessionType: "solver",
    status: latchedInfrastructureFailure ? "failed" : "completed",
    sessionId,
    attemptId,
    error: latchedInfrastructureFailure ? latchedInfrastructureFailure.reason : undefined,
  });
}
