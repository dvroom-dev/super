import fs from "node:fs/promises";
import path from "node:path";
import type { ChatBlock, ToolCallBlock, ToolResultBlock } from "../../../markdown/ast.js";
import { parseChatMarkdown } from "../../../markdown/parse.js";
import { buildContextSkeleton } from "../../../supervisor/context_skeleton.js";
import { SupervisorStore } from "../../../store/store.js";
import type { ConversationIndex, ForkSummary } from "../../../store/types.js";

export type RunHistoryToolCount = {
  name: string;
  count: number;
};

export type RunHistoryForkSummary = {
  key: string;
  conversationId: string;
  forkId: string;
  parentId?: string;
  createdAt: string;
  label: string;
  forkSummary?: string;
  actionSummary?: string;
  mode?: string;
  docHash?: string;
  initialUserPreview?: string;
  lastAssistantPreview?: string;
  userTurns: number;
  assistantTurns: number;
  toolCallCount: number;
  toolResultCount: number;
  toolCounts: RunHistoryToolCount[];
  skeletonPath: string;
  summaryPath: string;
};

type RunHistoryIndex = {
  generatedAt: string;
  conversations: Array<{
    conversationId: string;
    forkCount: number;
    firstForkAt?: string;
    lastForkAt?: string;
    latestMode?: string;
  }>;
  forks: RunHistoryForkSummary[];
};

type ReviewWatermarkState = {
  reviewers: Record<
    string,
    {
      seenForkKeys: string[];
      updatedAt: string;
    }
  >;
};

export type SupervisorRunHistoryContext = {
  index: RunHistoryIndex;
  overviewText: string;
  deltaText: string;
  newForkCount: number;
  seenForkKeys: string[];
};

const PREVIEW_LIMIT = 320;

function supervisorRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".ai-supervisor", "supervisor");
}

function runHistoryRoot(workspaceRoot: string): string {
  return path.join(supervisorRoot(workspaceRoot), "run_history");
}

function reviewStatePath(workspaceRoot: string): string {
  return path.join(supervisorRoot(workspaceRoot), "review_state.json");
}

function conversationRoot(workspaceRoot: string, conversationId: string): string {
  return path.join(workspaceRoot, ".ai-supervisor", "conversations", conversationId);
}

function conversationHistoryRoot(workspaceRoot: string, conversationId: string): string {
  return path.join(conversationRoot(workspaceRoot, conversationId), "run_history");
}

function forkArtifactsRoot(workspaceRoot: string, conversationId: string): string {
  return path.join(conversationHistoryRoot(workspaceRoot, conversationId), "forks");
}

function cleanInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function preview(text: string | undefined, maxChars = PREVIEW_LIMIT): string | undefined {
  const cleaned = cleanInline(text ?? "");
  if (!cleaned) return undefined;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function parseModeFromDocument(text: string): string | undefined {
  const match = String(text ?? "").match(/^mode:\s*(.+)$/m);
  const value = match?.[1]?.trim();
  return value || undefined;
}

function parseTime(value: string | undefined): number {
  const ts = Date.parse(value ?? "");
  return Number.isFinite(ts) ? ts : 0;
}

function rel(workspaceRoot: string, absPath: string): string {
  return path.relative(workspaceRoot, absPath).replace(/\\/g, "/");
}

async function loadReviewState(workspaceRoot: string): Promise<ReviewWatermarkState> {
  try {
    return JSON.parse(await fs.readFile(reviewStatePath(workspaceRoot), "utf8")) as ReviewWatermarkState;
  } catch {
    return { reviewers: {} };
  }
}

async function saveReviewState(workspaceRoot: string, state: ReviewWatermarkState): Promise<void> {
  const filePath = reviewStatePath(workspaceRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

async function saveRunHistoryIndex(workspaceRoot: string, index: RunHistoryIndex): Promise<void> {
  const root = runHistoryRoot(workspaceRoot);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "index.json"), JSON.stringify(index, null, 2), "utf8");
  const lines: string[] = [
    "# Supervisor Run History",
    "",
    `generated_at: ${index.generatedAt}`,
    `conversations: ${index.conversations.length}`,
    `forks: ${index.forks.length}`,
    "",
    "## Conversations",
  ];
  if (!index.conversations.length) {
    lines.push("- (none)");
  } else {
    for (const convo of index.conversations) {
      lines.push(
        `- ${convo.conversationId} · forks=${convo.forkCount} · first=${convo.firstForkAt ?? "(unknown)"} · last=${convo.lastForkAt ?? "(unknown)"} · latest_mode=${convo.latestMode ?? "(unknown)"}`,
      );
    }
  }
  lines.push("", "## Forks");
  if (!index.forks.length) {
    lines.push("- (none)");
  } else {
    for (const fork of index.forks) {
      const toolMix = fork.toolCounts.length
        ? fork.toolCounts.map((entry) => `${entry.name}×${entry.count}`).join(", ")
        : "(none)";
      lines.push(
        `- ${fork.createdAt} · conv=${fork.conversationId} · fork=${fork.forkId} · mode=${fork.mode ?? "(unknown)"} · action=${fork.actionSummary ?? "(none)"} · user=\"${fork.initialUserPreview ?? "(none)"}\" · assistant=\"${fork.lastAssistantPreview ?? "(none)"}\" · tools=${toolMix} · skeleton=${fork.skeletonPath}`,
      );
    }
  }
  lines.push("");
  await fs.writeFile(path.join(root, "index.md"), lines.join("\n"), "utf8");
}

async function loadConversationIds(workspaceRoot: string): Promise<string[]> {
  const dir = path.join(workspaceRoot, ".ai-supervisor", "conversations");
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function countToolCalls(blocks: readonly ToolCallBlock[]): RunHistoryToolCount[] {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const name = block.name?.trim() || "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function latestPreview(blocks: ChatBlock[], role: "assistant" | "user"): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].role === role) {
      return preview(blocks[i].content);
    }
  }
  return undefined;
}

function firstPreview(blocks: ChatBlock[], role: "assistant" | "user"): string | undefined {
  for (const block of blocks) {
    if (block.role === role) {
      return preview(block.content);
    }
  }
  return undefined;
}

async function buildForkArtifact(args: {
  workspaceRoot: string;
  conversationId: string;
  fork: ForkSummary;
  documentText: string;
}): Promise<RunHistoryForkSummary> {
  const parsed = parseChatMarkdown(args.documentText);
  const chatBlocks = parsed.blocks.filter((block): block is ChatBlock => block.kind === "chat");
  const toolCallBlocks = parsed.blocks.filter((block): block is ToolCallBlock => block.kind === "tool_call");
  const toolResultBlocks = parsed.blocks.filter((block): block is ToolResultBlock => block.kind === "tool_result");
  const root = forkArtifactsRoot(args.workspaceRoot, args.conversationId);
  await fs.mkdir(root, { recursive: true });
  const skeletonPathAbs = path.join(root, `${args.fork.id}.skeleton.md`);
  const summaryPathAbs = path.join(root, `${args.fork.id}.summary.json`);
  const blobDir = path.join(root, `${args.fork.id}_blobs`);
  const skeleton = await buildContextSkeleton({
    documentText: args.documentText,
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    blobDir,
    blobPathBase: rel(args.workspaceRoot, blobDir),
  });
  await fs.mkdir(blobDir, { recursive: true });
  await fs.writeFile(skeletonPathAbs, skeleton.skeleton, "utf8");
  const summary: RunHistoryForkSummary = {
    key: `${args.conversationId}:${args.fork.id}`,
    conversationId: args.conversationId,
    forkId: args.fork.id,
    parentId: args.fork.parentId,
    createdAt: args.fork.createdAt,
    label: args.fork.label,
    forkSummary: args.fork.forkSummary,
    actionSummary: args.fork.actionSummary,
    mode: parseModeFromDocument(args.documentText),
    docHash: args.fork.docHash,
    initialUserPreview: firstPreview(chatBlocks, "user"),
    lastAssistantPreview: latestPreview(chatBlocks, "assistant"),
    userTurns: chatBlocks.filter((block) => block.role === "user").length,
    assistantTurns: chatBlocks.filter((block) => block.role === "assistant").length,
    toolCallCount: toolCallBlocks.length,
    toolResultCount: toolResultBlocks.length,
    toolCounts: countToolCalls(toolCallBlocks),
    skeletonPath: rel(args.workspaceRoot, skeletonPathAbs),
    summaryPath: rel(args.workspaceRoot, summaryPathAbs),
  };
  await fs.writeFile(summaryPathAbs, JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

async function loadOrBuildForkArtifact(args: {
  workspaceRoot: string;
  conversationId: string;
  fork: ForkSummary;
  store: SupervisorStore;
}): Promise<RunHistoryForkSummary> {
  const summaryPathAbs = path.join(forkArtifactsRoot(args.workspaceRoot, args.conversationId), `${args.fork.id}.summary.json`);
  try {
    const existing = JSON.parse(await fs.readFile(summaryPathAbs, "utf8")) as RunHistoryForkSummary;
    if (existing.docHash && args.fork.docHash && existing.docHash === args.fork.docHash) {
      return existing;
    }
  } catch {
    // Rebuild below.
  }
  const fullFork = await args.store.loadFork(args.workspaceRoot, args.conversationId, args.fork.id);
  return buildForkArtifact({
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    fork: args.fork,
    documentText: fullFork.documentText ?? "",
  });
}

function buildOverviewText(index: RunHistoryIndex): string {
  const lines: string[] = [
    "Run-wide fork index across all agent conversations for this run.",
    "Each entry is immutable and points to a full fork skeleton file if deeper context is needed.",
    "",
    "Conversations:",
  ];
  if (!index.conversations.length) {
    lines.push("- (none)");
  } else {
    for (const convo of index.conversations) {
      lines.push(
        `- ${convo.conversationId} · forks=${convo.forkCount} · first=${convo.firstForkAt ?? "(unknown)"} · last=${convo.lastForkAt ?? "(unknown)"} · latest_mode=${convo.latestMode ?? "(unknown)"}`,
      );
    }
  }
  lines.push("", "Fork summaries:");
  if (!index.forks.length) {
    lines.push("- (none)");
  } else {
    for (const fork of index.forks) {
      const toolMix = fork.toolCounts.length
        ? fork.toolCounts.map((entry) => `${entry.name}×${entry.count}`).join(", ")
        : "(none)";
      lines.push(
        `- ${fork.createdAt} · conv=${fork.conversationId} · fork=${fork.forkId} · parent=${fork.parentId ?? "(root)"} · mode=${fork.mode ?? "(unknown)"} · action=${fork.actionSummary ?? "(none)"} · initial_user=\"${fork.initialUserPreview ?? "(none)"}\" · last_assistant=\"${fork.lastAssistantPreview ?? "(none)"}\" · user_turns=${fork.userTurns} · assistant_turns=${fork.assistantTurns} · tool_calls=${fork.toolCallCount} · tool_results=${fork.toolResultCount} · tool_mix=${toolMix} · skeleton_ref=${fork.skeletonPath}`,
      );
    }
  }
  return lines.join("\n").trim();
}

function buildDeltaText(forks: RunHistoryForkSummary[]): string {
  if (!forks.length) {
    return "No new immutable fork summaries were added since the last supervisor review on this thread.";
  }
  const lines: string[] = [
    "New fork summaries since your last supervisor review on this thread:",
  ];
  for (const fork of forks) {
    const toolMix = fork.toolCounts.length
      ? fork.toolCounts.map((entry) => `${entry.name}×${entry.count}`).join(", ")
      : "(none)";
    lines.push(
      `- ${fork.createdAt} · conv=${fork.conversationId} · fork=${fork.forkId} · mode=${fork.mode ?? "(unknown)"} · action=${fork.actionSummary ?? "(none)"} · summary=${fork.forkSummary ?? "(none)"}`,
    );
    lines.push(`  initial_user: ${fork.initialUserPreview ?? "(none)"}`);
    lines.push(`  last_assistant: ${fork.lastAssistantPreview ?? "(none)"}`);
    lines.push(`  tool_mix: ${toolMix}`);
    lines.push(`  skeleton_ref: ${fork.skeletonPath}`);
  }
  return lines.join("\n").trim();
}

export async function buildSupervisorRunHistoryContext(args: {
  workspaceRoot: string;
  currentConversationId: string;
  currentSupervisorThreadId?: string;
}): Promise<SupervisorRunHistoryContext> {
  const store = new SupervisorStore();
  const conversationIds = await loadConversationIds(args.workspaceRoot);
  const forks: RunHistoryForkSummary[] = [];
  const conversations: RunHistoryIndex["conversations"] = [];

  for (const conversationId of conversationIds) {
    let index: ConversationIndex;
    try {
      index = await store.loadIndex(args.workspaceRoot, conversationId);
    } catch {
      continue;
    }
    const sortedForks = [...index.forks].sort(
      (a, b) => parseTime(a.createdAt) - parseTime(b.createdAt) || a.id.localeCompare(b.id),
    );
    const built: RunHistoryForkSummary[] = [];
    for (const fork of sortedForks) {
      built.push(
        await loadOrBuildForkArtifact({
          workspaceRoot: args.workspaceRoot,
          conversationId,
          fork,
          store,
        }),
      );
    }
    if (built.length > 0) {
      conversations.push({
        conversationId,
        forkCount: built.length,
        firstForkAt: built[0]?.createdAt,
        lastForkAt: built.at(-1)?.createdAt,
        latestMode: built.at(-1)?.mode,
      });
      forks.push(...built);
    }
  }

  forks.sort((a, b) => parseTime(a.createdAt) - parseTime(b.createdAt) || a.key.localeCompare(b.key));
  conversations.sort((a, b) => parseTime(a.firstForkAt) - parseTime(b.firstForkAt) || a.conversationId.localeCompare(b.conversationId));

  const index: RunHistoryIndex = {
    generatedAt: new Date().toISOString(),
    conversations,
    forks,
  };
  await saveRunHistoryIndex(args.workspaceRoot, index);

  const watermarkState = await loadReviewState(args.workspaceRoot);
  const reviewKey = args.currentSupervisorThreadId || `conversation:${args.currentConversationId}`;
  const seen = new Set(watermarkState.reviewers[reviewKey]?.seenForkKeys ?? []);
  const unseenForks = forks.filter((fork) => !seen.has(fork.key));

  return {
    index,
    overviewText: buildOverviewText(index),
    deltaText: buildDeltaText(unseenForks),
    newForkCount: unseenForks.length,
    seenForkKeys: forks.map((fork) => fork.key),
  };
}

export async function persistSupervisorRunHistoryWatermark(args: {
  workspaceRoot: string;
  currentConversationId: string;
  priorSupervisorThreadId?: string;
  nextSupervisorThreadId?: string;
  seenForkKeys: string[];
}): Promise<void> {
  const state = await loadReviewState(args.workspaceRoot);
  const priorKey = args.priorSupervisorThreadId || `conversation:${args.currentConversationId}`;
  const nextKey = args.nextSupervisorThreadId || priorKey;
  if (priorKey !== nextKey) {
    delete state.reviewers[priorKey];
  }
  state.reviewers[nextKey] = {
    seenForkKeys: [...args.seenForkKeys],
    updatedAt: new Date().toISOString(),
  };
  await saveReviewState(args.workspaceRoot, state);
}
