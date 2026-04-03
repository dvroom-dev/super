import fs from "node:fs";
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
  const activeRuns = new Map<string, Promise<void>>();
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
      if (state.stopRequested) break;
      if (state.active.solver.status === "running") {
        const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
        if (solverQueue.items.length > 0 && state.active.solver.sessionId) {
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
              },
            }]);
          }
        }
      }
      if (shouldStartSolver(state) && !activeRuns.has("solver")) {
        const nextSolver = await dequeueNextSolver(workspaceRoot, config);
        if (nextSolver) {
          const runPromise = runSolverQueueItem({ workspaceRoot, config, queueItem: nextSolver, state })
            .catch(async (err) => {
              await appendFluxEvents(workspaceRoot, config, [{
                eventId: newId("evt"),
                ts: nowIso(),
                kind: "session.failed",
                workspaceRoot,
                sessionType: "solver",
                summary: String(err?.message ?? err),
              }]);
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
              await appendFluxEvents(workspaceRoot, config, [{
                eventId: newId("evt"),
                ts: nowIso(),
                kind: "session.failed",
                workspaceRoot,
                sessionType: "modeler",
                summary: String(err?.message ?? err),
              }]);
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
              await appendFluxEvents(workspaceRoot, config, [{
                eventId: newId("evt"),
                ts: nowIso(),
                kind: "session.failed",
                workspaceRoot,
                sessionType: "bootstrapper",
                summary: String(err?.message ?? err),
              }]);
            })
            .finally(() => activeRuns.delete("bootstrapper"));
          activeRuns.set("bootstrapper", runPromise);
        }
      }
      state.updatedAt = nowIso();
      await saveFluxState(workspaceRoot, config, state);
    }
    await Promise.allSettled(activeRuns.values());
    await stop("stop requested");
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    workspaceLock.release();
  }
}
