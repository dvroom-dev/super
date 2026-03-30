import { newId } from "../utils/ids.js";
import type { FluxConfig, FluxRunState } from "./types.js";
import { appendFluxEvents } from "./events.js";
import { loadFluxState, saveFluxState } from "./state.js";
import { dequeueNextSolver, ensureInitialSolverQueued, shouldStartSolver } from "./scheduler.js";
import { runSolverQueueItem } from "./solver_runtime.js";

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
}

export async function runFluxOrchestrator(workspaceRoot: string, configPath: string, config: FluxConfig): Promise<void> {
  let state = await loadFluxState(workspaceRoot, config) ?? initialState(workspaceRoot, configPath);
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
      state.updatedAt = nowIso();
      await saveFluxState(workspaceRoot, config, state);
    }
    await Promise.allSettled(activeRuns.values());
    await stop("stop requested");
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
