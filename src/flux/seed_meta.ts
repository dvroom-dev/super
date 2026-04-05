import path from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../lib/fs.js";
import { fluxSeedRoot } from "./paths.js";
import type { FluxConfig, FluxModelCoverageSummary, FluxSolverInterruptPolicy } from "./types.js";

export type FluxSeedMeta = {
  revisionId?: string;
  seedHash?: string;
  updatedAt?: string;
  lastModelRehearsalSeedHash?: string;
  lastModelRehearsalSucceeded?: boolean;
  lastModelRehearsalAt?: string;
  lastModelRehearsalResult?: Record<string, unknown>;
  lastRealReplaySeedHash?: string;
  lastRealReplaySucceeded?: boolean;
  lastRealReplayAt?: string;
  lastRealReplayResult?: Record<string, unknown>;
  lastBootstrapperModelRevisionId?: string;
  lastQueuedBootstrapModelRevisionId?: string;
  lastBootstrapperCoverageSummary?: FluxModelCoverageSummary;
  lastQueuedBootstrapCoverageSummary?: FluxModelCoverageSummary;
  lastAttestedSeedRevisionId?: string;
  lastAttestedSeedHash?: string;
  lastQueuedSolverSeedHash?: string;
  lastInterruptPolicy?: FluxSolverInterruptPolicy;
  lastSeedDeltaKind?: string;
};

export async function loadSeedMeta(workspaceRoot: string, config: FluxConfig): Promise<FluxSeedMeta> {
  return await readJsonIfExists<FluxSeedMeta>(path.join(fluxSeedRoot(workspaceRoot, config), "current_meta.json")) ?? {};
}

export async function saveSeedMeta(workspaceRoot: string, config: FluxConfig, meta: FluxSeedMeta): Promise<void> {
  await writeJsonAtomic(path.join(fluxSeedRoot(workspaceRoot, config), "current_meta.json"), meta);
}
