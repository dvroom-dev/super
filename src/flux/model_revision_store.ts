import fs from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../lib/fs.js";
import { fluxModelRevisionDir, fluxModelRevisionSummaryPath, fluxModelRevisionWorkspaceDir, fluxModelRoot } from "./paths.js";
import { preferCoverageSummary } from "./model_coverage.js";
import type { FluxConfig, FluxModelCoverageSummary } from "./types.js";

async function copyDirStable(source: string, destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

export async function persistModelRevisionWorkspace(args: {
  workspaceRoot: string;
  config: FluxConfig;
  revisionId: string;
  sourceWorkspaceDir: string;
}): Promise<string> {
  const revisionDir = fluxModelRevisionDir(args.workspaceRoot, args.config, args.revisionId);
  const workspaceDir = fluxModelRevisionWorkspaceDir(args.workspaceRoot, args.config, args.revisionId);
  await fs.mkdir(revisionDir, { recursive: true });
  const leafName = path.basename(args.sourceWorkspaceDir);
  const destination = path.join(workspaceDir, leafName);
  if (path.resolve(args.sourceWorkspaceDir) === path.resolve(args.workspaceRoot)) {
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(destination, { recursive: true });
    return destination;
  }
  await copyDirStable(args.sourceWorkspaceDir, destination);
  return destination;
}

export async function saveModelCoverageSummary(args: {
  workspaceRoot: string;
  config: FluxConfig;
  revisionId: string;
  summary: FluxModelCoverageSummary;
}): Promise<FluxModelCoverageSummary> {
  await fs.mkdir(fluxModelRevisionDir(args.workspaceRoot, args.config, args.revisionId), { recursive: true });
  const existing = await readJsonIfExists<FluxModelCoverageSummary>(fluxModelRevisionSummaryPath(args.workspaceRoot, args.config, args.revisionId));
  const storedSummary = preferCoverageSummary(existing, args.summary);
  await writeJsonAtomic(fluxModelRevisionSummaryPath(args.workspaceRoot, args.config, args.revisionId), storedSummary);
  await fs.mkdir(path.join(fluxModelRoot(args.workspaceRoot, args.config), "current"), { recursive: true });
  await writeJsonAtomic(path.join(fluxModelRoot(args.workspaceRoot, args.config), "current", "meta.json"), {
    revisionId: args.revisionId,
    updatedAt: new Date().toISOString(),
    summary: storedSummary,
  });
  return storedSummary;
}

export async function loadModelCoverageSummary(
  workspaceRoot: string,
  config: FluxConfig,
  revisionId: string,
): Promise<FluxModelCoverageSummary | null> {
  return await readJsonIfExists<FluxModelCoverageSummary>(fluxModelRevisionSummaryPath(workspaceRoot, config, revisionId));
}

export function modelRevisionWorkspaceLeaf(config: FluxConfig): string {
  const workingDirectory = config.modeler.workingDirectory ?? ".";
  return path.basename(workingDirectory === "." ? "workspace" : workingDirectory);
}

export function modelRevisionWorkspaceSource(workspaceRoot: string, config: FluxConfig): string {
  return path.resolve(workspaceRoot, config.modeler.workingDirectory ?? ".");
}

export function modelRevisionWorkspacePath(
  workspaceRoot: string,
  config: FluxConfig,
  revisionId: string,
): string {
  return path.join(fluxModelRevisionWorkspaceDir(workspaceRoot, config, revisionId), modelRevisionWorkspaceLeaf(config));
}
