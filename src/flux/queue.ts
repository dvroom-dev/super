import { readJsonIfExists, writeJsonAtomic } from "../lib/fs.js";
import { fluxQueuePath } from "./paths.js";
import { ensureFluxDirs } from "./state.js";
import type { FluxConfig, FluxQueueItem, FluxQueueSnapshot, FluxSessionType } from "./types.js";

export const FLUX_SESSION_TYPES: FluxSessionType[] = ["solver", "modeler", "bootstrapper"];

function emptySnapshot(sessionType: FluxSessionType): FluxQueueSnapshot {
  return {
    sessionType,
    updatedAt: new Date().toISOString(),
    items: [],
  };
}

export async function loadFluxQueue(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: FluxSessionType,
): Promise<FluxQueueSnapshot> {
  const loaded = await readJsonIfExists<FluxQueueSnapshot>(fluxQueuePath(workspaceRoot, config, sessionType));
  return loaded ?? emptySnapshot(sessionType);
}

export async function saveFluxQueue(
  workspaceRoot: string,
  config: FluxConfig,
  snapshot: FluxQueueSnapshot,
): Promise<void> {
  await ensureFluxDirs(workspaceRoot, config);
  await writeJsonAtomic(fluxQueuePath(workspaceRoot, config, snapshot.sessionType), {
    ...snapshot,
    updatedAt: new Date().toISOString(),
  });
}

export async function enqueueFluxQueueItem(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: FluxSessionType,
  item: FluxQueueItem,
): Promise<FluxQueueSnapshot> {
  const snapshot = await loadFluxQueue(workspaceRoot, config, sessionType);
  if (sessionType === "solver" || sessionType === "modeler") {
    if (item.dedupeKey && snapshot.items.some((entry) => entry.dedupeKey === item.dedupeKey)) {
      return snapshot;
    }
    snapshot.items = [item];
    await saveFluxQueue(workspaceRoot, config, snapshot);
    return snapshot;
  }
  if (item.dedupeKey && snapshot.items.some((entry) => entry.dedupeKey === item.dedupeKey)) {
    return snapshot;
  }
  snapshot.items.push(item);
  await saveFluxQueue(workspaceRoot, config, snapshot);
  return snapshot;
}
