import fs from "node:fs/promises";
import path from "node:path";

type AnalysisLevelPin = {
  level: number;
  phase?: string;
};

async function readJsonFile(filePath: string): Promise<any | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function loadAnalysisLevelPin(agentBaseDir: string): Promise<AnalysisLevelPin | undefined> {
  try {
    const entries = await fs.readdir(agentBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const payload = await readJsonFile(path.join(agentBaseDir, entry.name, ".analysis_level_pin.json"));
      const level = Number((payload as any)?.level);
      if (!Number.isFinite(level) || level <= 0) continue;
      return {
        level: Math.trunc(level),
        phase: typeof (payload as any)?.phase === "string" ? String((payload as any).phase) : undefined,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function loadCurrentLevel(workspaceRoot: string): Promise<number | undefined> {
  const payload = await readJsonFile(path.join(workspaceRoot, "supervisor", "arc", "state.json"));
  const currentLevel = Number((payload as any)?.current_level);
  if (!Number.isFinite(currentLevel) || currentLevel <= 0) return undefined;
  return Math.trunc(currentLevel);
}

export async function shouldForceFreshForkAcrossLevelBoundary(args: {
  workspaceRoot: string;
  agentBaseDir: string;
}): Promise<boolean> {
  const pin = await loadAnalysisLevelPin(args.agentBaseDir);
  if (!pin) return false;
  const currentLevel = await loadCurrentLevel(args.workspaceRoot);
  if (!currentLevel) return false;
  return currentLevel > pin.level;
}
