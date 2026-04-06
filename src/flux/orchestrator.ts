import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { newId } from "../utils/ids.js";
import type { FluxConfig, FluxRunState } from "./types.js";
import { appendFluxEvents } from "./events.js";
import { loadFluxState, saveFluxState } from "./state.js";
import { runModelerQueueItem } from "./modeler_runtime.js";
import { dequeueNextSolver, ensureInitialSolverQueued, shouldStartSolver } from "./scheduler.js";
import { requestActiveSolverInterrupt, runSolverQueueItem } from "./solver_runtime.js";
import { loadFluxQueue, saveFluxQueue } from "./queue.js";
import { runBootstrapperQueueItem } from "./bootstrapper_runtime.js";
import { appendFluxRuntimeLog } from "./runtime_log.js";
import { fluxRunLockPath } from "./paths.js";
import { loadFluxSession, saveFluxSession } from "./session_store.js";

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
  const latestState = await loadFluxState(workspaceRoot, config);
  const active = latestState?.active?.[sessionType];
  const sessionId = active?.sessionId;
  if (sessionId) {
    const session = await loadFluxSession(workspaceRoot, config, sessionType, sessionId);
    if (session) {
      session.status = "failed";
      session.stopReason = summary;
      session.updatedAt = nowIso();
      await saveFluxSession(workspaceRoot, config, session);
    }
  }
  if (latestState) {
    latestState.active[sessionType] = {
      sessionId,
      status: "idle",
      updatedAt: nowIso(),
    };
    latestState.updatedAt = nowIso();
    await saveFluxState(workspaceRoot, config, latestState);
  }
  await appendFluxEvents(workspaceRoot, config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "session.failed",
    workspaceRoot,
    sessionType,
    sessionId,
    summary,
  }]);
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
    if (active.status === "idle" && !activeRuns.has(sessionType)) {
      const runningSessionId = await findRunningSessionId(workspaceRoot, config, sessionType);
      if (runningSessionId) {
        const runningSession = await loadFluxSession(workspaceRoot, config, sessionType, runningSessionId);
        if (runningSession?.status === "running") {
          runningSession.status = sessionType === "solver" ? "stopped" : "idle";
          runningSession.stopReason = "orphaned_session_record";
          runningSession.updatedAt = nowIso();
          await saveFluxSession(workspaceRoot, config, runningSession);
          changed = true;
        }
      }
      continue;
    }
    if (active.status === "idle" || activeRuns.has(sessionType) || !active.sessionId) continue;
    const session = await loadFluxSession(workspaceRoot, config, sessionType, active.sessionId);
    if (!session || session.status === "running") continue;
    nextState.active[sessionType] = {
      sessionId: active.sessionId,
      status: "idle",
      updatedAt: nowIso(),
    };
    changed = true;
  }
  if (!changed) return state;
  nextState.updatedAt = nowIso();
  await saveFluxState(workspaceRoot, config, nextState);
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
  state.stopRequested = true;
  state.status = "stopping";
  state.updatedAt = nowIso();
  await saveFluxState(workspaceRoot, config, state);
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
  state.pid = process.pid;
  state.status = "running";
  state.stopRequested = false;
  state.updatedAt = nowIso();
  await saveFluxState(workspaceRoot, config, state);
  await appendFluxEvents(workspaceRoot, config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "orchestrator.started",
    workspaceRoot,
    summary: "flux orchestrator started",
    payload: { pid: process.pid },
  }]);
  appendFluxRuntimeLog(workspaceRoot, config, `orchestrator started pid=${process.pid}`);
  await ensureInitialSolverQueued(workspaceRoot, config);

  let stopping = false;
  const activeRuns = new Map<"solver" | "modeler" | "bootstrapper", Promise<void>>();
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    const current = await loadFluxState(workspaceRoot, config) ?? state;
    current.stopRequested = true;
    current.status = "stopped";
    current.updatedAt = nowIso();
    await saveFluxState(workspaceRoot, config, current);
    await appendFluxEvents(workspaceRoot, config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "orchestrator.stopped",
      workspaceRoot,
      summary: reason,
    }]);
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
                  replacementGraceMs: config.orchestrator.solverPreemptGraceMs,
                  attemptId: state.active.solver.attemptId,
                  instanceId: state.active.solver.instanceId,
                  interruptPolicy,
                },
              }]);
            }
          }
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
      const latestState = await loadFluxState(workspaceRoot, config) ?? state;
      latestState.updatedAt = nowIso();
      await saveFluxState(workspaceRoot, config, latestState);
    }
    await Promise.allSettled(activeRuns.values());
    await stop("stop requested");
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    workspaceLock.release();
  }
}
