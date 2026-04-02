import path from "node:path";
import { readJsonIfExists } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { enqueueFluxQueueItem, loadFluxQueue, saveFluxQueue } from "./queue.js";
import { validateFluxSeedBundle } from "./seed_bundle.js";
import type { FluxConfig, FluxQueueItem, FluxRunState, FluxSeedBundle } from "./types.js";

function hasSeedMaterial(seedBundle: FluxSeedBundle | null): seedBundle is FluxSeedBundle {
  if (!seedBundle) return false;
  return (
    seedBundle.syntheticMessages.length > 0
    || seedBundle.replayPlan.length > 0
    || seedBundle.assertions.length > 0
    || typeof seedBundle.modelRevisionId === "string"
    || typeof seedBundle.evidenceWatermark === "string"
  );
}

async function loadCurrentSeedBundle(workspaceRoot: string, config: FluxConfig): Promise<FluxSeedBundle | null> {
  const seedPath = path.resolve(workspaceRoot, config.bootstrapper.seedBundlePath);
  const rawSeedBundle = await readJsonIfExists<unknown>(seedPath);
  const seedBundle = rawSeedBundle ? validateFluxSeedBundle(rawSeedBundle) : null;
  return hasSeedMaterial(seedBundle) ? seedBundle : null;
}

export async function ensureInitialSolverQueued(workspaceRoot: string, config: FluxConfig): Promise<void> {
  const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
  if (solverQueue.items.length > 0) return;
  const seedBundle = await loadCurrentSeedBundle(workspaceRoot, config);
  await enqueueFluxQueueItem(workspaceRoot, config, "solver", {
    id: newId("q"),
    sessionType: "solver",
    createdAt: new Date().toISOString(),
    reason: "initial_solver_attempt",
    dedupeKey: "initial_solver_attempt",
    payload: seedBundle ? { seedBundle } : {},
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
