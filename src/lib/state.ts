import fs from "node:fs/promises";
import path from "node:path";
import type { SuperEvent, SuperState } from "./types.ts";
import { eventsPath, exportsDir, statePath, exportSessionPath, superDir } from "./paths.ts";
import { readJsonIfExists, writeJsonAtomic, writeTextAtomic } from "./fs.ts";

export async function ensureSuperDirs(workspaceRoot: string): Promise<void> {
  await fs.mkdir(superDir(workspaceRoot), { recursive: true });
  await fs.mkdir(exportsDir(workspaceRoot), { recursive: true });
}

export async function loadSuperState(workspaceRoot: string): Promise<SuperState | null> {
  return await readJsonIfExists<SuperState>(statePath(workspaceRoot));
}

export async function saveSuperState(workspaceRoot: string, state: SuperState): Promise<void> {
  await ensureSuperDirs(workspaceRoot);
  await writeJsonAtomic(statePath(workspaceRoot), state);
}

export async function appendEvents(workspaceRoot: string, events: SuperEvent[]): Promise<void> {
  if (events.length === 0) return;
  await ensureSuperDirs(workspaceRoot);
  const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await fs.appendFile(eventsPath(workspaceRoot), lines, "utf8");
}

export async function exportSessionDocument(workspaceRoot: string, documentText: string, outputPath?: string): Promise<void> {
  await ensureSuperDirs(workspaceRoot);
  await writeTextAtomic(exportSessionPath(workspaceRoot), documentText);
  if (outputPath) {
    await writeTextAtomic(path.resolve(outputPath), documentText);
  }
}
