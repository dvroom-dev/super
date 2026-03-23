import fs from "node:fs/promises";
import path from "node:path";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { appendTurnTelemetry } from "../supervisor/telemetry.js";
import type { RuntimeContext } from "./context.js";
import { frontmatterValue, resolveInitialMode } from "../supervisor/mode_runtime.js";
import {
  isV2ProcessEnabled,
  resolveInitialProcessStage,
  resolveTaskProfileMode,
} from "../supervisor/process_runtime.ts";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

type LevelCurrentMeta = {
  level?: number;
  analysis_level_pinned?: boolean;
};

export function shouldUseFullPromptForSupervise(fullResyncNeeded: boolean, currentThreadId?: string): boolean { return fullResyncNeeded || !currentThreadId; }

async function readLevelCurrentMeta(agentBaseDir: string): Promise<LevelCurrentMeta | undefined> {
  try {
    const raw = await fs.readFile(path.join(agentBaseDir, "level_current", "meta.json"), "utf8");
    const parsed = JSON.parse(raw) as LevelCurrentMeta;
    return typeof parsed === "object" && parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readLevelCurrentMetaForSupervise(agentBaseDir: string): Promise<LevelCurrentMeta | undefined> {
  return readLevelCurrentMeta(agentBaseDir);
}

export async function shouldRunInitialSupervisorBootstrap(args: {
  renderedRunConfig: RenderedRunConfig;
  documentText: string;
  currentThreadId?: string;
  agentBaseDir?: string;
}): Promise<boolean> {
  if (isV2ProcessEnabled(args.renderedRunConfig)) {
    if (args.currentThreadId) return false;
    return !frontmatterValue(args.documentText, "mode")?.trim();
  }
  if (!args.agentBaseDir) return false;
  if (args.currentThreadId) return false;
  if (frontmatterValue(args.documentText, "mode")?.trim()) return false;
  const levelMeta = await readLevelCurrentMeta(args.agentBaseDir);
  return Number(levelMeta?.level) === 1 && levelMeta?.analysis_level_pinned !== true;
}

export async function initialBootstrapModesFor(args: {
  renderedRunConfig: RenderedRunConfig;
  agentBaseDir?: string;
}): Promise<string[]> {
  if (isV2ProcessEnabled(args.renderedRunConfig)) {
    const initialStage = resolveInitialProcessStage(args.renderedRunConfig);
    const initialProfile = initialStage
      ? String(args.renderedRunConfig?.process?.stages?.[initialStage]?.profile ?? "").trim()
      : "";
    const initialMode = resolveTaskProfileMode(args.renderedRunConfig, initialProfile || null);
    return initialMode ? [initialMode] : [];
  }
  const initialMode = resolveInitialMode(args.renderedRunConfig);
  if (!initialMode) return [];
  return [initialMode];
}

export async function allowedNextModesFor(args: {
  renderedRunConfig: RenderedRunConfig;
  activeMode: string;
  agentBaseDir?: string;
}): Promise<string[]> {
  const modesEnabled = args.renderedRunConfig?.modesEnabled ?? true;
  if (!modesEnabled) return [];
  const explicit = args.renderedRunConfig?.modeStateMachine?.transitions?.[args.activeMode];
  if (args.agentBaseDir) {
    const levelMeta = await readLevelCurrentMeta(args.agentBaseDir);
    const level = Number(levelMeta?.level);
    if (level === 1 && levelMeta?.analysis_level_pinned !== true) {
      const allowedDuringLevelOne = new Set(["explore_and_solve", "code_model", "recover"]);
      if (Array.isArray(explicit) && explicit.length) {
        return explicit.filter((mode) => allowedDuringLevelOne.has(String(mode ?? "").trim()));
      }
      const configuredModes = Object.keys(args.renderedRunConfig?.modes ?? {});
      return configuredModes.filter((mode) => allowedDuringLevelOne.has(mode));
    }
  }
  if (Array.isArray(explicit) && explicit.length) return [...explicit];
  const configuredModes = Object.keys(args.renderedRunConfig?.modes ?? {});
  return configuredModes.length ? configuredModes : [];
}

export function createRunLifecycle(args: {
  ctx: RuntimeContext;
  docPath: string;
  conversationId: string;
  activeRuns: Record<string, AbortController>;
  activeRunsByForkId: Record<string, AbortController>;
  activeRunMeta: Record<string, { docPath: string; conversationId: string }>;
  activeForkId: string;
}) {
  let activeForkId = args.activeForkId;
  let runFinished = false;
  args.activeRunMeta[activeForkId] = { docPath: args.docPath, conversationId: args.conversationId };
  const finishRun = (status: string) => {
    if (runFinished) return;
    runFinished = true;
    delete args.activeRuns[args.docPath]; delete args.activeRunsByForkId[activeForkId]; delete args.activeRunMeta[activeForkId];
    args.ctx.sendNotification({ method: "conversation.run_finished", params: { conversationId: args.conversationId, forkId: activeForkId, docPath: args.docPath, status } });
  };
  const switchActiveFork = (nextForkId: string) => {
    if (!nextForkId || nextForkId === activeForkId) return;
    delete args.activeRunsByForkId[activeForkId]; args.activeRunsByForkId[nextForkId] = args.activeRuns[args.docPath];
    delete args.activeRunMeta[activeForkId]; args.activeRunMeta[nextForkId] = { docPath: args.docPath, conversationId: args.conversationId };
    args.ctx.sendNotification({ method: "conversation.run_finished", params: { conversationId: args.conversationId, forkId: activeForkId, docPath: args.docPath, status: "branched" } });
    args.ctx.sendNotification({ method: "conversation.run_started", params: { conversationId: args.conversationId, forkId: nextForkId, docPath: args.docPath } });
    activeForkId = nextForkId;
  };
  return { finishRun, switchActiveFork, currentForkId: () => activeForkId };
}

export async function writeTurnTelemetrySafely(args: {
  ctx: RuntimeContext;
  workspaceRoot: string;
  conversationId: string;
  entry: Parameters<typeof appendTurnTelemetry>[2];
  appendTurnTelemetry: typeof import("../supervisor/telemetry.js").appendTurnTelemetry;
}) {
  try {
    await args.appendTurnTelemetry(args.workspaceRoot, args.conversationId, args.entry);
  } catch (err: any) {
    args.ctx.sendNotification({ method: "log", params: { level: "warn", message: `turn telemetry write failed: ${err?.message ?? String(err)}` } });
  }
}
