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

async function writeModeConfig(workspaceRoot: string): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
    [
      "supervisor:",
      "  stop_condition: task complete",
      "modes:",
      "  theory:",
      "    user_message:",
      "      operation: append",
      "      parts:",
      "        - literal: theory seed",
      "    agent_rules:",
      "      operation: replace",
      "      requirements:",
      "        - theory requirement marker",
      "      violations:",
      "        - theory violation marker",
      "  explore:",
      "    user_message:",
      "      operation: append",
      "      parts:",
      "        - template: \"explore seed {{supervisor.seed}}\"",
      "    agent_rules:",
      "      operation: replace",
      "      requirements:",
      "        - explore requirement marker",
      "      violations:",
      "        - explore violation marker",
      "mode_state_machine:",
      "  initial_mode: theory",
      "  transitions:",
      "    theory: [theory, explore]",
      "    explore: [explore]",
    ].join("\n"),
    "utf8",
  );
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

afterEach(async () => {
  delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
  delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("mode fork agent-rules isolation", () => {
  it.serial("uses target-mode rules when supervisor review forks a new conversation", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-mode-fork-");
    await writeModeConfig(workspaceRoot);
    const { ctx, createForkCalls } = makeCtx("conversation_mode_fork_review");
    const reviewOverrideJson = JSON.stringify({
      decision: "fork_new_conversation",
      payload: strictSupervisorPayload({
        mode: "explore",
        mode_payload: {
          theory: null,
          explore: { seed: "from-supervisor-review" },
        },
      }),
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "explore", confidence: "high", evidence: "mode transition requested" }],
        recommended_action: "fork_new_conversation",
      },
      reasoning: "",
      agent_model: null,
    });

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_mode_fork_review", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      supervisorModel: "mock-supervisor",
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
        reviewOverrideJson,
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
    const forkDoc = String(createForkCalls[1].documentText ?? "");
    expect(forkDoc).toContain("mode: explore");
    expect(forkDoc).toContain("explore requirement marker");
    expect(forkDoc).toContain("explore violation marker");
    expect(forkDoc).not.toContain("theory requirement marker");
    expect(forkDoc).not.toContain("theory violation marker");
    expect(createForkCalls[1].agentRules).toEqual(["explore requirement marker"]);
  });

  it.serial("uses target-mode rules when check_supervisor forks a new conversation", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-mode-fork-");
    await writeModeConfig(workspaceRoot);
    const { ctx, createForkCalls } = makeCtx("conversation_mode_fork_tool");
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=check_supervisor",
      "{\"mode\":\"hard\"}",
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "fork_new_conversation",
      payload: strictSupervisorPayload({
        mode: "explore",
        mode_payload: {
          theory: null,
          explore: { seed: "from-check-supervisor" },
        },
      }),
      transition_payload: null,
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "explore", confidence: "high", evidence: "check_supervisor requested fork" }],
        recommended_action: "fork_new_conversation",
      },
      reasoning: "",
      agent_model: null,
    });

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_mode_fork_tool", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      supervisorModel: "mock-supervisor",
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
    const forkDoc = String(createForkCalls[1].documentText ?? "");
    expect(forkDoc).toContain("mode: explore");
    expect(forkDoc).toContain("explore requirement marker");
    expect(forkDoc).toContain("explore violation marker");
    expect(forkDoc).not.toContain("theory requirement marker");
    expect(forkDoc).not.toContain("theory violation marker");
    expect(createForkCalls[1].agentRules).toEqual(["explore requirement marker"]);
  });
});
