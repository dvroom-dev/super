import fs from "node:fs";
import path from "node:path";
import type { FluxConfig, FluxEvent, FluxRunState } from "./types.js";
import { fluxCanonicalEventsPath, fluxEventsPath, fluxFatalLogPath, fluxOrchestratorLogPath, fluxStatePath } from "./paths.js";

function nowIso(): string {
  return new Date().toISOString();
}

function appendLine(filePath: string, line: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line.endsWith("\n") ? line : `${line}\n`, "utf8");
}

export function appendFluxRuntimeLog(
  workspaceRoot: string,
  config: FluxConfig,
  message: string,
): void {
  appendLine(fluxOrchestratorLogPath(workspaceRoot, config), `[${nowIso()}] ${message}`);
}

export function recordFluxFatalProcessState(args: {
  workspaceRoot: string;
  config: FluxConfig;
  event: FluxEvent;
  detail: string;
}): void {
  appendLine(fluxFatalLogPath(args.workspaceRoot, args.config), `[${nowIso()}] ${args.detail}`);
  appendLine(fluxCanonicalEventsPath(args.workspaceRoot, args.config), JSON.stringify(args.event));
  appendLine(fluxEventsPath(args.workspaceRoot, args.config), JSON.stringify(args.event));
  try {
    const raw = fs.readFileSync(fluxStatePath(args.workspaceRoot, args.config), "utf8");
    const state = JSON.parse(raw) as FluxRunState;
    state.status = "stopped";
    state.stopRequested = true;
    state.updatedAt = nowIso();
    fs.writeFileSync(fluxStatePath(args.workspaceRoot, args.config), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Best-effort crash path.
  }
}
