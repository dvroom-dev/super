import path from "node:path";
import type { FluxConfig, FluxSessionType } from "./types.js";

export function fluxRoot(workspaceRoot: string, config: FluxConfig): string {
  return path.resolve(workspaceRoot, config.storage.fluxRoot);
}

export function fluxAiRoot(workspaceRoot: string, config: FluxConfig): string {
  return path.resolve(workspaceRoot, config.storage.aiRoot);
}

export function fluxStatePath(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "state.json");
}

export function fluxEventsPath(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "events.jsonl");
}

export function fluxQueuesDir(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "queues");
}

export function fluxQueuePath(workspaceRoot: string, config: FluxConfig, sessionType: FluxSessionType): string {
  return path.join(fluxQueuesDir(workspaceRoot, config), `${sessionType}.json`);
}

export function fluxSessionsRoot(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxAiRoot(workspaceRoot, config), "sessions");
}

export function fluxSessionDir(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: FluxSessionType,
  sessionId: string,
): string {
  return path.join(fluxSessionsRoot(workspaceRoot, config), sessionType, sessionId);
}
