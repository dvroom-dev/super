import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { newId } from "../utils/ids.js";
import type { FluxConfig, FluxRunState } from "./types.js";
import { appendFluxEvents } from "./events.js";
import { appendProjectionEventsAndRebuild } from "./projections.js";
import { loadFluxState } from "./state.js";
import { runModelerQueueItem } from "./modeler_runtime.js";
import { requestActiveBootstrapperInterrupt, runBootstrapperQueueItem } from "./bootstrapper_runtime.js";
import { dequeueNextSolver, ensureInitialSolverQueued, shouldStartSolver } from "./scheduler.js";
import { requestActiveModelerInterrupt } from "./modeler_runtime.js";
import { requestActiveSolverInterrupt, runSolverQueueItem } from "./solver_runtime.js";
import { loadFluxQueue, saveFluxQueue } from "./queue.js";
import { appendFluxRuntimeLog } from "./runtime_log.js";
import { fluxRunLockPath } from "./paths.js";
import { markFluxInvocationStatus, saveFluxInvocationResult } from "./invocations.js";
import { loadFluxSession, saveFluxSession } from "./session_store.js";

const RECOVERY_BLOCKED_SOLVER_STOP_REASONS = new Set(["evidence_surface_incomplete"]);
const MAX_CONSECUTIVE_SOLVER_INFRA_FAILURES_BEFORE_STOP = 2;
const NONRETRYABLE_SOLVER_FAILURE_PREFIXES = ["provider_rate_limited:"];
const MAX_SESSION_STOP_REASON_CHARS = 8_000;

function capStopReason(value: string): string {
  const text = String(value ?? "");
  if (text.length <= MAX_SESSION_STOP_REASON_CHARS) return text;
  const suffix = "\n...[truncated]";
  return text.slice(0, MAX_SESSION_STOP_REASON_CHARS - suffix.length) + suffix;
}

function nowIso(): string {
  return new Date().toISOString();
}

function initialState(workspaceRoot: string, configPath: string): FluxRunState {
  const ts = nowIso();
  return {
    version: 1,
    workspaceRoot,
    configPath,
    pid: process.pid,
    startedAt: ts,
    updatedAt: ts,
    status: "running",
    stopRequested: false,
    active: {
      solver: { status: "idle", updatedAt: ts },
      modeler: { status: "idle", updatedAt: ts },
      bootstrapper: { status: "idle", updatedAt: ts },
    },
  };
}

async function recordSessionFailure(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: "solver" | "modeler" | "bootstrapper",
  summary: string,
): Promise<void> {
  const boundedSummary = capStopReason(summary);
  const latestState = await loadFluxState(workspaceRoot, config);
  const active = latestState?.active?.[sessionType];
  const sessionId = active?.sessionId;
  const invocationId = active?.invocationId;
  if (sessionId) {
    const session = await loadFluxSession(workspaceRoot, config, sessionType, sessionId);
    if (session) {
      session.status = "failed";
      session.stopReason = boundedSummary;
      session.updatedAt = nowIso();
      await saveFluxSession(workspaceRoot, config, session);
    }
  }
  if (latestState) {
    await appendProjectionEventsAndRebuild({
      workspaceRoot,
      config,
      configPath: latestState.configPath,
      events: [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "projection.slot_updated",
        workspaceRoot,
        sessionType,
        sessionId,
        invocationId,
        summary: `${sessionType} slot cleared after failure`,
        payload: { active: { sessionId, invocationId, status: "idle", updatedAt: nowIso() } },
      }],
    });
  }
  await appendFluxEvents(workspaceRoot, config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "session.failed",
    workspaceRoot,
    invocationId,
    sessionType,
    sessionId,
    summary: boundedSummary,
  }]);
  if (invocationId) {
    await saveFluxInvocationResult(workspaceRoot, config, {
      invocationId,
      invocationType: sessionType === "solver" ? "solver_invocation" : (sessionType === "modeler" ? "modeler_invocation" : "bootstrapper_invocation"),
      sessionType,
      status: "failed",
      recordedAt: nowIso(),
      summary: boundedSummary,
      payload: { sessionId, error: boundedSummary },
    });
    await markFluxInvocationStatus({
      workspaceRoot,
      config,
      invocationId,
      sessionType,
      status: "failed",
      sessionId,
      error: boundedSummary,
    });
  }
}

async function reconcileStateForRestart(workspaceRoot: string, config: FluxConfig, state: FluxRunState): Promise<FluxRunState> {
  const nextState: FluxRunState = {
    ...state,
    active: { ...state.active },
  };
  const recovered: Array<{ sessionType: "solver" | "modeler" | "bootstrapper"; sessionId?: string; previousStatus: string }> = [];
  for (const sessionType of ["solver", "modeler", "bootstrapper"] as const) {
    const active = state.active[sessionType];
    if (active.status === "idle") continue;
    recovered.push({
      sessionType,
      sessionId: active.sessionId,
      previousStatus: active.status,
    });
    nextState.active[sessionType] = {
      sessionId: active.sessionId,
      invocationId: active.invocationId,
      status: "idle",
      updatedAt: nowIso(),
    };
    if (active.sessionId) {
      const session = await loadFluxSession(workspaceRoot, config, sessionType, active.sessionId);
      if (session) {
        session.status = sessionType === "solver" ? "stopped" : "idle";
        session.stopReason = sessionType === "solver" ? "orchestrator_restarted" : session.stopReason;
        session.updatedAt = nowIso();
        await saveFluxSession(workspaceRoot, config, session);
      }
    }
  }
  if (recovered.length > 0) {
    await appendFluxEvents(workspaceRoot, config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "orchestrator.recovered",
      workspaceRoot,
      summary: `recovered stale active session state for ${recovered.map((item) => item.sessionType).join(", ")}`,
      payload: { recovered },
    }]);
    appendFluxRuntimeLog(workspaceRoot, config, `recovered stale state: ${JSON.stringify(recovered)}`);
  }
  return nextState;
}

async function reconcileActiveSessionTruth(
  workspaceRoot: string,
  config: FluxConfig,
  state: FluxRunState,
  activeRuns: Map<"solver" | "modeler" | "bootstrapper", Promise<void>>,
): Promise<FluxRunState> {
  const nextState: FluxRunState = {
    ...state,
    active: { ...state.active },
  };
  let changed = false;
  for (const sessionType of ["solver", "modeler", "bootstrapper"] as const) {
    const active = nextState.active[sessionType];
    if (active.status === "idle") {
      const runningSessionId = await findRunningSessionId(workspaceRoot, config, sessionType);
      if (runningSessionId) {
        const runningSession = await loadFluxSession(workspaceRoot, config, sessionType, runningSessionId);
        if (runningSession?.status === "running" && activeRuns.has(sessionType)) {
          nextState.active[sessionType] = {
            sessionId: runningSessionId,
            invocationId: runningSession.activeInvocationId,
            status: "running",
            queueItemId: active.queueItemId,
            pid: process.pid,
            attemptId: sessionType === "solver" ? runningSession.activeAttemptId : undefined,
            instanceId: active.instanceId,
            updatedAt: nowIso(),
          };
          changed = true;
          continue;
        }
        if (runningSession?.status === "running" && !activeRuns.has(sessionType)) {
          runningSession.status = sessionType === "solver" ? "stopped" : "idle";
          runningSession.stopReason = "orphaned_session_record";
          runningSession.updatedAt = nowIso();
          await saveFluxSession(workspaceRoot, config, runningSession);
          changed = true;
        }
      }
      continue;
    }
    if (!active.sessionId) continue;
    const session = await loadFluxSession(workspaceRoot, config, sessionType, active.sessionId);
    if (!session || session.status === "running") continue;
    if (activeRuns.has(sessionType)) {
      activeRuns.delete(sessionType);
    }
    nextState.active[sessionType] = {
      sessionId: active.sessionId,
      invocationId: active.invocationId,
      status: "idle",
      updatedAt: nowIso(),
    };
    changed = true;
  }
  if (!changed) return state;
  await appendProjectionEventsAndRebuild({
    workspaceRoot,
    config,
    configPath: nextState.configPath,
    events: (["solver", "modeler", "bootstrapper"] as const).map((sessionType) => ({
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "projection.slot_updated",
      workspaceRoot,
      sessionType,
      sessionId: nextState.active[sessionType].sessionId,
      invocationId: nextState.active[sessionType].invocationId,
      summary: `reconciled ${sessionType} slot against session truth`,
      payload: { active: nextState.active[sessionType] },
    })),
  });
  await appendFluxEvents(workspaceRoot, config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "orchestrator.reconciled_session_truth",
    workspaceRoot,
    summary: "reconciled stale session truth against active slots",
  }]);
  return nextState;
}

async function findRunningSessionId(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: "solver" | "modeler" | "bootstrapper",
): Promise<string | null> {
  const sessionsDir = path.join(workspaceRoot, config.storage.aiRoot, "sessions", sessionType);
  try {
    const entries = await fsp.readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const session = await loadFluxSession(workspaceRoot, config, sessionType, entry.name);
      if (session?.status === "running") return session.sessionId;
    }
  } catch {}
  return null;
}

async function loadSolverSessionsByRecency(workspaceRoot: string, config: FluxConfig) {
  const sessionsDir = path.join(workspaceRoot, config.storage.aiRoot, "sessions", "solver");
  try {
    const entries = await fsp.readdir(sessionsDir, { withFileTypes: true });
    const sessions = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => await loadFluxSession(workspaceRoot, config, "solver", entry.name)));
    return sessions
      .filter((session): session is NonNullable<typeof session> => Boolean(session))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  } catch {
    return [];
  }
}

async function repeatedSolverFailureToEscalate(
  workspaceRoot: string,
  config: FluxConfig,
): Promise<{ stopReason: string; count: number } | null> {
  const sessions = await loadSolverSessionsByRecency(workspaceRoot, config);
  const latestFailure = sessions.find((session) => session.status === "failed" && typeof session.stopReason === "string" && session.stopReason.trim().length > 0);
  if (latestFailure) {
    const failureReason = String(latestFailure.stopReason);
    if (NONRETRYABLE_SOLVER_FAILURE_PREFIXES.some((prefix) => failureReason.startsWith(prefix))) {
      return { stopReason: failureReason, count: 1 };
    }
  }
  let stopReason = "";
  let count = 0;
  for (const session of sessions) {
    if (session.status !== "stopped") {
      if (count === 0) continue;
      break;
    }
    const currentReason = String(session.stopReason ?? "");
    if (!RECOVERY_BLOCKED_SOLVER_STOP_REASONS.has(currentReason)) {
      if (count === 0) continue;
      break;
    }
    if (!stopReason) {
      stopReason = currentReason;
      count = 1;
      continue;
    }
    if (currentReason !== stopReason) break;
    count += 1;
  }
  return count >= MAX_CONSECUTIVE_SOLVER_INFRA_FAILURES_BEFORE_STOP ? { stopReason, count } : null;
}

type FluxWorkspaceLock = {
  release: () => void;
};

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireWorkspaceLock(workspaceRoot: string, config: FluxConfig): FluxWorkspaceLock {
  const lockPath = fluxRunLockPath(workspaceRoot, config);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: nowIso() }, null, 2) + "\n", "utf8");
    return {
      release: () => {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      },
    };
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const payload = JSON.parse(raw) as { pid?: number };
    const pid = Number(payload.pid ?? 0) || 0;
    if (pid > 0 && processIsAlive(pid)) {
      throw new Error(`flux orchestrator already running for workspace ${workspaceRoot} (pid ${pid})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) throw error;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {}
  return acquireWorkspaceLock(workspaceRoot, config);
}

export async function requestFluxStop(workspaceRoot: string, config: FluxConfig): Promise<void> {
  const state = await loadFluxState(workspaceRoot, config);
  if (!state) throw new Error("no flux state found");
  await appendProjectionEventsAndRebuild({
    workspaceRoot,
    config,
    configPath: state.configPath,
    events: [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "projection.run_stop_requested",
      workspaceRoot,
      summary: "stop requested via CLI",
      payload: {},
    }],
  });
  await appendFluxEvents(workspaceRoot, config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "orchestrator.stop_requested",
    workspaceRoot,
    summary: "stop requested via CLI",
  }]);
  appendFluxRuntimeLog(workspaceRoot, config, "stop requested via CLI");
}

export async function runFluxOrchestrator(workspaceRoot: string, configPath: string, config: FluxConfig): Promise<void> {
  const workspaceLock = acquireWorkspaceLock(workspaceRoot, config);
  let state = await loadFluxState(workspaceRoot, config) ?? initialState(workspaceRoot, configPath);
  state = await reconcileStateForRestart(workspaceRoot, config, state);
  await appendProjectionEventsAndRebuild({
    workspaceRoot,
    config,
    configPath,
    events: [
      {
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "projection.run_initialized",
        workspaceRoot,
        summary: "flux orchestrator started",
        payload: {
          configPath,
          pid: process.pid,
          startedAt: state.startedAt || nowIso(),
        },
      },
      ...(Object.entries(state.active) as Array<["solver" | "modeler" | "bootstrapper", FluxRunState["active"]["solver"]]>).map(([sessionType, active]) => ({
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "projection.slot_updated",
        workspaceRoot,
        sessionType,
        sessionId: active.sessionId,
        invocationId: active.invocationId,
        summary: `startup projection refreshed ${sessionType} slot`,
        payload: { active },
      })),
      {
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "orchestrator.started",
        workspaceRoot,
        summary: "flux orchestrator started",
        payload: { pid: process.pid },
      },
    ],
  });
  state = await loadFluxState(workspaceRoot, config) ?? initialState(workspaceRoot, configPath);
  appendFluxRuntimeLog(workspaceRoot, config, `orchestrator started pid=${process.pid}`);
  const startupFailure = await repeatedSolverFailureToEscalate(workspaceRoot, config);
  if (
    startupFailure
    && NONRETRYABLE_SOLVER_FAILURE_PREFIXES.some((prefix) => startupFailure.stopReason.startsWith(prefix))
  ) {
    await appendFluxEvents(workspaceRoot, config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "orchestrator.recovery_escalated",
      workspaceRoot,
      summary: `halting after non-retryable solver failure: ${startupFailure.stopReason}`,
      payload: startupFailure,
    }]);
    await appendProjectionEventsAndRebuild({
      workspaceRoot,
      config,
      configPath,
      events: [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "projection.run_stopped",
        workspaceRoot,
        summary: `halted after non-retryable solver failure: ${startupFailure.stopReason}`,
        payload: {},
      }, {
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "orchestrator.stopped",
        workspaceRoot,
        summary: `halted after non-retryable solver failure: ${startupFailure.stopReason}`,
      }],
    });
    appendFluxRuntimeLog(workspaceRoot, config, `halted after non-retryable solver failure: ${startupFailure.stopReason}`);
    return;
  }
  await ensureInitialSolverQueued(workspaceRoot, config);

  let stopping = false;
  const activeRuns = new Map<"solver" | "modeler" | "bootstrapper", Promise<void>>();
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    const current = await loadFluxState(workspaceRoot, config) ?? state;
    await appendProjectionEventsAndRebuild({
      workspaceRoot,
      config,
      configPath: current.configPath,
      events: [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "projection.run_stopped",
        workspaceRoot,
        summary: reason,
        payload: {},
      }, {
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "orchestrator.stopped",
        workspaceRoot,
        summary: reason,
      }],
    });
    appendFluxRuntimeLog(workspaceRoot, config, reason);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    void stop(`received ${signal}`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, config.orchestrator.tickMs));
      state = await loadFluxState(workspaceRoot, config) ?? state;
      state = await reconcileActiveSessionTruth(workspaceRoot, config, state, activeRuns);
      if (state.stopRequested) {
        const runningSolverSessionId =
          (state.active.solver.status === "running" && state.active.solver.sessionId)
            ? state.active.solver.sessionId
            : await findRunningSessionId(workspaceRoot, config, "solver");
        if (runningSolverSessionId) {
          requestActiveSolverInterrupt(runningSolverSessionId);
        }
        const runningModelerSessionId =
          (state.active.modeler.status === "running" && state.active.modeler.sessionId)
            ? state.active.modeler.sessionId
            : await findRunningSessionId(workspaceRoot, config, "modeler");
        if (runningModelerSessionId) {
          requestActiveModelerInterrupt(runningModelerSessionId);
        }
        const runningBootstrapperSessionId =
          (state.active.bootstrapper.status === "running" && state.active.bootstrapper.sessionId)
            ? state.active.bootstrapper.sessionId
            : await findRunningSessionId(workspaceRoot, config, "bootstrapper");
        if (runningBootstrapperSessionId) {
          requestActiveBootstrapperInterrupt(runningBootstrapperSessionId);
        }
        break;
      }
      if (state.active.solver.status === "running") {
        const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
        if (solverQueue.items.length > 0 && state.active.solver.sessionId) {
          const nextSolver = solverQueue.items[0];
          const interruptPolicy = String(nextSolver?.payload?.interruptPolicy ?? "queue_and_interrupt");
          if (interruptPolicy === "queue_and_interrupt") {
            const interrupted = requestActiveSolverInterrupt(state.active.solver.sessionId);
            if (interrupted) {
              await appendFluxEvents(workspaceRoot, config, [{
                eventId: newId("evt"),
                ts: nowIso(),
                kind: "queue.preempt_requested",
                workspaceRoot,
                sessionType: "solver",
                sessionId: state.active.solver.sessionId,
                summary: "replacement solver queued; interrupting current solver",
                payload: {
                  queuedSolverCount: solverQueue.items.length,
                  attemptId: state.active.solver.attemptId,
                  instanceId: state.active.solver.instanceId,
                  interruptPolicy,
                },
              }]);
            }
          }
        }
      }
      if (
        state.active.solver.status === "idle"
        && state.active.modeler.status === "idle"
        && state.active.bootstrapper.status === "idle"
        && !activeRuns.has("solver")
        && !activeRuns.has("modeler")
        && !activeRuns.has("bootstrapper")
      ) {
        const [solverQueue, modelerQueue, bootstrapperQueue] = await Promise.all([
          loadFluxQueue(workspaceRoot, config, "solver"),
          loadFluxQueue(workspaceRoot, config, "modeler"),
          loadFluxQueue(workspaceRoot, config, "bootstrapper"),
        ]);
        if (
          solverQueue.items.length === 0
          && modelerQueue.items.length === 0
          && bootstrapperQueue.items.length === 0
        ) {
          const repeatedFailure = await repeatedSolverFailureToEscalate(workspaceRoot, config);
          if (repeatedFailure) {
            await appendFluxEvents(workspaceRoot, config, [{
              eventId: newId("evt"),
              ts: nowIso(),
              kind: "orchestrator.recovery_escalated",
              workspaceRoot,
              summary: `halting after ${repeatedFailure.count} consecutive solver failures: ${repeatedFailure.stopReason}`,
              payload: repeatedFailure,
            }]);
            await stop(`halted repeated solver recovery loop after ${repeatedFailure.count} consecutive ${repeatedFailure.stopReason} failures`);
            break;
          }
          await ensureInitialSolverQueued(workspaceRoot, config);
          await appendFluxEvents(workspaceRoot, config, [{
            eventId: newId("evt"),
            ts: nowIso(),
            kind: "orchestrator.idle_recovered",
            workspaceRoot,
            summary: "run became idle with no queued work; queued a solver recovery attempt",
          }]);
        }
      }
      if (shouldStartSolver(state) && !activeRuns.has("solver")) {
        const nextSolver = await dequeueNextSolver(workspaceRoot, config);
        if (nextSolver) {
          const runPromise = runSolverQueueItem({ workspaceRoot, config, queueItem: nextSolver, state })
            .catch(async (err) => {
              await recordSessionFailure(workspaceRoot, config, "solver", String(err?.message ?? err));
            })
            .finally(() => {
              activeRuns.delete("solver");
            });
          activeRuns.set("solver", runPromise);
        }
      }
      if (state.active.modeler.status === "idle" && !activeRuns.has("modeler")) {
        const queue = await loadFluxQueue(workspaceRoot, config, "modeler");
        const next = queue.items.shift() ?? null;
        if (next) {
          await saveFluxQueue(workspaceRoot, config, queue);
          const runPromise = runModelerQueueItem({ workspaceRoot, config, queueItem: next, state })
            .catch(async (err) => {
              await recordSessionFailure(workspaceRoot, config, "modeler", String(err?.message ?? err));
            })
            .finally(() => activeRuns.delete("modeler"));
          activeRuns.set("modeler", runPromise);
        }
      }
      if (state.active.bootstrapper.status === "idle" && !activeRuns.has("bootstrapper")) {
        const queue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
        const next = queue.items.shift() ?? null;
        if (next) {
          await saveFluxQueue(workspaceRoot, config, queue);
          const runPromise = runBootstrapperQueueItem({ workspaceRoot, config, queueItem: next, state })
            .catch(async (err) => {
              await recordSessionFailure(workspaceRoot, config, "bootstrapper", String(err?.message ?? err));
            })
            .finally(() => activeRuns.delete("bootstrapper"));
          activeRuns.set("bootstrapper", runPromise);
        }
      }
    }
    await Promise.allSettled(activeRuns.values());
    await stop("stop requested");
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    workspaceLock.release();
  }
}
