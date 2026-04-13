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

export function fluxCanonicalEventsDir(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "events");
}

export function fluxCanonicalEventsPath(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxCanonicalEventsDir(workspaceRoot, config), "events.ndjson");
}

export function fluxLogsDir(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "logs");
}

export function fluxFatalLogPath(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxLogsDir(workspaceRoot, config), "fatal.log");
}

export function fluxOrchestratorLogPath(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxLogsDir(workspaceRoot, config), "orchestrator.log");
}

export function fluxRunLockPath(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "run.lock.json");
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

export function fluxInvocationsRoot(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "invocations");
}

export function fluxInvocationDir(workspaceRoot: string, config: FluxConfig, invocationId: string): string {
  return path.join(fluxInvocationsRoot(workspaceRoot, config), invocationId);
}

export function fluxInvocationInputPath(workspaceRoot: string, config: FluxConfig, invocationId: string): string {
  return path.join(fluxInvocationDir(workspaceRoot, config, invocationId), "input.json");
}

export function fluxInvocationStatusPath(workspaceRoot: string, config: FluxConfig, invocationId: string): string {
  return path.join(fluxInvocationDir(workspaceRoot, config, invocationId), "status.json");
}

export function fluxInvocationResultPath(workspaceRoot: string, config: FluxConfig, invocationId: string): string {
  return path.join(fluxInvocationDir(workspaceRoot, config, invocationId), "result.json");
}

export function fluxModelRoot(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "model");
}

export function fluxModelRevisionsRoot(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxModelRoot(workspaceRoot, config), "revisions");
}

export function fluxModelDraftsRoot(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxModelRoot(workspaceRoot, config), "drafts");
}

export function fluxModelDraftDir(workspaceRoot: string, config: FluxConfig, invocationId: string): string {
  return path.join(fluxModelDraftsRoot(workspaceRoot, config), invocationId);
}

export function fluxModelLabelsRoot(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxModelRoot(workspaceRoot, config), "feature_labels");
}

export function fluxModelRevisionDir(workspaceRoot: string, config: FluxConfig, revisionId: string): string {
  return path.join(fluxModelRevisionsRoot(workspaceRoot, config), revisionId);
}

export function fluxModelRevisionWorkspaceDir(workspaceRoot: string, config: FluxConfig, revisionId: string): string {
  return path.join(fluxModelRevisionDir(workspaceRoot, config, revisionId), "workspace");
}

export function fluxModelRevisionSummaryPath(workspaceRoot: string, config: FluxConfig, revisionId: string): string {
  return path.join(fluxModelRevisionDir(workspaceRoot, config, revisionId), "summary.json");
}

export function fluxSeedRoot(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "seed");
}

export function fluxSessionDir(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: FluxSessionType,
  sessionId: string,
): string {
  return path.join(fluxSessionsRoot(workspaceRoot, config), sessionType, sessionId);
}
