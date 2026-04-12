import fs from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../lib/fs.js";
import type { FluxConfig, FluxRunState } from "./types.js";
import { fluxAiRoot, fluxCanonicalEventsDir, fluxInvocationsRoot, fluxLogsDir, fluxRoot, fluxStatePath } from "./paths.js";

const stateWriteChains = new Map<string, Promise<void>>();

export async function ensureFluxDirs(workspaceRoot: string, config: FluxConfig): Promise<void> {
  await fs.mkdir(fluxRoot(workspaceRoot, config), { recursive: true });
  await fs.mkdir(fluxAiRoot(workspaceRoot, config), { recursive: true });
  await fs.mkdir(path.join(fluxRoot(workspaceRoot, config), "queues"), { recursive: true });
  await fs.mkdir(fluxCanonicalEventsDir(workspaceRoot, config), { recursive: true });
  await fs.mkdir(fluxInvocationsRoot(workspaceRoot, config), { recursive: true });
  await fs.mkdir(fluxLogsDir(workspaceRoot, config), { recursive: true });
}

export async function loadFluxState(workspaceRoot: string, config: FluxConfig): Promise<FluxRunState | null> {
  return await readJsonIfExists<FluxRunState>(fluxStatePath(workspaceRoot, config));
}

export async function saveFluxState(workspaceRoot: string, config: FluxConfig, state: FluxRunState): Promise<void> {
  await ensureFluxDirs(workspaceRoot, config);
  await writeJsonAtomic(fluxStatePath(workspaceRoot, config), state);
}

export async function mutateFluxState(
  workspaceRoot: string,
  config: FluxConfig,
  updater: (state: FluxRunState | null) => Promise<FluxRunState> | FluxRunState,
): Promise<FluxRunState> {
  const key = fluxStatePath(workspaceRoot, config);
  const previous = stateWriteChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const currentChain = previous.catch(() => undefined).then(() => gate);
  stateWriteChains.set(key, currentChain);
  await previous.catch(() => undefined);
  try {
    const current = await loadFluxState(workspaceRoot, config);
    const next = await updater(current);
    await saveFluxState(workspaceRoot, config, next);
    return next;
  } finally {
    release();
    if (stateWriteChains.get(key) === currentChain) {
      stateWriteChains.delete(key);
    }
  }
}
