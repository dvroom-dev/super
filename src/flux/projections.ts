import { writeJsonAtomic } from "../lib/fs.js";
import { readFluxEvents, appendFluxEvents } from "./events.js";
import { fluxQueuePath, fluxStatePath } from "./paths.js";
import type {
  FluxActiveSessionState,
  FluxConfig,
  FluxEvent,
  FluxQueueItem,
  FluxQueueSnapshot,
  FluxRunState,
  FluxSessionType,
} from "./types.js";

const SESSION_TYPES: FluxSessionType[] = ["solver", "modeler", "bootstrapper"];

function emptyActiveState(ts: string): Record<FluxSessionType, FluxActiveSessionState> {
  return {
    solver: { status: "idle", updatedAt: ts },
    modeler: { status: "idle", updatedAt: ts },
    bootstrapper: { status: "idle", updatedAt: ts },
  };
}

function defaultRunState(workspaceRoot: string, configPath: string, ts: string): FluxRunState {
  return {
    version: 1,
    workspaceRoot,
    configPath,
    pid: 0,
    startedAt: ts,
    updatedAt: ts,
    status: "stopped",
    stopRequested: false,
    active: emptyActiveState(ts),
  };
}

function defaultQueues(ts: string): Record<FluxSessionType, FluxQueueSnapshot> {
  return {
    solver: { sessionType: "solver", updatedAt: ts, items: [] },
    modeler: { sessionType: "modeler", updatedAt: ts, items: [] },
    bootstrapper: { sessionType: "bootstrapper", updatedAt: ts, items: [] },
  };
}

function isQueueItem(value: unknown): value is FluxQueueItem {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isActiveState(value: unknown): value is FluxActiveSessionState {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as any).status === "string";
}

export function reduceFluxProjection(args: {
  workspaceRoot: string;
  configPath: string;
  events: FluxEvent[];
}): {
  state: FluxRunState;
  queues: Record<FluxSessionType, FluxQueueSnapshot>;
} {
  const initialTs = args.events[0]?.ts ?? new Date().toISOString();
  const state = defaultRunState(args.workspaceRoot, args.configPath, initialTs);
  const queues = defaultQueues(initialTs);

  for (const event of args.events) {
    const ts = event.ts || initialTs;
    state.updatedAt = ts;
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};

    if (event.kind === "projection.run_initialized") {
      state.configPath = typeof payload.configPath === "string" ? payload.configPath : state.configPath;
      state.pid = typeof payload.pid === "number" ? payload.pid : state.pid;
      state.startedAt = typeof payload.startedAt === "string" ? payload.startedAt : state.startedAt;
      state.status = "running";
      state.stopRequested = false;
      continue;
    }
    if (event.kind === "projection.run_stop_requested") {
      state.stopRequested = true;
      state.status = "stopping";
      continue;
    }
    if (event.kind === "projection.run_stopped") {
      state.stopRequested = true;
      state.status = "stopped";
      continue;
    }
    if (event.kind === "projection.run_running") {
      state.pid = typeof payload.pid === "number" ? payload.pid : state.pid;
      state.status = "running";
      state.stopRequested = false;
      continue;
    }
    if (event.kind === "projection.queue_updated") {
      const sessionType = event.sessionType;
      if (!sessionType) continue;
      const item = isQueueItem(payload.item) ? { ...(payload.item as FluxQueueItem) } : null;
      queues[sessionType] = {
        sessionType,
        updatedAt: ts,
        items: item ? [item] : [],
      };
      continue;
    }
    if (event.kind === "projection.slot_updated") {
      const sessionType = event.sessionType;
      if (!sessionType) continue;
      const active = isActiveState(payload.active) ? payload.active : null;
      state.active[sessionType] = active
        ? { ...active, updatedAt: typeof active.updatedAt === "string" ? active.updatedAt : ts }
        : { status: "idle", updatedAt: ts };
      continue;
    }
  }

  return { state, queues };
}

export async function rebuildFluxProjections(args: {
  workspaceRoot: string;
  config: FluxConfig;
  configPath: string;
}): Promise<{
  state: FluxRunState;
  queues: Record<FluxSessionType, FluxQueueSnapshot>;
}> {
  const events = await readFluxEvents(args.workspaceRoot, args.config);
  const projection = reduceFluxProjection({
    workspaceRoot: args.workspaceRoot,
    configPath: args.configPath,
    events,
  });
  await writeJsonAtomic(fluxStatePath(args.workspaceRoot, args.config), projection.state);
  await Promise.all(SESSION_TYPES.map(async (sessionType) => {
    await writeJsonAtomic(fluxQueuePath(args.workspaceRoot, args.config, sessionType), projection.queues[sessionType]);
  }));
  return projection;
}

export async function appendProjectionEventsAndRebuild(args: {
  workspaceRoot: string;
  config: FluxConfig;
  configPath: string;
  events: FluxEvent[];
}): Promise<{
  state: FluxRunState;
  queues: Record<FluxSessionType, FluxQueueSnapshot>;
}> {
  await appendFluxEvents(args.workspaceRoot, args.config, args.events);
  return await rebuildFluxProjections({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    configPath: args.configPath,
  });
}
