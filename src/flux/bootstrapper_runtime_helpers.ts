import fs from "node:fs/promises";
import path from "node:path";
import { modelRevisionWorkspaceSource } from "./model_revision_store.js";
import type { FluxConfig, FluxSolverInterruptPolicy } from "./types.js";

export async function listModelerTheoryFiles(workspaceRoot: string, config: FluxConfig): Promise<string[]> {
  const modelWorkspace = modelRevisionWorkspaceSource(workspaceRoot, config);
  const theoryDir = path.join(modelWorkspace, "modeler_handoff");
  try {
    const entries = await fs.readdir(theoryDir);
    return entries
      .filter((entry) => /^untrusted_theories_level_\d+\.md$/i.test(entry))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((entry) => path.relative(workspaceRoot, path.join(theoryDir, entry)));
  } catch {
    return [];
  }
}

export function normalizeInterruptPolicy(value: unknown): FluxSolverInterruptPolicy {
  const normalized = String(value ?? "").trim();
  if (normalized === "queue_and_interrupt" || normalized === "queue_without_interrupt" || normalized === "no_action") {
    return normalized;
  }
  return "queue_without_interrupt";
}

export function shouldWaitForNewInputsAfterFailedRehearsal(args: {
  decision: string;
  interruptPolicy: FluxSolverInterruptPolicy;
  seedDeltaKind: string;
  seedChanged: boolean;
  seedBundleUpdated: boolean;
}): boolean {
  if (args.decision !== "finalize_seed") return false;
  if (args.interruptPolicy !== "no_action") return false;
  if (args.seedDeltaKind !== "no_useful_change") return false;
  return !args.seedBundleUpdated || !args.seedChanged;
}
