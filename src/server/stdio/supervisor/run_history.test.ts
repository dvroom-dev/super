import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupervisorStore } from "../../../store/store.js";
import {
  buildSupervisorRunHistoryContext,
  persistSupervisorRunHistoryWatermark,
} from "./run_history.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeDoc(args: {
  conversationId: string;
  forkId: string;
  mode: string;
  user: string;
  assistant: string;
  toolName?: string;
}): string {
  return [
    "---",
    `conversation_id: ${args.conversationId}`,
    `fork_id: ${args.forkId}`,
    "---",
    "",
    `mode: ${args.mode}`,
    "",
    "```chat role=user",
    args.user,
    "```",
    "",
    "```chat role=assistant",
    args.assistant,
    "```",
    "",
    args.toolName
      ? ["```tool_call name=" + args.toolName, "{}", "```", "", "```tool_result", "ok", "```", ""].join("\n")
      : "",
  ].join("\n");
}

describe("buildSupervisorRunHistoryContext", () => {
  it("builds per-fork skeleton artifacts and incremental delta by supervisor thread", async () => {
    const workspaceRoot = await makeTempRoot("run-history-");
    const store = new SupervisorStore();
    const conversationId = "conv_hist";

    await store.createFork({
      workspaceRoot,
      conversationId,
      forkId: "fork_a",
      documentText: makeDoc({
        conversationId,
        forkId: "fork_a",
        mode: "explore_game",
        user: "probe the new mechanic",
        assistant: "I will inspect the initial files first.",
        toolName: "Read",
      }),
      agentRules: [],
      actionSummary: "supervise:start",
    });
    await store.createFork({
      workspaceRoot,
      conversationId,
      parentId: "fork_a",
      forkId: "fork_b",
      documentText: makeDoc({
        conversationId,
        forkId: "fork_b",
        mode: "code_model",
        user: "repair the model",
        assistant: "The compare mismatch points at step 3.",
        toolName: "Edit",
      }),
      agentRules: [],
      actionSummary: "agent:turn",
    });

    const first = await buildSupervisorRunHistoryContext({
      workspaceRoot,
      currentConversationId: conversationId,
      currentSupervisorThreadId: "super_thread_1",
    });

    expect(first.index.forks).toHaveLength(2);
    expect(first.newForkCount).toBe(2);
    expect(first.priorityText).toContain("Current conversation: conv_hist");
    expect(first.priorityText).toContain("probe the new mechanic");
    expect(first.priorityText).toContain("The compare mismatch points at step 3.");
    expect(first.overviewText).toContain("Run-wide conversation index across all agent conversations for this run.");

    const skeletonPath = path.join(workspaceRoot, first.index.forks[0].skeletonPath);
    const skeletonText = await fs.readFile(skeletonPath, "utf8");
    expect(skeletonText).toContain("```chat role=user");
    expect(skeletonText).toContain("line: ok");

    await persistSupervisorRunHistoryWatermark({
      workspaceRoot,
      currentConversationId: conversationId,
      nextSupervisorThreadId: "super_thread_1",
      seenForkKeys: first.seenForkKeys,
    });

    await store.createFork({
      workspaceRoot,
      conversationId,
      parentId: "fork_b",
      forkId: "fork_c",
      documentText: makeDoc({
        conversationId,
        forkId: "fork_c",
        mode: "explore_game",
        user: "probe the completion condition",
        assistant: "Next I will test the completion trigger directly.",
        toolName: "Bash",
      }),
      agentRules: [],
      actionSummary: "resume_mode_head",
    });

    const second = await buildSupervisorRunHistoryContext({
      workspaceRoot,
      currentConversationId: conversationId,
      currentSupervisorThreadId: "super_thread_1",
    });

    expect(second.index.forks).toHaveLength(3);
    expect(second.newForkCount).toBe(1);
    expect(second.deltaText).toContain("fork_c");
    expect(second.deltaText).toContain("probe the completion condition");

    const historyIndex = JSON.parse(
      await fs.readFile(
        path.join(workspaceRoot, ".ai-supervisor", "supervisor", "run_history", "index.json"),
        "utf8",
      ),
    ) as { forks?: unknown[] };
    expect(Array.isArray(historyIndex.forks)).toBe(true);
    expect(historyIndex.forks).toHaveLength(3);
  });
});
