import path from "node:path";
import { readJsonIfExists } from "../lib/fs.js";
import { appendProjectionEventsAndRebuild } from "./projections.js";
import { persistFluxInvocationInput } from "./invocations.js";
import { fluxQueuePath } from "./paths.js";
import { ensureFluxDirs, loadFluxState } from "./state.js";
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
  const state = await loadFluxState(workspaceRoot, config);
  await appendProjectionEventsAndRebuild({
    workspaceRoot,
    config,
    configPath: state?.configPath ?? path.join(workspaceRoot, "flux.yaml"),
    events: [{
      eventId: `evt_queue_${Date.now()}`,
      ts: new Date().toISOString(),
      kind: "projection.queue_updated",
      workspaceRoot,
      sessionType: snapshot.sessionType,
      summary: snapshot.items[0] ? `pending ${snapshot.sessionType} input updated` : `pending ${snapshot.sessionType} input cleared`,
      payload: { item: snapshot.items[0] ?? null },
    }],
  });
}

export async function enqueueFluxQueueItem(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: FluxSessionType,
  item: FluxQueueItem,
): Promise<FluxQueueSnapshot> {
  const snapshot = await loadFluxQueue(workspaceRoot, config, sessionType);
  const current = snapshot.items[0] ?? null;
  const currentDedupeKey = typeof current?.dedupeKey === "string" ? current.dedupeKey : "";
  const nextDedupeKey = typeof item.dedupeKey === "string" ? item.dedupeKey : "";
  if (current && currentDedupeKey && nextDedupeKey && currentDedupeKey === nextDedupeKey) {
    return snapshot;
  }
  await persistFluxInvocationInput(workspaceRoot, config, {
    invocationId: item.id,
    invocationType: sessionType === "solver" ? "solver_invocation" : (sessionType === "modeler" ? "modeler_invocation" : "bootstrapper_invocation"),
    sessionType,
    createdAt: item.createdAt,
    reason: item.reason,
    payload: { ...item.payload },
  });
  const nextSnapshot: FluxQueueSnapshot = {
    sessionType,
    updatedAt: new Date().toISOString(),
    items: [{ ...item }],
  };
  await saveFluxQueue(workspaceRoot, config, nextSnapshot);
  return nextSnapshot;
}
