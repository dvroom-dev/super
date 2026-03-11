import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleConversationSupervise } from "./conversation_supervise.js";

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

function makeDoc(conversationId = "conversation_test", forkId = "fork_doc"): string {
  return [
    "---",
    `conversation_id: ${conversationId}`,
    `fork_id: ${forkId}`,
    "---",
    "",
    "```chat role=user",
    "Please run one turn.",
    "```",
  ].join("\n");
}

function makeCtx(conversationId = "conversation_test") {
  const notifications: any[] = [];
  const createForkCalls: any[] = [];
  const ctx: any = {
    state: {},
    sendNotification(note: any) {
      notifications.push(note);
    },
    requireWorkspaceRoot(params: any) {
      return String(params.workspaceRoot ?? "");
    },
    store: {
      async conversationIdFromDocument() {
        return conversationId;
      },
      async loadIndex() {
        return { conversationId, headId: undefined, headIds: [], forks: [] };
      },
      forkIdFromDocument() {
        return undefined;
      },
      async loadFork() {
        throw new Error("fork not found");
      },
      isHistoryEdited() {
        return true;
      },
      async createFork(args: any) {
        createForkCalls.push(args);
        return { id: args.forkId ?? `fork_${createForkCalls.length}` };
      },
    },
  };
  return { ctx, notifications, createForkCalls };
}

function baseConfig(extra: string[]): string {
  return [
    "modes_enabled: false",
    "agent:",
    "  system_message:",
    "    operation: append",
    "    parts:",
    "      - literal: system",
    "  user_message:",
    "    operation: append",
    "    parts:",
    "      - literal: user",
    "  rules:",
    "    operation: append",
    "    requirements: []",
    "    violations: []",
    "supervisor:",
    "  instructions:",
    "    operation: append",
    "    values: []",
    ...extra,
  ].join("\n");
}

describe("conversation_supervise hooks + cycle limit", () => {
  it("stops when cycleLimit is reached during resume loops", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-hooks-");
    const { ctx, notifications, createForkCalls } = makeCtx();
    const reviewOverrideJson = JSON.stringify({
      decision: "append_message_and_continue",
      append_message_and_continue: {
        message: "continue",
      },
      mode_assessment: {
        current_mode_stop_satisfied: false,
        candidate_modes_ranked: [{ mode: "default", confidence: "medium", evidence: "continue running" }],
        recommended_action: "continue",
      },
      reasoning: "",
      agent_model: null,
    });
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    let result: Awaited<ReturnType<typeof handleConversationSupervise>> | null = null;
    try {
      result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc(),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 2,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          cadenceTimeMs: 1,
          reviewOverrideJson,
        },
      });
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }

    expect(result).toBeTruthy();
    expect(result?.stopReasons).toEqual(["cycle_limit"]);
    expect(result?.stopDetails).toEqual(["cycle limit reached (2)"]);
    expect(createForkCalls).toHaveLength(3);
    expect(notifications.some((n) => n.method === "conversation.status" && String(n.params?.message).includes("cycle limit reached (2)"))).toBe(true);
  });

  it("applies supervisor hooks and can disable them with disableHooks", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-hooks-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      baseConfig([
        "  stop_condition: task complete",
        "hooks:",
        "  - trigger: supervisor_turn_complete",
        "    action: printf 'SUPERVISOR_HOOK_OUTPUT'",
      ]),
      "utf8",
    );
    const reviewOverrideJson = JSON.stringify({
      decision: "stop_and_return",
      stop_and_return: {
        reason: "done",
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "default", confidence: "low", evidence: "task complete" }],
        recommended_action: "continue",
      },
      reasoning: "",
      agent_model: null,
    });

    const first = makeCtx("conversation_hooks_a");
    await handleConversationSupervise(first.ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session_a.md"),
      documentText: makeDoc("conversation_hooks_a", "fork_a"),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      supervisorModel: "mock-supervisor",
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
        returnControlPattern: "Mock response for model",
        reviewOverrideJson,
      },
    });
    expect(first.createForkCalls).toHaveLength(2);
    expect(first.createForkCalls[1].documentText).toContain("SUPERVISOR_HOOK_OUTPUT");

    const second = makeCtx("conversation_hooks_b");
    await handleConversationSupervise(second.ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session_b.md"),
      documentText: makeDoc("conversation_hooks_b", "fork_b"),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      supervisorModel: "mock-supervisor",
      disableHooks: true,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
        returnControlPattern: "Mock response for model",
        reviewOverrideJson,
      },
    });
    expect(second.createForkCalls).toHaveLength(2);
    expect(second.createForkCalls[1].documentText).not.toContain("SUPERVISOR_HOOK_OUTPUT");
  });
});
