import path from "node:path";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { appendEvidence } from "./evidence.js";
import { formatSeedBundleForPrompt } from "./json_session_format.js";
import { runFluxProblemCommand } from "./problem_shell.js";
import { enqueueFluxQueueItem } from "./queue.js";
import { loadFluxPromptTemplate } from "./prompt_templates.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { appendFluxMessage, saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxQueueItem, FluxRunState, FluxSeedBundle, FluxSessionRecord } from "./types.js";
import { loadFluxState, saveFluxState } from "./state.js";

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
  if (args.seedBundle) parts.push(formatSeedBundleForPrompt(args.seedBundle));
  if (args.seedReplayResult) {
    parts.push([
      "Seed replay results on this fresh instance:",
      "",
      JSON.stringify(args.seedReplayResult, null, 2),
    ].join("\n"));
  }
  if (args.instancePromptText) parts.push(args.instancePromptText.trim());
  return parts.filter(Boolean).join("\n\n");
}

export async function runSolverQueueItem(args: {
  workspaceRoot: string;
  config: FluxConfig;
  queueItem: FluxQueueItem;
  state: FluxRunState;
  signal?: AbortSignal;
}): Promise<void> {
  const attemptId = newId("attempt");
  const provisioned = await runFluxProblemCommand(args.config.problem.provisionInstance, {
    workspaceRoot: args.workspaceRoot,
    queueItem: args.queueItem,
    attemptId,
  });
  const instanceId = String(provisioned.instance_id ?? newId("instance"));
  const workingDirectory = path.resolve(args.workspaceRoot, String(provisioned.working_directory ?? args.workspaceRoot));
  const sessionId = `solver_${attemptId}`;
  const startingState = await loadFluxState(args.workspaceRoot, args.config) ?? args.state;
  startingState.active.solver = {
    sessionId,
    status: "running",
    queueItemId: args.queueItem.id,
    pid: process.pid,
    attemptId,
    instanceId,
    updatedAt: nowIso(),
  };
  await saveFluxState(args.workspaceRoot, args.config, startingState);
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

  const seedBundle = args.queueItem.payload.seedBundle as FluxSeedBundle | undefined;
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
  let seedReplayResult: Record<string, unknown> | null = null;
  let replayBaselineSteps = 0;
  if (seedBundle?.replayPlan?.length) {
    seedReplayResult = await runFluxProblemCommand(args.config.problem.replaySeed, {
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
      summary: `replayed seed bundle before solver turn`,
      payload: { attemptId, instanceId },
    }]);
  }
  const promptTemplate = await loadFluxPromptTemplate(args.workspaceRoot, args.config.solver.promptFile);
  const promptText = buildInitialSolverPrompt({
    template: promptTemplate,
    seedBundle: seedBundle ?? null,
    seedReplayResult,
    instancePromptText: typeof provisioned.prompt_text === "string" ? String(provisioned.prompt_text) : undefined,
  });
  await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
    messageId: newId("msg"),
    ts: nowIso(),
    turnIndex: 1,
    kind: "user",
    text: promptText,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, args.config.solver.cadenceMs));
  const turn = await runFluxProviderTurn({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    session,
    sessionType: "solver",
    promptText,
    reasoningEffort: args.config.solver.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
    workingDirectory,
    env: typeof provisioned.env === "object" && provisioned.env ? provisioned.env as Record<string, string> : undefined,
    signal: controller.signal,
  });
  clearTimeout(timeout);
  await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
    messageId: newId("msg"),
    ts: nowIso(),
    turnIndex: 2,
    kind: "assistant",
    text: turn.assistantText,
    providerThreadId: turn.providerThreadId,
  });
  if (turn.interrupted) {
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "queue.preempt_requested",
      workspaceRoot: args.workspaceRoot,
      sessionType: "solver",
      sessionId,
      summary: `solver cadence reached (${args.config.solver.cadenceMs}ms)`,
      payload: { attemptId, instanceId, cadenceMs: args.config.solver.cadenceMs },
    }]);
  }

  const observed = await runFluxProblemCommand(args.config.problem.observeEvidence, {
    workspaceRoot: args.workspaceRoot,
    attemptId,
    instanceId,
    workingDirectory,
    instance: provisioned,
  });
  const evidenceList = Array.isArray(observed.evidence) ? observed.evidence : [];
  const evidenceRecords = evidenceList.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
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
    return totalSteps > replayBaselineSteps;
  }) || observedStepCount > replayBaselineSteps;
  const { watermark } = await appendEvidence(
    args.workspaceRoot,
    args.config,
    evidenceList.map((payload) => ({
      ts: nowIso(),
      attemptId,
      instanceId,
      summary: String((payload as any)?.summary ?? "solver evidence"),
      payload: payload as Record<string, unknown>,
    })),
  );
  session.status = "stopped";
  session.lastEvidenceWatermark = watermark || session.lastEvidenceWatermark;
  session.stopReason = "completed";
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "solver.evidence_observed",
    workspaceRoot: args.workspaceRoot,
    sessionType: "solver",
    sessionId,
    summary: `observed ${evidenceList.length} evidence records`,
      payload: { attemptId, instanceId, watermark, count: evidenceList.length },
  }, {
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "session.stopped",
    workspaceRoot: args.workspaceRoot,
    sessionType: "solver",
    sessionId,
    summary: "solver session stopped",
    payload: { attemptId, instanceId },
  }]);
  if (hasRealActionEvidence) {
    await enqueueFluxQueueItem(args.workspaceRoot, args.config, "modeler", {
      id: newId("q"),
      sessionType: "modeler",
      createdAt: nowIso(),
      reason: "solver_stopped",
      payload: {
        attemptId,
        instanceId,
        evidenceWatermark: watermark,
        evidenceCount: evidenceList.length,
      },
    });
  } else {
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
  const latestState = await loadFluxState(args.workspaceRoot, args.config) ?? startingState;
  latestState.active.solver = {
    sessionId,
    status: "idle",
    queueItemId: undefined,
    pid: undefined,
    attemptId: undefined,
    instanceId: undefined,
    updatedAt: nowIso(),
  };
  await saveFluxState(args.workspaceRoot, args.config, latestState);
}
