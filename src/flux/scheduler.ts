import { newId } from "../utils/ids.js";
import { enqueueFluxQueueItem, loadFluxQueue, saveFluxQueue } from "./queue.js";
import type { FluxConfig, FluxQueueItem, FluxRunState } from "./types.js";

export async function ensureInitialSolverQueued(workspaceRoot: string, config: FluxConfig): Promise<void> {
  const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
  if (solverQueue.items.length > 0) return;
  await enqueueFluxQueueItem(workspaceRoot, config, "solver", {
    id: newId("q"),
    sessionType: "solver",
    createdAt: new Date().toISOString(),
    reason: "initial_solver_attempt",
    dedupeKey: "initial_solver_attempt",
    payload: {},
  });
}

export async function dequeueNextSolver(workspaceRoot: string, config: FluxConfig): Promise<FluxQueueItem | null> {
  const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
  const next = solverQueue.items.shift() ?? null;
  if (next) await saveFluxQueue(workspaceRoot, config, solverQueue);
  return next;
}

export function shouldStartSolver(state: FluxRunState): boolean {
  return state.active.solver.status === "idle";
}
