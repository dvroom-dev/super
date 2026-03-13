import path from "node:path";
import fs from "node:fs/promises";
import type { ContextManagementStrategy, ManagedAgentContextStats } from "../../../supervisor/context_management.js";
import type { TurnResult } from "./agent_turn.js";

type JsonRecord = Record<string, unknown>;

export type TurnTelemetryEntry = {
  timestamp: string;
  conversationId: string;
  forkId: string;
  turn: number;
  provider: string;
  agentModel: string;
  supervisorModel: string;
  prompt: {
    mode: "full" | "incremental";
    bytes: number;
    parseErrors: number;
    agentReasoningEffort?: string;
    supervisorReasoningEffort?: string;
    providerBuiltinTools?: string[];
  };
  context: {
    strategy?: string;
    sourceBytes: number;
    managedBytes: number;
    trimmedBlocks: number;
    droppedItemStartedEvents: number;
    droppedEmptySuccessfulCommands: number;
    droppedReasoningSnapshots: number;
    droppedOverflowEvents: number;
    offloadedBlocks: number;
    offloadedBytes: number;
  };
  agent: {
    assistantBytes: number;
    hadError: boolean;
    errorMessage?: string | null;
    streamEnded: boolean;
    interrupted: boolean;
    interruptionReason?: string | null;
    toolCalls: number;
    usage?: JsonRecord;
  };
  stop: {
    reasons: string[];
    details: string[];
    cadenceHit: boolean;
    cadenceReason?: string | null;
  };
  supervisor: {
    triggered: boolean;
    mode: "hard" | "soft" | "none";
    action?: string;
    resume?: boolean;
    edits?: number;
    appendEdits?: number;
    replaceEdits?: number;
    blocks?: number;
    violations?: number;
    critique?: string;
  };
  timing: {
    runElapsedMs: number;
    turnElapsedMs: number;
    promptBuildMs: number;
    agentTurnMs: number;
    inlineToolMs: number;
    transitionMs: number;
    finalizeMs: number;
    supervisorReviewMs: number;
  };
  budget: {
    adjustedTokensUsed: number;
    elapsedMs: number;
  };
};

type BuildTurnTelemetryBaseArgs = {
  timestamp?: string;
  conversationId: string;
  forkId: string;
  turn: number;
  provider: string;
  agentModel: string;
  supervisorModel: string;
  promptMode: "full" | "incremental";
  promptBytes: number;
  parseErrors: number;
  agentReasoningEffort?: string;
  supervisorReasoningEffort?: string;
  providerBuiltinTools?: string[];
  contextStrategy?: ContextManagementStrategy;
  sourceBytes: number;
  managedBytes: number;
  contextStats: ManagedAgentContextStats;
  result: TurnResult;
  stopReasons: string[];
  stopDetails: string[];
  adjustedTokensUsed: number;
  elapsedMs: number;
  turnElapsedMs: number;
  promptBuildMs: number;
  agentTurnMs: number;
  inlineToolMs: number;
  transitionMs: number;
  finalizeMs: number;
  supervisorReviewMs: number;
};

function toFiniteNumber(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function sanitizeUsage(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const next: JsonRecord = {};
  const mappings: Array<[string, string[]]> = [
    ["input_tokens", ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]],
    ["cached_input_tokens", ["cached_input_tokens", "cachedInputTokens"]],
    ["output_tokens", ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]],
    ["total_tokens", ["total_tokens", "totalTokens"]],
  ];
  for (const [target, aliases] of mappings) {
    for (const alias of aliases) {
      const n = toFiniteNumber(usage[alias]);
      if (n == null) continue;
      next[target] = Math.max(0, Math.floor(n));
      break;
    }
  }
  return Object.keys(next).length ? next : undefined;
}

export function buildTurnTelemetryBase(args: BuildTurnTelemetryBaseArgs): Omit<TurnTelemetryEntry, "supervisor"> {
  const {
    timestamp,
    conversationId,
    forkId,
    turn,
    provider,
    agentModel,
    supervisorModel,
    promptMode,
    promptBytes,
    parseErrors,
    agentReasoningEffort,
    supervisorReasoningEffort,
    providerBuiltinTools,
    contextStrategy,
    sourceBytes,
    managedBytes,
    contextStats,
    result,
    stopReasons,
    stopDetails,
    adjustedTokensUsed,
    elapsedMs,
    turnElapsedMs,
    promptBuildMs,
    agentTurnMs,
    inlineToolMs,
    transitionMs,
    finalizeMs,
    supervisorReviewMs,
  } = args;

  return {
    timestamp: timestamp ?? new Date().toISOString(),
    conversationId,
    forkId,
    turn,
    provider,
    agentModel,
    supervisorModel,
    prompt: {
      mode: promptMode,
      bytes: promptBytes,
      parseErrors,
      agentReasoningEffort,
      supervisorReasoningEffort,
      providerBuiltinTools,
    },
    context: {
      strategy: contextStrategy,
      sourceBytes,
      managedBytes,
      trimmedBlocks: contextStats.trimmedBlocks,
      droppedItemStartedEvents: contextStats.droppedItemStartedEvents,
      droppedEmptySuccessfulCommands: contextStats.droppedEmptySuccessfulCommands,
      droppedReasoningSnapshots: contextStats.droppedReasoningSnapshots,
      droppedOverflowEvents: contextStats.droppedOverflowEvents,
      offloadedBlocks: contextStats.offloadedBlocks,
      offloadedBytes: contextStats.offloadedBytes,
    },
    agent: {
      assistantBytes: Buffer.byteLength(result.assistantText ?? "", "utf8"),
      hadError: result.hadError,
      errorMessage: result.errorMessage,
      streamEnded: result.streamEnded,
      interrupted: result.interrupted,
      interruptionReason: result.interruptionReason,
      toolCalls: result.toolCalls?.length ?? 0,
      usage: result.usage as JsonRecord | undefined,
    },
    stop: {
      reasons: [...stopReasons],
      details: [...stopDetails],
      cadenceHit: result.cadenceHit,
      cadenceReason: result.cadenceReason,
    },
    timing: {
      runElapsedMs: elapsedMs,
      turnElapsedMs,
      promptBuildMs,
      agentTurnMs,
      inlineToolMs,
      transitionMs,
      finalizeMs,
      supervisorReviewMs,
    },
    budget: {
      adjustedTokensUsed,
      elapsedMs,
    },
  };
}

export async function appendTurnTelemetry(
  workspaceRoot: string,
  conversationId: string,
  entry: TurnTelemetryEntry,
): Promise<void> {
  const dir = path.join(workspaceRoot, ".ai-supervisor", "conversations", conversationId, "telemetry");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "turns.ndjson");
  const usage = sanitizeUsage(entry.agent.usage);
  const payload: TurnTelemetryEntry = {
    ...entry,
    agent: {
      ...entry.agent,
      usage,
    },
  };
  await fs.appendFile(filePath, JSON.stringify(payload) + "\n", "utf8");
}

export async function loadLastTurnTelemetryTurn(
  workspaceRoot: string,
  conversationId: string,
): Promise<number> {
  const filePath = path.join(
    workspaceRoot,
    ".ai-supervisor",
    "conversations",
    conversationId,
    "telemetry",
    "turns.ndjson",
  );
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return 0;
    throw err;
  }
  const lines = raw.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as { turn?: unknown };
      const turn = Number(parsed.turn);
      if (Number.isFinite(turn) && turn > 0) return Math.floor(turn);
    } catch {
      continue;
    }
  }
  return 0;
}
