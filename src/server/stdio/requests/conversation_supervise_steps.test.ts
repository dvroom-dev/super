import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentProvider, ProviderConfig, ProviderEvent } from "../../../providers/types.js";
import { promptContentFromText } from "../../../utils/prompt_content.js";
import { runAgentTurnWithHooks } from "./conversation_supervise_steps.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.MOCK_PROVIDER_STREAMED_ERROR_SEQUENCE;
  delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
  delete process.env.MOCK_PROVIDER_COMPACTED_THREAD_ID;
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("runAgentTurnWithHooks", () => {
  it("retries non-Claude agent turns through provider compaction on context overflow", async () => {
    const workspaceRoot = await makeTempRoot("agent-turn-retry-");
    const agentWorkspaceRoot = path.join(workspaceRoot, "agent");
    await fs.mkdir(agentWorkspaceRoot, { recursive: true });
    process.env.MOCK_PROVIDER_STREAMED_ERROR_SEQUENCE = JSON.stringify([
      "maximum context window exceeded",
      "",
    ]);
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "Recovered after provider compaction.";
    process.env.MOCK_PROVIDER_COMPACTED_THREAD_ID = "mock_agent_compacted";

    const notifications: Array<{ method: string; params?: any }> = [];
    const result = await runAgentTurnWithHooks({
      ctx: {
        store: {} as any,
        state: {} as any,
        sendNotification: (note) => void notifications.push(note as any),
        requireWorkspaceRoot: () => workspaceRoot,
      },
      workspaceRoot,
      agentWorkspaceRoot,
      docPath: path.join(agentWorkspaceRoot, "session.md"),
      conversationId: "conv_agent_retry",
      providerName: "mock",
      currentModel: "mock-model",
      sandboxMode: "workspace-write",
      permissionProfile: "workspace_no_network",
      skipGitRepoCheck: true,
      shouldUseFullPrompt: false,
      currentThreadId: "mock_agent_initial",
      customTools: undefined,
      compilePrompt: promptContentFromText("continue"),
      outputSchema: undefined,
      effectiveSupervisor: {} as any,
      budget: {
        startedAt: Date.now(),
        timeBudgetMs: 60_000,
        tokenBudgetAdjusted: 0,
        cadenceTimeMs: 0,
        cadenceTokensAdjusted: 0,
        adjustedTokensUsed: 0,
        budgetMultiplier: 1,
        cadenceAnchorAt: Date.now(),
        cadenceTokensAnchor: 0,
        timeBudgetHit: false,
        tokenBudgetHit: false,
      },
      pricing: undefined,
      sendBudgetUpdate: () => {},
      toolOutput: undefined,
      activeRuns: {},
      activeRunsByForkId: {},
      activeForkId: "fork_agent_retry",
      currentDocText: "",
      fullResyncNeeded: false,
      hooks: [],
      turn: 1,
    });

    expect(result.result.hadError).toBe(false);
    expect(result.result.errorMessage).toBeNull();
    expect(result.result.newThreadId).toBe("mock_agent_compacted");
    expect(result.nextDocText).toContain("Recovered after provider compaction.");
    expect(
      notifications.some((note) =>
        note.method === "log"
        && String(note.params?.message ?? "").includes("agent context overflow: compacted provider thread and retrying"),
      ),
    ).toBe(true);
  });

  it("retries Claude provider compaction on a fresh session with a rebuilt prompt", async () => {
    const workspaceRoot = await makeTempRoot("agent-turn-claude-compaction-");
    const agentWorkspaceRoot = path.join(workspaceRoot, "agent");
    await fs.mkdir(agentWorkspaceRoot, { recursive: true });

    const createdConfigs: ProviderConfig[] = [];
    const closed: string[] = [];
    let createCount = 0;

    const makeProvider = (name: string, events: ProviderEvent[], failure?: Error): AgentProvider => ({
      async *runStreamed() {
        for (const event of events) {
          yield event;
        }
        if (failure) throw failure;
      },
      async runOnce() {
        return { text: "", threadId: undefined, items: [] };
      },
      async close() {
        closed.push(name);
      },
    });

    const providerOne = makeProvider(
      "first",
      [
        {
          type: "provider_item",
          item: {
            provider: "claude",
            kind: "system",
            summary: "compacting",
          },
          raw: {
            type: "system",
            subtype: "status",
            status: "compacting",
          },
        },
      ],
      new Error("Claude Code process aborted by user"),
    );
    const providerTwo = makeProvider("second", [
      { type: "assistant_message", text: "Recovered after fresh Claude retry." },
      { type: "done", threadId: "claude_fresh_session" },
    ]);

    const notifications: Array<{ method: string; params?: any }> = [];
    const result = await runAgentTurnWithHooks({
      ctx: {
        store: {} as any,
        state: {} as any,
        sendNotification: (note) => void notifications.push(note as any),
        requireWorkspaceRoot: () => workspaceRoot,
      },
      workspaceRoot,
      agentWorkspaceRoot,
      docPath: path.join(agentWorkspaceRoot, "session.md"),
      conversationId: "conv_claude_retry",
      providerName: "claude",
      currentModel: "claude-opus-4-6",
      sandboxMode: "workspace-write",
      permissionProfile: "workspace_no_network",
      skipGitRepoCheck: true,
      shouldUseFullPrompt: false,
      currentThreadId: "claude_stale_session",
      customTools: undefined,
      compilePrompt: promptContentFromText("continue"),
      outputSchema: undefined,
      effectiveSupervisor: {} as any,
      budget: {
        startedAt: Date.now(),
        timeBudgetMs: 60_000,
        tokenBudgetAdjusted: 0,
        cadenceTimeMs: 0,
        cadenceTokensAdjusted: 0,
        adjustedTokensUsed: 0,
        budgetMultiplier: 1,
        cadenceAnchorAt: Date.now(),
        cadenceTokensAnchor: 0,
        timeBudgetHit: false,
        tokenBudgetHit: false,
      },
      pricing: undefined,
      sendBudgetUpdate: () => {},
      toolOutput: undefined,
      activeRuns: {},
      activeRunsByForkId: {},
      activeForkId: "fork_claude_retry",
      currentDocText: "",
      fullResyncNeeded: false,
      hooks: [],
      turn: 1,
      rebuildPromptForOverflow: async () => promptContentFromText("rebuilt prompt"),
      createProviderOverride: (config) => {
        createdConfigs.push({ ...config });
        createCount += 1;
        return createCount === 1 ? providerOne : providerTwo;
      },
    });

    expect(result.result.hadError).toBe(false);
    expect(result.result.errorMessage).toBeNull();
    expect(result.result.interruptionReason).toBeNull();
    expect(result.result.newThreadId).toBe("claude_fresh_session");
    expect(result.discardCurrentThreadId).toBe(false);
    expect(result.nextDocText).toContain("Recovered after fresh Claude retry.");
    expect(createdConfigs).toHaveLength(2);
    expect(createdConfigs[0]?.threadId).toBe("claude_stale_session");
    expect(createdConfigs[1]?.threadId).toBeUndefined();
    expect(closed).toEqual(["first", "second"]);
    expect(
      notifications.some((note) =>
        note.method === "log"
        && String(note.params?.message ?? "").includes("fresh session and retrying"),
      ),
    ).toBe(true);
  });

  it("discards the stale Claude session when a fresh-session compaction retry still fails", async () => {
    const workspaceRoot = await makeTempRoot("agent-turn-claude-compaction-fail-");
    const agentWorkspaceRoot = path.join(workspaceRoot, "agent");
    await fs.mkdir(agentWorkspaceRoot, { recursive: true });

    const createdConfigs: ProviderConfig[] = [];
    let createCount = 0;

    const makeProvider = (events: ProviderEvent[], failure?: Error): AgentProvider => ({
      async *runStreamed() {
        for (const event of events) {
          yield event;
        }
        if (failure) throw failure;
      },
      async runOnce() {
        return { text: "", threadId: undefined, items: [] };
      },
      async close() {},
    });

    const providerOne = makeProvider(
      [
        {
          type: "provider_item",
          item: {
            provider: "claude",
            kind: "system",
            summary: "compacting",
          },
          raw: {
            type: "system",
            subtype: "status",
            status: "compacting",
          },
        },
      ],
      new Error("Claude Code process aborted by user"),
    );
    const providerTwo = makeProvider([], new Error("Operation aborted"));

    const result = await runAgentTurnWithHooks({
      ctx: {
        store: {} as any,
        state: {} as any,
        sendNotification: () => {},
        requireWorkspaceRoot: () => workspaceRoot,
      },
      workspaceRoot,
      agentWorkspaceRoot,
      docPath: path.join(agentWorkspaceRoot, "session.md"),
      conversationId: "conv_claude_retry_fail",
      providerName: "claude",
      currentModel: "claude-opus-4-6",
      sandboxMode: "workspace-write",
      permissionProfile: "workspace_no_network",
      skipGitRepoCheck: true,
      shouldUseFullPrompt: false,
      currentThreadId: "claude_stale_session",
      customTools: undefined,
      compilePrompt: promptContentFromText("continue"),
      outputSchema: undefined,
      effectiveSupervisor: {} as any,
      budget: {
        startedAt: Date.now(),
        timeBudgetMs: 60_000,
        tokenBudgetAdjusted: 0,
        cadenceTimeMs: 0,
        cadenceTokensAdjusted: 0,
        adjustedTokensUsed: 0,
        budgetMultiplier: 1,
        cadenceAnchorAt: Date.now(),
        cadenceTokensAnchor: 0,
        timeBudgetHit: false,
        tokenBudgetHit: false,
      },
      pricing: undefined,
      sendBudgetUpdate: () => {},
      toolOutput: undefined,
      activeRuns: {},
      activeRunsByForkId: {},
      activeForkId: "fork_claude_retry_fail",
      currentDocText: "",
      fullResyncNeeded: false,
      hooks: [],
      turn: 1,
      rebuildPromptForOverflow: async () => promptContentFromText("rebuilt prompt"),
      createProviderOverride: (config) => {
        createdConfigs.push({ ...config });
        createCount += 1;
        return createCount === 1 ? providerOne : providerTwo;
      },
    });

    expect(result.result.hadError).toBe(true);
    expect(result.result.errorMessage).toBe("agent error: Operation aborted");
    expect(result.discardCurrentThreadId).toBe(true);
    expect(createdConfigs).toHaveLength(2);
    expect(createdConfigs[0]?.threadId).toBe("claude_stale_session");
    expect(createdConfigs[1]?.threadId).toBeUndefined();
  });
});
