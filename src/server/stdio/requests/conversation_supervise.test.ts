import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleConversationSupervise, shouldUseFullPromptForSupervise } from "./conversation_supervise.js";
type TestCtxBuild = {
  conversationId?: string;
  index?: any;
  docForkId?: string;
  baseFork?: any;
  forksById?: Record<string, any>;
  historyEdited?: boolean;
};
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

function makeCtx(options: TestCtxBuild = {}) {
  const notifications: any[] = [];
  const createForkCalls: any[] = [];
  const loadForkCalls: any[] = [];
  const conversationId = options.conversationId ?? "conversation_test";
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
        return options.index ?? { conversationId, headId: undefined, headIds: [], forks: [] };
      },
      forkIdFromDocument() {
        return options.docForkId;
      },
      async loadFork(_workspaceRoot: string, _conversationId: string, forkId: string) {
        loadForkCalls.push(forkId);
        if (options.forksById) {
          const fork = options.forksById[forkId];
          if (!fork) throw new Error("fork not found");
          return fork;
        }
        if (!options.baseFork) throw new Error("fork not found");
        return options.baseFork;
      },
      isHistoryEdited() {
        return options.historyEdited ?? true;
      },
      async createFork(args: any) {
        createForkCalls.push(args);
        return { id: args.forkId ?? `fork_${createForkCalls.length}` };
      },
    },
  };
  return { ctx, notifications, createForkCalls, loadForkCalls };
}

describe("shouldUseFullPromptForSupervise", () => {
  it("requires full prompt when resync is requested", () => {
    expect(shouldUseFullPromptForSupervise(true, "thread_123")).toBe(true);
  });

  it("requires full prompt when no thread is available", () => {
    expect(shouldUseFullPromptForSupervise(false, undefined)).toBe(true);
  });

  it("allows incremental prompt when thread is available and resync is not needed", () => {
    expect(shouldUseFullPromptForSupervise(false, "thread_123")).toBe(false);
  });
});

describe("handleConversationSupervise", () => {
  it.serial("applies inferred switch_mode fallback from visible assistant text in live turns", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
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
        "  explore_and_solve:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore seed",
        "mode_state_machine:",
        "  initial_mode: theory",
        "  transitions:",
        "    theory: [theory, explore_and_solve]",
        "    explore_and_solve: [explore_and_solve]",
      ].join("\n"),
      "utf8",
    );
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "Coverage passes fresh in this turn.",
      "Based on my analysis, I'm ready to switch to `explore_and_solve`.",
      "**Switch target**: `explore_and_solve`",
      "**Reason**: component coverage passes and one concrete level-1 solution theory is ready to test.",
      "**Handoff (solution theory to test)**:",
      "Probe ACTION2 once, then move to the target marker through the bottom corridor.",
    ].join("\n");

    const { ctx, createForkCalls } = makeCtx({ conversationId: "conversation_inferred_switch", docForkId: "fork_doc" });
    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_inferred_switch", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      cycleLimit: 1,
      supervisor: { enabled: true },
    });

    expect(result.stopReasons).toContain("cycle_limit");
    expect(createForkCalls).toHaveLength(2);
    expect(createForkCalls[1].actionSummary).toBe("agent:switch_mode theory->explore_and_solve");
    expect(String(createForkCalls[1].documentText ?? "")).toContain("mode: explore_and_solve");
  });

  it("runs a no-supervision turn and persists a post-turn fork", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, notifications, createForkCalls } = makeCtx({ docForkId: "fork_doc" });
    const doc = makeDoc();
    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: doc,
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      supervisor: { enabled: true },
    });

    expect(result.mode).toBe("supervise");
    expect(result.stopReasons).toContain("agent_stop");
    expect(createForkCalls).toHaveLength(2);
    expect(createForkCalls[0].forkId).toBe("fork_doc");
    expect(String(createForkCalls[0].documentText ?? "")).toBe(doc);
    expect(createForkCalls[0].actionSummary).toBe("supervise:start");
    expect(createForkCalls[1].actionSummary).toBe("agent:turn");
    expect(createForkCalls[1].providerThreadId).toBeTruthy();
    expect(notifications.some((n) => n.method === "conversation.run_started")).toBe(true);
    expect(notifications.some((n) => n.method === "conversation.run_finished")).toBe(true);
    expect(notifications.some((n) => n.method === "conversation.supervisor_run_start")).toBe(false);
    expect(notifications.some((n) => n.method === "conversation.supervisor_run_end")).toBe(false);
  });

  it("reuses an existing thread and switches to incremental prompts when history is unchanged", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const baseDoc = makeDoc("conversation_reuse", "fork_head");
    const { ctx, notifications, createForkCalls, loadForkCalls } = makeCtx({
      conversationId: "conversation_reuse",
      index: { conversationId: "conversation_reuse", headId: "fork_head", headIds: ["fork_head"], forks: [{ id: "fork_head" }] },
      docForkId: "fork_head",
      baseFork: { id: "fork_head", documentText: baseDoc, providerThreadId: "thread_prev", supervisorThreadId: "super_thread_prev" },
      historyEdited: false,
    });
    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: baseDoc,
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      supervisor: { enabled: true },
    });

    expect(result.stopReasons).toContain("agent_stop");
    expect(loadForkCalls).toContain("fork_head");
    expect(createForkCalls[0].providerThreadId).toBe("thread_prev");
    expect(createForkCalls[0].supervisorThreadId).toBe("super_thread_prev");
    expect(createForkCalls[1].supervisorThreadId).toBe("super_thread_prev");
    const contextStats = notifications.find((n) => n.method === "conversation.context_stats");
    expect(contextStats?.params?.fullPrompt).toBe(false);
  });

  it("continues turn numbering across repeated supervise invocations", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const doc = makeDoc("conversation_turns", "fork_doc");

    const first = makeCtx({
      conversationId: "conversation_turns",
      docForkId: "fork_doc",
      historyEdited: false,
    });
    await handleConversationSupervise(first.ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: doc,
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      supervisor: { enabled: true },
    });

    const second = makeCtx({
      conversationId: "conversation_turns",
      index: { conversationId: "conversation_turns", headId: "fork_head", headIds: ["fork_head"], forks: [{ id: "fork_head" }] },
      docForkId: "fork_head",
      baseFork: { id: "fork_head", documentText: doc, providerThreadId: "thread_prev", supervisorThreadId: "super_thread_prev" },
      historyEdited: false,
    });
    await handleConversationSupervise(second.ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: doc,
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      supervisor: { enabled: true },
    });

    const telemetryPath = path.join(
      workspaceRoot,
      ".ai-supervisor",
      "conversations",
      "conversation_turns",
      "telemetry",
      "turns.ndjson",
    );
    const lines = (await fs.readFile(telemetryPath, "utf8")).trim().split("\n").filter(Boolean);
    const turns = lines.map((line) => JSON.parse(line).turn);
    expect(turns).toEqual([1, 2]);
  });

  it("applies cycleLimit per invocation rather than global telemetry count", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const doc = makeDoc("conversation_cycle_limit", "fork_doc");

    const first = makeCtx({
      conversationId: "conversation_cycle_limit",
      docForkId: "fork_doc",
      historyEdited: false,
    });
    const firstResult = await handleConversationSupervise(first.ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: doc,
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      supervisor: { enabled: true },
      cycleLimit: 1,
    });
    expect(firstResult.stopReasons).toContain("agent_stop");

    const second = makeCtx({
      conversationId: "conversation_cycle_limit",
      index: { conversationId: "conversation_cycle_limit", headId: "fork_head", headIds: ["fork_head"], forks: [{ id: "fork_head" }] },
      docForkId: "fork_head",
      baseFork: { id: "fork_head", documentText: doc, providerThreadId: "thread_prev", supervisorThreadId: "super_thread_prev" },
      historyEdited: false,
    });
    const secondResult = await handleConversationSupervise(second.ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: doc,
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      supervisor: { enabled: true },
      cycleLimit: 1,
    });
    expect(secondResult.stopReasons).toContain("agent_stop");
    expect(secondResult.stopReasons).not.toContain("cycle_limit");
  });

  it("falls back to index head fork when explicit base fork is missing", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const baseDoc = makeDoc("conversation_fallback", "fork_head");
    const { ctx, notifications, createForkCalls, loadForkCalls } = makeCtx({
      conversationId: "conversation_fallback",
      index: { conversationId: "conversation_fallback", headId: "fork_head", headIds: ["fork_head"], forks: [{ id: "fork_head" }] },
      docForkId: "fork_head",
      forksById: {
        fork_head: { id: "fork_head", documentText: baseDoc, providerThreadId: "thread_from_head", supervisorThreadId: "super_thread_head" },
      },
      historyEdited: false,
    });
    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: baseDoc,
      baseForkId: "fork_missing",
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      supervisor: { enabled: true },
    });

    expect(result.stopReasons).toContain("agent_stop");
    expect(loadForkCalls).toEqual(["fork_missing", "fork_head"]);
    expect(createForkCalls[0].providerThreadId).toBe("thread_from_head");
    expect(createForkCalls[0].supervisorThreadId).toBe("super_thread_head");
    const warningLog = notifications.find((n) => n.method === "log" && String(n.params?.message ?? "").includes("baseForkId not found"));
    expect(warningLog).toBeTruthy();
  });

  it.serial("applies check_supervisor stop_and_return decisions from inline tool calls", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, createForkCalls } = makeCtx({ conversationId: "conversation_check_stop" });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=check_supervisor",
      '{"mode":"hard"}',
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "stop_and_return",
      payload: strictSupervisorPayload({ reason: "manual halt" }),
      mode_assessment: { current_mode_stop_satisfied: true, candidate_modes_ranked: [{ mode: "explore", confidence: "low", evidence: "manual halt" }], recommended_action: "continue" },
      reasoning: "",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_check_stop", "fork_doc"),
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
      expect(createForkCalls).toHaveLength(2);
      expect(createForkCalls[1].documentText).toContain("```tool_result");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it.serial("applies check_supervisor fork_new_conversation decisions from inline tool calls", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "supervisor:",
        "  stop_condition: task complete",
        "modes:",
        "  default:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - template: \"Mode seed: {{supervisor.seed}}\"",
        "mode_state_machine:",
        "  initial_mode: default",
      ].join("\n"),
      "utf8",
    );
    const { ctx, createForkCalls } = makeCtx({ conversationId: "conversation_check_fork" });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=check_supervisor",
      '{"mode":"hard"}',
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "fork_new_conversation",
      payload: strictSupervisorPayload({
        mode: "default",
        mode_payload: {
          default: { seed: "Switch to default execution lane." },
        },
      }),
      mode_assessment: { current_mode_stop_satisfied: true, candidate_modes_ranked: [{ mode: "default", confidence: "high", evidence: "switch lanes" }], recommended_action: "fork_new_conversation" },
      reasoning: "",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_check_fork", "fork_doc"),
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
      expect(createForkCalls[1].documentText).toContain("mode: default");
      expect(createForkCalls[1].documentText).toContain("Mode seed: Switch to default execution lane.");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it.serial("runs tool interception on matching invocation and can replace the tool call with guidance", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, notifications } = makeCtx({ conversationId: "conversation_tool_intercept_invocation" });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=shell",
      "{\"cmd\":[\"bash\",\"-lc\",\"echo SHOULD_NOT_RUN\"]}",
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "append_message_and_continue",
      payload: strictSupervisorPayload({
        message: "Do not run this command. Continue with a safer approach.",
        message_template: "replace_tool_call_with_guidance",
      }),
      mode_assessment: null,
      reasoning: "",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_tool_intercept_invocation", "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          toolInterception: {
            rules: [
              {
                when: "invocation",
                tool: "bash",
                matchType: "contains",
                pattern: "SHOULD_NOT_RUN",
                caseSensitive: true,
              },
            ],
          },
        },
      });
      expect(result.stopReasons).toEqual(["cycle_limit"]);
      const replaceEvents = notifications.filter((note) => note.method === "conversation.replace");
      expect(replaceEvents.length).toBeGreaterThan(0);
      const replacedDoc = String(replaceEvents[replaceEvents.length - 1]?.params?.documentText ?? "");
      expect(replacedDoc).not.toContain("```tool_call name=shell");
      expect(replacedDoc).not.toContain("SHOULD_NOT_RUN");
      expect(replacedDoc).toContain("Do not run this command. Continue with a safer approach.");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it.serial("runs tool interception on matching response and appends supervisor guidance", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, notifications } = makeCtx({ conversationId: "conversation_tool_intercept_response" });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=shell",
      "{\"cmd\":[\"bash\",\"-lc\",\"printf RESPONSE_INTERCEPT_MARKER\"]}",
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "append_message_and_continue",
      payload: strictSupervisorPayload({
        message: "Observed risky output. Continue with mitigation steps.",
        message_template: "tool_intercept_guidance",
      }),
      mode_assessment: null,
      reasoning: "",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_tool_intercept_response", "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          toolInterception: {
            rules: [
              {
                when: "response",
                tool: "bash",
                matchType: "contains",
                pattern: "RESPONSE_INTERCEPT_MARKER",
                caseSensitive: true,
              },
            ],
          },
        },
      });
      expect(result.stopReasons).toEqual(["cycle_limit"]);
      const appended = notifications
        .filter((note) => note.method === "conversation.append")
        .map((note) => String(note.params?.markdown ?? ""))
        .join("\n");
      expect(appended).toContain("```tool_result");
      expect(appended).toContain("RESPONSE_INTERCEPT_MARKER");
      expect(appended).toContain("Observed risky output. Continue with mitigation steps.");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it.serial("runs tool interception for provider-native Claude Bash events", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, notifications } = makeCtx({ conversationId: "conversation_tool_intercept_provider_bash" });
    process.env.MOCK_PROVIDER_SKIP_DELTAS = "1";
    process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE = "1";
    process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON = JSON.stringify([
      {
        type: "provider_item",
        item: { provider: "claude", kind: "tool_call", name: "Bash", summary: "tool_call Bash" },
        raw: {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_bash_1", name: "Bash", input: { command: "echo __CLAUDE_BASH_INTERCEPT__" } }] },
        },
      },
      {
        type: "provider_item",
        item: { provider: "claude", kind: "tool_result", name: "tool_result", summary: "tool_result toolu_bash_1", text: "ok" },
        raw: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash_1", content: "ok" }] },
        },
      },
      { type: "done", threadId: "thread_provider_bash" },
    ]);
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "append_message_and_continue",
      payload: strictSupervisorPayload({
        message: "Bash provider interception fired.",
        message_template: "tool_intercept_guidance",
      }),
      mode_assessment: null,
      reasoning: "",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_tool_intercept_provider_bash", "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          toolInterception: {
            rules: [
              {
                when: "invocation",
                tool: "bash",
                matchType: "contains",
                pattern: "__CLAUDE_BASH_INTERCEPT__",
                caseSensitive: true,
              },
            ],
          },
        },
      });
      expect(result.stopReasons).toEqual(["cycle_limit"]);
      const appended = notifications
        .filter((note) => note.method === "conversation.append")
        .map((note) => String(note.params?.markdown ?? ""))
        .join("\n");
      expect(appended).toContain("```tool_call name=Bash");
      expect(appended).toContain("Bash provider interception fired.");
    } finally {
      delete process.env.MOCK_PROVIDER_SKIP_DELTAS;
      delete process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE;
      delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it.serial("runs tool interception for provider-native MCP response events", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, notifications } = makeCtx({ conversationId: "conversation_tool_intercept_provider_mcp" });
    process.env.MOCK_PROVIDER_SKIP_DELTAS = "1";
    process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE = "1";
    process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON = JSON.stringify([
      {
        type: "provider_item",
        item: { provider: "claude", kind: "tool_call", name: "mcp__arc_tools__status", summary: "tool_call mcp__arc_tools__status" },
        raw: {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_mcp_1", name: "mcp__arc_tools__status", input: { query: "status" } }] },
        },
      },
      {
        type: "provider_item",
        item: { provider: "claude", kind: "tool_result", name: "tool_result", summary: "tool_result toolu_mcp_1", text: "__MCP_INTERCEPT_MARKER__" },
        raw: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_mcp_1", content: "__MCP_INTERCEPT_MARKER__" }] },
        },
      },
      { type: "done", threadId: "thread_provider_mcp" },
    ]);
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "append_message_and_continue",
      payload: strictSupervisorPayload({
        message: "MCP provider interception fired.",
        message_template: "tool_intercept_guidance",
      }),
      mode_assessment: null,
      reasoning: "",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_tool_intercept_provider_mcp", "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          toolInterception: {
            rules: [
              {
                when: "response",
                tool: "mcp",
                matchType: "contains",
                pattern: "__MCP_INTERCEPT_MARKER__",
                caseSensitive: true,
              },
            ],
          },
        },
      });
      expect(result.stopReasons).toEqual(["cycle_limit"]);
      const appended = notifications
        .filter((note) => note.method === "conversation.append")
        .map((note) => String(note.params?.markdown ?? ""))
        .join("\n");
      expect(appended).toContain("__MCP_INTERCEPT_MARKER__");
      expect(appended).toContain("MCP provider interception fired.");
    } finally {
      delete process.env.MOCK_PROVIDER_SKIP_DELTAS;
      delete process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE;
      delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it.serial("can route a tool interception through supervisor-mediated switch_mode", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, createForkCalls } = makeCtx({ conversationId: "conversation_tool_intercept_switch_mode" });
    process.env.MOCK_PROVIDER_SKIP_DELTAS = "1";
    process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE = "1";
    process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON = JSON.stringify([
      {
        type: "provider_item",
        item: { provider: "claude", kind: "tool_call", name: "Bash", summary: "tool_call Bash" },
        raw: {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_bash_switch", name: "Bash", input: { command: "echo __COMPARE_MISMATCH__" } }] },
        },
      },
      {
        type: "provider_item",
        item: { provider: "claude", kind: "tool_result", name: "tool_result", summary: "tool_result toolu_bash_switch", text: "__COMPARE_MISMATCH__" },
        raw: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash_switch", content: "__COMPARE_MISMATCH__" }] },
        },
      },
      { type: "done", threadId: "thread_provider_switch_mode" },
    ]);
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "fork_new_conversation",
      payload: strictSupervisorPayload({
        reason: "follow configured switch",
        mode: "code_model",
      }),
      mode_assessment: null,
      reasoning: "",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_tool_intercept_switch_mode", "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          toolInterception: {
            rules: [
              {
                when: "response",
                tool: "bash",
                matchType: "contains",
                pattern: "__COMPARE_MISMATCH__",
                caseSensitive: true,
                action: {
                  type: "supervisor_switch_mode",
                  targetMode: "code_model",
                  reason: "compare mismatch requires code repair",
                },
              },
            ],
          },
        },
        modes: {
          code_model: {
            user_message: {
              operation: "replace",
              parts: [{ literal: "Code model seed" }],
            },
          },
        },
      });
      expect(result.stopReasons).toEqual(["agent_switch_mode_request"]);
      expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.MOCK_PROVIDER_SKIP_DELTAS;
      delete process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE;
      delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it("defaults supervisor to enabled when enabled is unspecified", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, notifications, createForkCalls } = makeCtx();
    const reviewOverrideJson = JSON.stringify({
      decision: "stop_and_return",
      payload: strictSupervisorPayload({ reason: "task complete" }),
      mode_assessment: { current_mode_stop_satisfied: true, candidate_modes_ranked: [{ mode: "explore", confidence: "low", evidence: "task complete" }], recommended_action: "continue" },
      reasoning: "",
      agent_model: null,
    });
    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc(),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      supervisorModel: "mock-supervisor",
      supervisor: { stopCondition: "task complete", reviewOverrideJson, returnControlPattern: "Mock response for model" },
    });
    expect(result.stopReasons).toContain("return_control");
    expect(createForkCalls).toHaveLength(2);
    expect(Array.isArray(createForkCalls[1].actions)).toBe(true);
    expect(createForkCalls[1].actions[0].action).toBe("stop");
    expect(createForkCalls[1].supervisorThreadId).toBeUndefined();
    expect(typeof createForkCalls[1].actionSummary).toBe("string");
    expect(notifications.some((n) => n.method === "conversation.supervisor_run_start")).toBe(true);
    expect(notifications.some((n) => n.method === "conversation.supervisor_run_end")).toBe(true);
  });

  it("emits a budget update when supervisor switches the active agent model", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx, notifications } = makeCtx();
    const reviewOverrideJson = JSON.stringify({
      decision: "stop_and_return",
      payload: strictSupervisorPayload({ reason: "handoff" }),
      mode_assessment: { current_mode_stop_satisfied: true, candidate_modes_ranked: [{ mode: "explore", confidence: "low", evidence: "handoff" }], recommended_action: "continue" },
      reasoning: "",
      agent_model: "mock-model-next",
    });
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc(),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        supervisor: { enabled: true, stopCondition: "task complete", reviewOverrideJson, cadenceTimeMs: 1 },
      });
      const budgetNotice = notifications.find((n) => n.method === "conversation.budget");
      expect(budgetNotice).toBeTruthy();
      expect(budgetNotice.params?.agentModel).toBe("mock-model-next");
      expect(budgetNotice.params?.supervisorModel).toBe("mock-supervisor");
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  });

  it.serial("merges mode-specific supervisor instructions with global instructions", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "supervisor:",
        "  stop_condition: task complete",
        "  instructions:",
        "    operation: append",
        "    values:",
        "      - global instruction marker",
        "modes:",
        "  explore:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: Explore.",
        "    supervisor_instructions:",
        "      operation: append",
        "      values:",
        "        - mode instruction marker",
        "mode_state_machine:",
        "  initial_mode: explore",
      ].join("\n"),
      "utf8",
    );

    const { ctx } = makeCtx({ conversationId: "conversation_mode_instructions" });
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "stop_and_return",
      payload: strictSupervisorPayload({ reason: "done" }),
      mode_assessment: { current_mode_stop_satisfied: true, candidate_modes_ranked: [{ mode: "explore", confidence: "low", evidence: "done" }], recommended_action: "continue" },
      reasoning: "",
      agent_model: null,
    });
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_mode_instructions", "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          returnControlPattern: "Mock response for model",
        },
      });

      expect(result.stopReasons).toContain("agent_stop");
      const reviewsDir = path.join(workspaceRoot, ".ai-supervisor", "conversations", "conversation_mode_instructions", "reviews");
      const reviewFiles = await fs.readdir(reviewsDir);
      const promptFile = reviewFiles.find((file) => file.endsWith("_prompt.txt"));
      expect(promptFile).toBeTruthy();
      const promptText = await fs.readFile(path.join(reviewsDir, String(promptFile)), "utf8");
      expect(promptText).toContain("global instruction marker");
      expect(promptText).toContain("mode instruction marker");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });
  it("validates required supervise request inputs", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    const { ctx } = makeCtx();
    const docPath = path.join(workspaceRoot, "session.md");
    const doc = makeDoc();

    await expect(handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath,
      documentText: doc,
      models: [],
      provider: "mock",
    })).rejects.toThrow("models[] required");

    await expect(handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath,
      documentText: doc,
      models: ["mock-a", "mock-b"],
      provider: "mock",
    })).rejects.toThrow("single model only");

    await expect(handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath,
      documentText: "",
      models: ["mock-model"],
      provider: "mock",
    })).rejects.toThrow("documentText required");
  });

  it("merges run-config agent rules with request agent rules", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
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
        "    requirements:",
        "      - rule from config",
        "    violations: []",
        "supervisor:",
        "  instructions:",
        "    operation: append",
        "    values: []",
        "  enabled: false",
      ].join("\n"),
      "utf8",
    );

    const { ctx, createForkCalls } = makeCtx();
    await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc(),
      models: ["mock-model"],
      provider: "mock",
      disableSupervision: true,
      agentRules: ["rule from params"],
    });

    expect(createForkCalls).toHaveLength(2);
    expect(createForkCalls[0].agentRules).toEqual(["rule from params", "rule from config"]);
    expect(createForkCalls[1].agentRules).toEqual(["rule from params", "rule from config"]);
  });
});
