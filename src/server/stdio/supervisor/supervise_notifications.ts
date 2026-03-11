import type { StdioContext } from "../requests/context.js";

type ContextStatsParams = {
  docPath: string;
  contextLimit?: number | null;
  strategy?: string | null;
  fullPrompt: boolean;
  compacted: boolean;
  sourceBytes: number;
  trimmedBlocks: number;
  droppedItemStartedEvents: number;
  droppedEmptySuccessfulCommands: number;
  droppedReasoningSnapshots: number;
  droppedOverflowEvents: number;
  offloadedBlocks: number;
  offloadedBytes: number;
};

export function emitContextStats(ctx: StdioContext, params: ContextStatsParams): void {
  ctx.sendNotification({ method: "conversation.context_stats", params });
}

export function emitSupervisorTurnDecision(
  ctx: StdioContext,
  params: {
    turn: number;
    mode: "hard" | "soft" | "none";
    reasons: string[];
    streamEnded: boolean;
    cadenceHit: boolean;
    hadError: boolean;
    interrupted: boolean;
  },
): void {
  ctx.sendNotification({ method: "conversation.supervisor_turn_decision", params });
}

export function emitSuperviseTurnSettings(
  ctx: StdioContext,
  params: {
    turn: number;
    mode: string;
    agentReasoningEffort?: string;
    supervisorReasoningEffort?: string;
    providerBuiltinTools?: string[];
    promptMode: "full" | "incremental";
  },
): void {
  ctx.sendNotification({ method: "conversation.supervise_turn_settings", params });
}

export function emitSupervisorRunStart(
  ctx: StdioContext,
  params: { turn: number; mode: "hard" | "soft"; reasons: string[]; stopDetails: string[] },
): void {
  ctx.sendNotification({ method: "conversation.supervisor_run_start", params });
}

export function emitSupervisorRunEnd(
  ctx: StdioContext,
  params: {
    turn: number;
    mode: "hard" | "soft";
    action: string;
    resume: boolean;
    reasons: string[];
    edits: number;
    appendEdits: number;
    replaceEdits: number;
    blocks: number;
    violations: number;
    critique?: string;
  },
): void {
  ctx.sendNotification({ method: "conversation.supervisor_run_end", params });
}
