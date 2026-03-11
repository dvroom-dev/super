import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleConversationSupervise } from "./conversation_supervise.js";
import { inferSwitchModeRequestFromAssistantText } from "./conversation_supervise_switch_mode.js";

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

async function writeModeConfig(workspaceRoot: string, transitions = "    theory: [theory, explore]\n    explore: [explore]"): Promise<void> {
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
      "  explore:",
      "    user_message:",
      "      operation: append",
      "      parts:",
      "        - template: \"explore seed {{supervisor.seed}}\"",
      "mode_state_machine:",
      "  initial_mode: theory",
      "  transitions:",
      ...transitions.split("\n"),
    ].join("\n"),
    "utf8",
  );
}

function makeCtx(conversationId = "conversation_test") {
  const notifications: any[] = [];
  const createForkCalls: any[] = [];
  const forks = new Map<string, { id: string; documentText: string; providerThreadId?: string; supervisorThreadId?: string }>();
  forks.set("fork_doc", {
    id: "fork_doc",
    documentText: makeDoc(conversationId, "fork_doc"),
  });
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
      async loadFork(_workspaceRoot: string, _conversationId: string, forkId: string) {
        const fork = forks.get(forkId);
        if (!fork) throw new Error("fork not found");
        return fork;
      },
      isHistoryEdited() {
        return true;
      },
      async createFork(args: any) {
        createForkCalls.push(args);
        const forkId = args.forkId ?? `fork_${createForkCalls.length}`;
        forks.set(forkId, {
          id: forkId,
          documentText: String(args.documentText ?? ""),
          providerThreadId: args.providerThreadId,
          supervisorThreadId: args.supervisorThreadId,
        });
        return { id: forkId };
      },
    },
  };
  return { ctx, notifications, createForkCalls };
}

afterEach(async () => {
  delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
  delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
  delete process.env.MOCK_PROVIDER_RUNONCE_TEXT_SEQUENCE;
  delete process.env.MOCK_PROVIDER_RUNONCE_EMPTY;
  delete process.env.MOCK_PROVIDER_RUNONCE_ERROR;
  delete process.env.SWITCH_SEED;
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function mockSupervisorDecision(decision: string, payload: Record<string, unknown>, modeAssessment?: Record<string, unknown>): string {
  return JSON.stringify({
    decision,
    payload: {
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
      ...payload,
    },
    mode_assessment: modeAssessment ?? {
      current_mode_stop_satisfied: false,
      candidate_modes_ranked: [],
      recommended_action: "continue",
    },
    reasoning: null,
    agent_model: null,
  });
}

describe("agent switch_mode inline tool", () => {
  it("infers switch_mode requests from visible assistant handoff text", () => {
    const request = inferSwitchModeRequestFromAssistantText([
      "Coverage passes.",
      "",
      "I should switch to `explore_and_solve` mode.",
      "",
      "**Handoff to explore_and_solve:** Probe ACTION1 to see if the small_marker moves.",
      "",
      "I'm ready to switch to `explore_and_solve` mode with a concrete probe plan.",
    ].join("\n"));

    expect(request).toEqual({
      targetMode: "explore_and_solve",
      reason: "Probe ACTION1 to see if the small_marker moves.",
      modePayload: {},
      terminal: true,
    });
  });

  it.serial("switches mode in no-supervision runs", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-mode-");
    await writeModeConfig(workspaceRoot);
    const { ctx, createForkCalls } = makeCtx("conversation_switch_mode_success");
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"explore","reason":"need exploratory lane","mode_payload":{"seed":"from-agent"}}',
      "```",
    ].join("\n");

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_switch_mode_success", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls).toHaveLength(2);
    expect(createForkCalls[1].actionSummary).toBe("agent:switch_mode theory->explore");
    expect(String(createForkCalls[1].documentText ?? "")).toContain("mode: explore");
    expect(String(createForkCalls[1].documentText ?? "")).toContain("explore seed from-agent");
  });

  it.serial("rejects switch_mode target outside allowed transitions", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-mode-");
    await writeModeConfig(workspaceRoot, "    theory: [theory]\n    explore: [explore]");
    const { ctx, notifications, createForkCalls } = makeCtx("conversation_switch_mode_bad_transition");
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"explore","reason":"try transition","mode_payload":{"seed":"from-agent"}}',
      "```",
    ].join("\n");

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_switch_mode_bad_transition", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls).toHaveLength(1);
    const appendEvents = notifications.filter((note) => note.method === "conversation.append");
    const markdown = appendEvents.map((note) => String(note.params?.markdown ?? "")).join("\n");
    expect(markdown).toContain("switch_mode target_mode 'explore' is not an allowed transition");
  });

  it.serial("validates switch_mode payload fields for target mode", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-mode-");
    await writeModeConfig(workspaceRoot);
    const { ctx, notifications, createForkCalls } = makeCtx("conversation_switch_mode_bad_payload");
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"explore","reason":"missing payload field","mode_payload":{}}',
      "```",
    ].join("\n");

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_switch_mode_bad_payload", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls).toHaveLength(1);
    const appendEvents = notifications.filter((note) => note.method === "conversation.append");
    const markdown = appendEvents.map((note) => String(note.params?.markdown ?? "")).join("\n");
    expect(markdown).toContain("switch_mode.mode_payload.seed is required");
  });

  it.serial("treats successful switch_mode as terminal for remaining inline tool calls", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-mode-");
    await writeModeConfig(workspaceRoot);
    const { ctx, createForkCalls } = makeCtx("conversation_switch_mode_terminal");
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"explore","reason":"switch now","mode_payload":{"seed":"from-agent"}}',
      "```",
      "",
      "```tool_call name=write_file",
      '{"path":"should-not-exist.txt","content":"unexpected"}',
      "```",
    ].join("\n");

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_switch_mode_terminal", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls).toHaveLength(2);
    await expect(fs.stat(path.join(workspaceRoot, "should-not-exist.txt"))).rejects.toThrow();
  });

  it.serial("routes switch_mode through supervisor and can replace tool call with a user message", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-mode-");
    await writeModeConfig(workspaceRoot);
    const { ctx, notifications, createForkCalls } = makeCtx("conversation_switch_mode_supervisor_replace");
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"explore","reason":"switch now","mode_payload":{"seed":"from-agent"}}',
      "```",
      "",
      "```tool_call name=write_file",
      '{"path":"should-not-exist.txt","content":"unexpected"}',
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = mockSupervisorDecision(
      "append_message_and_continue",
      {
        message: "Do not switch modes yet. Continue in the current mode.",
        message_template: "replace_switch_mode_with_guidance",
      },
    );

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_switch_mode_supervisor_replace", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      disableSupervision: false,
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls).toHaveLength(1);
    const replaceEvents = notifications.filter((note) => note.method === "conversation.replace");
    const replacedDocument = String(replaceEvents[replaceEvents.length - 1]?.params?.documentText ?? "");
    expect(replacedDocument).toContain("```chat role=user");
    expect(replacedDocument).toContain("Do not switch modes yet. Continue in the current mode.");
    expect(replacedDocument).not.toContain("```tool_call name=switch_mode");
    expect(replacedDocument).not.toContain("```tool_call name=write_file");
    await expect(fs.stat(path.join(workspaceRoot, "should-not-exist.txt"))).rejects.toThrow();
  });

  it.serial("lets supervisor choose final fork target for switch_mode requests", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-mode-");
    await writeModeConfig(workspaceRoot);
    const { ctx, createForkCalls } = makeCtx("conversation_switch_mode_supervisor_fork");
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"theory","reason":"agent suggestion","mode_payload":{}}',
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = mockSupervisorDecision(
      "fork_new_conversation",
      {
        mode: "explore",
        mode_payload: {
          theory: null,
          explore: { seed: "from-supervisor" },
        },
      },
      {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "explore", confidence: "high", evidence: "test" }],
        recommended_action: "fork_new_conversation",
      },
    );

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_switch_mode_supervisor_fork", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      disableSupervision: false,
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls).toHaveLength(3);
    const finalForkDoc = String(createForkCalls[createForkCalls.length - 1].documentText ?? "");
    expect(finalForkDoc).toContain("mode: explore");
    expect(finalForkDoc).toContain("explore seed from-supervisor");
  });

  it.serial("preserves the full agent message in switch_mode handoff branches", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-mode-");
    await writeModeConfig(workspaceRoot);
    const { ctx, createForkCalls } = makeCtx("conversation_switch_mode_handoff");
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"explore","reason":"need one completion probe","mode_payload":{"seed":"from-agent"}}',
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = mockSupervisorDecision(
      "fork_new_conversation",
      {
        mode: "explore",
        message: "Run one minimal completion probe, then report whether completion triggers.",
        message_type: "user",
        mode_payload: {
          theory: null,
          explore: { seed: "from-supervisor" },
        },
      },
      {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [{ mode: "explore", confidence: "high", evidence: "test" }],
        recommended_action: "fork_new_conversation",
      },
    );

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_switch_mode_handoff", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      disableSupervision: false,
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls).toHaveLength(3);
    const handoffDoc = String(createForkCalls[createForkCalls.length - 1].documentText ?? "");
    expect(handoffDoc).toContain("<mode-handoff source=\"agent_switch_mode_request\">");
    expect(handoffDoc).toContain("<agent-message>");
    expect(handoffDoc).toContain("```tool_call name=switch_mode");
    expect(handoffDoc).toContain("\"reason\":\"need one completion probe\"");
  });

  it.serial("re-renders mode template env vars on each switch-mode fork", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-mode-");
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
        "  explore:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore seed ${env.SWITCH_SEED}",
        "mode_state_machine:",
        "  initial_mode: theory",
        "  transitions:",
        "    theory: [explore]",
        "    explore: [explore]",
      ].join("\n"),
      "utf8",
    );
    const { ctx, createForkCalls } = makeCtx("conversation_switch_mode_env_refresh");
    let envSwitched = false;
    const originalSendNotification = ctx.sendNotification.bind(ctx);
    ctx.sendNotification = (note: any) => {
      originalSendNotification(note);
      if (!envSwitched && note?.method === "conversation.replace") {
        envSwitched = true;
        process.env.SWITCH_SEED = "seed_two";
      }
    };
    process.env.SWITCH_SEED = "seed_one";
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"explore","reason":"keep switching","mode_payload":{}}',
      "```",
    ].join("\n");

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_switch_mode_env_refresh", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      cycleLimit: 2,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls).toHaveLength(3);
    expect(String(createForkCalls[1]?.documentText ?? "")).toContain("explore seed seed_one");
    expect(String(createForkCalls[2]?.documentText ?? "")).toContain("explore seed seed_two");
  });
});
