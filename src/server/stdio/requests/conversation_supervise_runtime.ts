import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { appendTurnTelemetry } from "../supervisor/telemetry.js";
import type { StdioContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export function shouldUseFullPromptForSupervise(fullResyncNeeded: boolean, currentThreadId?: string): boolean { return fullResyncNeeded || !currentThreadId; }

export function allowedNextModesFor(args: { renderedRunConfig: RenderedRunConfig; activeMode: string }): string[] {
  const modesEnabled = args.renderedRunConfig?.modesEnabled ?? true;
  if (!modesEnabled) return [];
  const explicit = args.renderedRunConfig?.modeStateMachine?.transitions?.[args.activeMode];
  if (Array.isArray(explicit) && explicit.length) return [...explicit];
  const configuredModes = Object.keys(args.renderedRunConfig?.modes ?? {});
  return configuredModes.length ? configuredModes : [];
}

export function createRunLifecycle(args: {
  ctx: StdioContext;
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
  ctx: StdioContext;
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
