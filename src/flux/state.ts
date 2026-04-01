import fs from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../lib/fs.js";
import type { FluxConfig, FluxRunState } from "./types.js";
import { fluxAiRoot, fluxLogsDir, fluxRoot, fluxStatePath } from "./paths.js";

export async function ensureFluxDirs(workspaceRoot: string, config: FluxConfig): Promise<void> {
  await fs.mkdir(fluxRoot(workspaceRoot, config), { recursive: true });
  await fs.mkdir(fluxAiRoot(workspaceRoot, config), { recursive: true });
  await fs.mkdir(path.join(fluxRoot(workspaceRoot, config), "queues"), { recursive: true });
  await fs.mkdir(fluxLogsDir(workspaceRoot, config), { recursive: true });
}

export async function loadFluxState(workspaceRoot: string, config: FluxConfig): Promise<FluxRunState | null> {
  return await readJsonIfExists<FluxRunState>(fluxStatePath(workspaceRoot, config));
}

export async function saveFluxState(workspaceRoot: string, config: FluxConfig, state: FluxRunState): Promise<void> {
  await ensureFluxDirs(workspaceRoot, config);
  await writeJsonAtomic(fluxStatePath(workspaceRoot, config), state);
}
