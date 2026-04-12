import fs from "node:fs/promises";
import { readJsonIfExists, writeJsonAtomic } from "../lib/fs.js";
import {
  fluxInvocationDir,
  fluxInvocationInputPath,
  fluxInvocationResultPath,
  fluxInvocationsRoot,
  fluxInvocationStatusPath,
} from "./paths.js";
import { ensureFluxDirs } from "./state.js";
import type {
  FluxConfig,
  FluxInvocationInput,
  FluxInvocationResult,
  FluxInvocationStatus,
  FluxInvocationStatusRecord,
  FluxSessionType,
} from "./types.js";

function invocationTypeForSession(sessionType: FluxSessionType) {
  if (sessionType === "solver") return "solver_invocation" as const;
  if (sessionType === "modeler") return "modeler_invocation" as const;
  return "bootstrapper_invocation" as const;
}

async function ensureInvocationDir(workspaceRoot: string, config: FluxConfig, invocationId: string): Promise<void> {
  await ensureFluxDirs(workspaceRoot, config);
  await fs.mkdir(fluxInvocationDir(workspaceRoot, config, invocationId), { recursive: true });
}

export async function persistFluxInvocationInput(
  workspaceRoot: string,
  config: FluxConfig,
  input: FluxInvocationInput,
): Promise<void> {
  await ensureInvocationDir(workspaceRoot, config, input.invocationId);
  const existing = await readJsonIfExists<FluxInvocationInput>(fluxInvocationInputPath(workspaceRoot, config, input.invocationId));
  if (!existing) {
    await writeJsonAtomic(fluxInvocationInputPath(workspaceRoot, config, input.invocationId), input);
  }
  const statusPath = fluxInvocationStatusPath(workspaceRoot, config, input.invocationId);
  const status = await readJsonIfExists<FluxInvocationStatusRecord>(statusPath);
  if (!status) {
    await writeJsonAtomic(statusPath, {
      invocationId: input.invocationId,
      invocationType: input.invocationType,
      sessionType: input.sessionType,
      status: "pending",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    } satisfies FluxInvocationStatusRecord);
  }
}

export async function loadFluxInvocationInput(
  workspaceRoot: string,
  config: FluxConfig,
  invocationId: string,
): Promise<FluxInvocationInput | null> {
  return await readJsonIfExists<FluxInvocationInput>(fluxInvocationInputPath(workspaceRoot, config, invocationId));
}

export async function loadFluxInvocationStatus(
  workspaceRoot: string,
  config: FluxConfig,
  invocationId: string,
): Promise<FluxInvocationStatusRecord | null> {
  return await readJsonIfExists<FluxInvocationStatusRecord>(fluxInvocationStatusPath(workspaceRoot, config, invocationId));
}

export async function saveFluxInvocationStatus(
  workspaceRoot: string,
  config: FluxConfig,
  status: FluxInvocationStatusRecord,
): Promise<void> {
  await ensureInvocationDir(workspaceRoot, config, status.invocationId);
  await writeJsonAtomic(fluxInvocationStatusPath(workspaceRoot, config, status.invocationId), status);
}

export async function markFluxInvocationStatus(args: {
  workspaceRoot: string;
  config: FluxConfig;
  invocationId: string;
  sessionType: FluxSessionType;
  status: FluxInvocationStatus;
  sessionId?: string;
  attemptId?: string;
  error?: string;
}): Promise<FluxInvocationStatusRecord> {
  const current = await loadFluxInvocationStatus(args.workspaceRoot, args.config, args.invocationId);
  const input = current
    ? null
    : await loadFluxInvocationInput(args.workspaceRoot, args.config, args.invocationId);
  const createdAt = current?.createdAt ?? input?.createdAt ?? new Date().toISOString();
  const invocationType = current?.invocationType ?? input?.invocationType ?? invocationTypeForSession(args.sessionType);
  const next: FluxInvocationStatusRecord = {
    invocationId: args.invocationId,
    invocationType,
    sessionType: args.sessionType,
    status: args.status,
    createdAt,
    updatedAt: new Date().toISOString(),
    startedAt: args.status === "running"
      ? (current?.startedAt ?? new Date().toISOString())
      : current?.startedAt,
    completedAt: ["completed", "failed", "superseded", "canceled"].includes(args.status)
      ? new Date().toISOString()
      : current?.completedAt,
    sessionId: args.sessionId ?? current?.sessionId,
    attemptId: args.attemptId ?? current?.attemptId,
    error: args.error ?? current?.error,
  };
  await saveFluxInvocationStatus(args.workspaceRoot, args.config, next);
  return next;
}

export async function saveFluxInvocationResult(
  workspaceRoot: string,
  config: FluxConfig,
  result: FluxInvocationResult,
): Promise<void> {
  await ensureInvocationDir(workspaceRoot, config, result.invocationId);
  await writeJsonAtomic(fluxInvocationResultPath(workspaceRoot, config, result.invocationId), result);
}

export async function loadFluxInvocationResult(
  workspaceRoot: string,
  config: FluxConfig,
  invocationId: string,
): Promise<FluxInvocationResult | null> {
  return await readJsonIfExists<FluxInvocationResult>(fluxInvocationResultPath(workspaceRoot, config, invocationId));
}

export async function listFluxInvocationIds(workspaceRoot: string, config: FluxConfig): Promise<string[]> {
  try {
    const entries = await fs.readdir(fluxInvocationsRoot(workspaceRoot, config), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
