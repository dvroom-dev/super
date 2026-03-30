import fs from "node:fs/promises";
import { ensureFluxDirs } from "./state.js";
import { fluxEventsPath } from "./paths.js";
import type { FluxConfig, FluxEvent } from "./types.js";

export async function appendFluxEvents(workspaceRoot: string, config: FluxConfig, events: FluxEvent[]): Promise<void> {
  if (events.length === 0) return;
  await ensureFluxDirs(workspaceRoot, config);
  await fs.appendFile(fluxEventsPath(workspaceRoot, config), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

export async function readFluxEvents(workspaceRoot: string, config: FluxConfig): Promise<FluxEvent[]> {
  try {
    const raw = await fs.readFile(fluxEventsPath(workspaceRoot, config), "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FluxEvent);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}
