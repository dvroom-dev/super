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

function strictSupervisorPayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    reason: null,
    advice: null,
    agent_rule_checks: null,
    agent_violation_checks: null,
    message: null,
    message_template: null,
    message_type: null,
    wait_for_boundary: null,
    mode: null,
    mode_payload: null,
    ...overrides,
  };
}

function makeCtx(conversationId = "conversation_test") {
  const notifications: any[] = [];
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
        return { id: args.forkId ?? `fork_${Date.now()}` };
      },
    },
  };
  return { ctx, notifications };
}

describe("conversation_supervise runtime regressions", () => {
  it("cleans active run state when supervise throws before completing a turn", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, notifications } = makeCtx();
    const docPath = path.join(workspaceRoot, "session.md");

    await expect(handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath,
      documentText: makeDoc(),
      models: ["mock-model"],
      provider: "mock",
      supervisor: { enabled: true },
    })).rejects.toThrow("supervised runs require supervisor.stop_condition");

    expect(notifications.some((n) => n.method === "conversation.run_started")).toBe(true);
    const runFinished = notifications.find((n) => n.method === "conversation.run_finished");
    expect(runFinished?.params?.status).toBe("error");
    expect(Object.keys(ctx.state.activeRuns ?? {})).toHaveLength(0);
    expect(Object.keys(ctx.state.activeRunsByForkId ?? {})).toHaveLength(0);
    expect(Object.keys(ctx.state.activeRunMeta ?? {})).toHaveLength(0);
  });

  it.serial("passes prior inline tool outputs into same-turn check_supervisor context", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const conversationId = "conversation_check_context_freshness";
    const { ctx } = makeCtx(conversationId);
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=shell",
      '{"cmd":["bash","-lc","printf INLINE_CHECK_MARKER"]}',
      "```",
      "",
      "```tool_call name=check_supervisor",
      '{"mode":"hard"}',
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "stop_and_return",
      payload: strictSupervisorPayload({ reason: "done" }),
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "explore", confidence: "low", evidence: "done" }],
        recommended_action: "continue",
      },
      reasoning: "",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc(conversationId, "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
        },
      });

      expect(result.stopReasons).toEqual(["check_supervisor"]);
      const reviewsDir = path.join(
        workspaceRoot,
        ".ai-supervisor",
        "conversations",
        conversationId,
        "reviews",
      );
      const reviewFiles = (await fs.readdir(reviewsDir)).filter((file) => file.endsWith("_prompt.txt"));
      expect(reviewFiles.length).toBeGreaterThan(0);
      const promptTexts = await Promise.all(
        reviewFiles.map((file) => fs.readFile(path.join(reviewsDir, file), "utf8")),
      );
      expect(promptTexts.some((text) => text.includes("INLINE_CHECK_MARKER"))).toBe(true);
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it.serial("keeps agent and supervisor configured system messages isolated", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const conversationId = "conversation_supervisor_system_isolation";
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "modes_enabled: false",
        "agent:",
        "  system_message:",
        "    operation: append",
        "    parts:",
        "      - literal: AGENT_SYSTEM_SENTINEL",
        "  user_message:",
        "    operation: append",
        "    parts:",
        "      - literal: run one turn",
        "  rules:",
        "    operation: append",
        "    requirements: []",
        "    violations: []",
        "supervisor:",
        "  system_message:",
        "    operation: append",
        "    parts:",
        "      - literal: SUPERVISOR_SYSTEM_SENTINEL",
        "  instructions:",
        "    operation: append",
        "    values: []",
        "  stop_condition: task complete",
      ].join("\n"),
      "utf8",
    );
    const { ctx } = makeCtx(conversationId);
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "stop_and_return",
      payload: strictSupervisorPayload({ reason: "done" }),
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "default", confidence: "high", evidence: "done" }],
        recommended_action: "continue",
      },
      reasoning: "",
      agent_model: null,
    });
    try {
      await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc(conversationId, "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
      });

      const reviewsDir = path.join(
        workspaceRoot,
        ".ai-supervisor",
        "conversations",
        conversationId,
        "reviews",
      );
      const reviewFiles = (await fs.readdir(reviewsDir)).filter((file) => file.endsWith("_prompt.txt"));
      expect(reviewFiles.length).toBeGreaterThan(0);
      const promptTexts = await Promise.all(
        reviewFiles.map((file) => fs.readFile(path.join(reviewsDir, file), "utf8")),
      );
      expect(promptTexts.some((text) => text.includes("SUPERVISOR_SYSTEM_SENTINEL"))).toBe(true);
      expect(promptTexts.some((text) => text.includes("AGENT_SYSTEM_SENTINEL"))).toBe(false);
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });
});
