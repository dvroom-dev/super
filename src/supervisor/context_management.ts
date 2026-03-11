import { parseChatMarkdown } from "../markdown/parse.js";
import { buildContextSkeleton } from "./context_skeleton.js";
import { loadPromptTemplate } from "./prompt_templates.js";
import { replaceReasoningWithSnapshots } from "./reasoning_snapshots.js";

export const CONTEXT_MANAGEMENT_STRATEGIES = ["conservative", "balanced", "focused", "aggressive"] as const;

export type ContextManagementStrategy = (typeof CONTEXT_MANAGEMENT_STRATEGIES)[number];

type StrategySpec = {
  templatePath: string;
  maxInlineBytes: number;
  kindsToOffload: string[];
  keepRecentReasoningSnapshots: number;
  maxEventBlocks?: number;
};

const STRATEGY_SPECS: Record<ContextManagementStrategy, StrategySpec> = {
  conservative: {
    templatePath: "context_management/conservative.md",
    maxInlineBytes: 32 * 1024,
    kindsToOffload: ["tool_result"],
    keepRecentReasoningSnapshots: 16,
  },
  balanced: {
    templatePath: "context_management/balanced.md",
    maxInlineBytes: 8 * 1024,
    kindsToOffload: ["tool_result"],
    keepRecentReasoningSnapshots: 12,
    maxEventBlocks: 24,
  },
  focused: {
    templatePath: "context_management/focused.md",
    maxInlineBytes: 8 * 1024,
    kindsToOffload: ["tool_result"],
    keepRecentReasoningSnapshots: 8,
    maxEventBlocks: 16,
  },
  aggressive: {
    templatePath: "context_management/aggressive.md",
    maxInlineBytes: 4 * 1024,
    kindsToOffload: ["tool_result"],
    keepRecentReasoningSnapshots: 4,
    maxEventBlocks: 12,
  },
};

const EVENT_BLOCK_KINDS = new Set(["tool_result", "tool_call"]);

export type ManagedAgentContextStats = {
  strategy?: ContextManagementStrategy;
  trimmedBlocks: number;
  droppedItemStartedEvents: number;
  droppedEmptySuccessfulCommands: number;
  droppedReasoningSnapshots: number;
  droppedOverflowEvents: number;
  offloadedBlocks: number;
  offloadedBytes: number;
};

export type ManagedAgentContextResult = {
  documentText: string;
  stats: ManagedAgentContextStats;
};

export function normalizeContextManagementStrategy(
  raw: unknown,
  sourceLabel = "config",
): ContextManagementStrategy | undefined {
  if (raw == null) return undefined;
  const asString = typeof raw === "string" ? raw : typeof (raw as any)?.name === "string" ? String((raw as any).name) : "";
  const value = asString.trim().toLowerCase();
  if (!value) return undefined;
  if ((CONTEXT_MANAGEMENT_STRATEGIES as readonly string[]).includes(value)) {
    return value as ContextManagementStrategy;
  }
  throw new Error(
    `${sourceLabel}: invalid context_management_strategy '${asString}' (expected one of ${CONTEXT_MANAGEMENT_STRATEGIES.join(", ")})`
  );
}

function strategyPrompt(strategy: ContextManagementStrategy): string {
  const template = loadPromptTemplate(STRATEGY_SPECS[strategy].templatePath);
  return template.trim();
}

export function applyContextManagementStrategy(systemMessage: string, strategy?: ContextManagementStrategy): string {
  if (!strategy) return systemMessage;
  const prompt = strategyPrompt(strategy);
  if (!prompt) return systemMessage;
  return [systemMessage, "", prompt].join("\n");
}

function trimDocumentForStrategy(documentText: string, strategy: ContextManagementStrategy): {
  documentText: string;
  stats: Omit<ManagedAgentContextStats, "strategy" | "offloadedBlocks" | "offloadedBytes">;
} {
  const spec = STRATEGY_SPECS[strategy];
  const parsed = parseChatMarkdown(documentText);
  if (parsed.blocks.length === 0) {
    return {
      documentText,
      stats: {
        trimmedBlocks: 0,
        droppedItemStartedEvents: 0,
        droppedEmptySuccessfulCommands: 0,
        droppedReasoningSnapshots: 0,
        droppedOverflowEvents: 0,
      },
    };
  }

  const dropIndexes = new Set<number>();
  let droppedReasoningSnapshots = 0;
  let droppedOverflowEvents = 0;

  const eventBlockIndexes: number[] = [];
  for (let i = 0; i < parsed.blocks.length; i += 1) {
    const block = parsed.blocks[i] as any;
    if (!EVENT_BLOCK_KINDS.has(block.kind)) continue;
    if (block.kind === "tool_call" && String(block.name ?? "") === "reasoning_snapshot") continue;
    const prev = parsed.blocks[i - 1] as any;
    if (
      block.kind === "tool_result" &&
      prev?.kind === "tool_call" &&
      String(prev?.name ?? "") === "reasoning_snapshot"
    ) {
      continue;
    }
    eventBlockIndexes.push(i);
  }

  if (typeof spec.maxEventBlocks === "number" && eventBlockIndexes.length > spec.maxEventBlocks) {
    const trimCount = eventBlockIndexes.length - spec.maxEventBlocks;
    for (let i = 0; i < trimCount; i += 1) {
      dropIndexes.add(eventBlockIndexes[i]);
    }
    droppedOverflowEvents = trimCount;
  }

  const snapshotPairs: Array<{ callIndex: number; resultIndex?: number }> = [];
  for (let i = 0; i < parsed.blocks.length; i += 1) {
    const block = parsed.blocks[i] as any;
    if (block.kind !== "tool_call" || String(block.name ?? "") !== "reasoning_snapshot") continue;
    const next = parsed.blocks[i + 1] as any;
    const resultIndex = next?.kind === "tool_result" ? i + 1 : undefined;
    snapshotPairs.push({ callIndex: i, resultIndex });
  }

  if (snapshotPairs.length > spec.keepRecentReasoningSnapshots) {
    const cutoff = Math.max(0, snapshotPairs.length - spec.keepRecentReasoningSnapshots);
    for (let i = 0; i < cutoff; i += 1) {
      const pair = snapshotPairs[i];
      if (!dropIndexes.has(pair.callIndex)) {
        dropIndexes.add(pair.callIndex);
        droppedReasoningSnapshots += 1;
      }
      if (typeof pair.resultIndex === "number" && !dropIndexes.has(pair.resultIndex)) {
        dropIndexes.add(pair.resultIndex);
      }
    }
  }

  if (dropIndexes.size === 0) {
    return {
      documentText,
      stats: {
        trimmedBlocks: 0,
        droppedItemStartedEvents: 0,
        droppedEmptySuccessfulCommands: 0,
        droppedReasoningSnapshots,
        droppedOverflowEvents,
      },
    };
  }

  const lines = documentText.split(/\r?\n/);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of dropIndexes) {
    const block = parsed.blocks[idx] as any;
    if (!Number.isFinite(block?.startLine) || !Number.isFinite(block?.endLine)) continue;
    ranges.push({ start: block.startLine, end: block.endLine });
  }

  ranges.sort((a, b) => b.start - a.start);
  for (const range of ranges) {
    const count = range.end - range.start + 1;
    if (count > 0) lines.splice(range.start, count);
  }

  const trimmedText = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return {
    documentText: trimmedText,
    stats: {
      trimmedBlocks: dropIndexes.size,
      droppedItemStartedEvents: 0,
      droppedEmptySuccessfulCommands: 0,
      droppedReasoningSnapshots,
      droppedOverflowEvents,
    },
  };
}

function contextManagementSummaryBlock(strategy: ContextManagementStrategy, stats: ManagedAgentContextStats): string {
  return [
    "```supervisor_summary type=context_management",
    `summary: context_management strategy=${strategy} trimmed=${stats.trimmedBlocks} offloaded=${stats.offloadedBlocks}`,
    `trimmed_blocks: ${stats.trimmedBlocks}`,
    `dropped_item_started_events: ${stats.droppedItemStartedEvents}`,
    `dropped_empty_successful_commands: ${stats.droppedEmptySuccessfulCommands}`,
    `dropped_reasoning_snapshots: ${stats.droppedReasoningSnapshots}`,
    `dropped_overflow_events: ${stats.droppedOverflowEvents}`,
    `offloaded_blocks: ${stats.offloadedBlocks}`,
    `offloaded_bytes: ${stats.offloadedBytes}`,
    "```",
  ].join("\n");
}

export async function prepareManagedAgentContext(args: {
  documentText: string;
  workspaceRoot: string;
  conversationId: string;
  strategy?: ContextManagementStrategy;
}): Promise<ManagedAgentContextResult> {
  if (!args.strategy) {
    return {
      documentText: args.documentText,
      stats: {
        trimmedBlocks: 0,
        droppedItemStartedEvents: 0,
        droppedEmptySuccessfulCommands: 0,
        droppedReasoningSnapshots: 0,
        droppedOverflowEvents: 0,
        offloadedBlocks: 0,
        offloadedBytes: 0,
      },
    };
  }

  const spec = STRATEGY_SPECS[args.strategy];
  const normalizedReasoning = replaceReasoningWithSnapshots(args.documentText);
  const trimmed = trimDocumentForStrategy(normalizedReasoning.text, args.strategy);
  const skeleton = await buildContextSkeleton({
    documentText: trimmed.documentText,
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    maxInlineBytes: spec.maxInlineBytes,
    kindsToOffload: spec.kindsToOffload,
  });

  const offloadedBytes = skeleton.blobs.reduce((sum, blob) => sum + blob.bytes, 0);
  const stats: ManagedAgentContextStats = {
    strategy: args.strategy,
    trimmedBlocks: trimmed.stats.trimmedBlocks,
    droppedItemStartedEvents: trimmed.stats.droppedItemStartedEvents,
    droppedEmptySuccessfulCommands: trimmed.stats.droppedEmptySuccessfulCommands,
    droppedReasoningSnapshots: trimmed.stats.droppedReasoningSnapshots,
    droppedOverflowEvents: trimmed.stats.droppedOverflowEvents,
    offloadedBlocks: skeleton.blobs.length,
    offloadedBytes,
  };

  if (stats.trimmedBlocks === 0 && stats.offloadedBlocks === 0) {
    return {
      documentText: skeleton.skeleton,
      stats,
    };
  }

  const summary = contextManagementSummaryBlock(args.strategy, stats);
  return {
    documentText: [skeleton.skeleton.trimEnd(), "", summary].join("\n"),
    stats,
  };
}
