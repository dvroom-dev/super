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

function makeModeDoc(args: {
  conversationId?: string;
  forkId?: string;
  mode: string;
  userMessage?: string;
}): string {
  return [
    "---",
    `conversation_id: ${args.conversationId ?? "conversation_test"}`,
    `fork_id: ${args.forkId ?? "fork_doc"}`,
    `mode: ${args.mode}`,
    "---",
    "",
    "```chat role=user",
    args.userMessage ?? `Seed for ${args.mode}`,
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
  const updateForkCalls: any[] = [];
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
      async updateFork(_workspaceRoot: string, _conversationId: string, forkId: string, patch: any) {
        updateForkCalls.push({ forkId, patch });
        const current = options.forksById?.[forkId] ?? options.baseFork;
        if (current) Object.assign(current, patch);
        return { ...(current ?? {}), id: forkId, ...patch };
      },
    },
  };
  return { ctx, notifications, createForkCalls, loadForkCalls, updateForkCalls };
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
  it.serial("does not infer switch_mode from visible assistant text alone", async () => {
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

    expect(result.stopReasons).toContain("agent_stop");
    expect(createForkCalls.length).toBeGreaterThanOrEqual(1);
    expect(createForkCalls.some((call) => call.actionSummary === "agent:switch_mode theory->explore_and_solve")).toBe(
      false,
    );
    expect(
      createForkCalls.some((call) => String(call.documentText ?? "").includes("mode: explore_and_solve")),
    ).toBe(false);
  });

  it.serial("routes runtime-captured bash switch_mode calls into a real mode fork", async () => {
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
        "        - template: \"probe seed {{supervisor.user_message}}\"",
        "mode_state_machine:",
        "  initial_mode: theory",
        "  transitions:",
        "    theory: [theory, explore_and_solve]",
        "    explore_and_solve: [explore_and_solve]",
      ].join("\n"),
      "utf8",
    );
    process.env.MOCK_PROVIDER_SKIP_DELTAS = "1";
    process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE = "1";
    process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON = JSON.stringify([
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_call",
          name: "Bash",
          summary:
            "switch_mode --target-mode explore_and_solve --reason theory_complete --user-message probe_next_feature",
        },
        raw: {
          method: "item/started",
          params: {
            item: {
              id: "bash_switch",
              name: "Bash",
              input: {
                command:
                  "switch_mode --target-mode explore_and_solve --reason theory_complete --user-message probe_next_feature",
              },
            },
          },
        },
      },
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_result",
          name: "Bash",
          id: "bash_switch",
          summary: "{\"ok\":true}",
          text: "{\"ok\":true}",
        },
        raw: {
          method: "item/completed",
          params: {
            item: {
              id: "bash_switch",
              name: "Bash",
              summary: "{\"ok\":true}",
              input: {
                command:
                  "switch_mode --target-mode explore_and_solve --reason theory_complete --user-message probe_next_feature",
              },
              output: "{\"ok\":true}",
              status: "completed",
            },
          },
        },
      },
      { type: "assistant_message", text: "This should not continue after switch_mode." },
      { type: "done", threadId: "thread_switch_mode_interrupt" },
    ]);
    try {
      const { ctx, createForkCalls } = makeCtx({
        conversationId: "conversation_runtime_switch",
        docForkId: "fork_doc",
      });
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_runtime_switch", "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        disableSupervision: true,
        cycleLimit: 1,
        supervisor: { enabled: true },
      });

      expect(result.stopReasons).toEqual(["cycle_limit"]);
      expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
      const switchFork = createForkCalls.find((call) => call.actionSummary === "agent:switch_mode theory->explore_and_solve");
      expect(switchFork).toBeTruthy();
      expect(String(switchFork?.documentText ?? "")).toContain("mode: explore_and_solve");
      expect(String(switchFork?.documentText ?? "")).toContain("probe seed probe_next_feature");
    } finally {
      delete process.env.MOCK_PROVIDER_SKIP_DELTAS;
      delete process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE;
      delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
    }
  });

  it.serial("runs supervisor bootstrap before the first unsolved level-1 turn", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-bootstrap-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "agent", "game_ls20", "level_current"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "agent", "game_ls20", "level_current", "meta.json"),
      JSON.stringify({ level: 1, analysis_level_pinned: false }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "supervisor:",
        "  stop_condition: task complete",
        "modes:",
        "  explore_and_solve:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - template: \"bootstrap {{supervisor.user_message}}\"",
        "  theory:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: theory seed",
        "mode_state_machine:",
        "  initial_mode: explore_and_solve",
        "  transitions:",
        "    explore_and_solve: [theory]",
        "    theory: [explore_and_solve]",
      ].join("\n"),
      "utf8",
    );
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "Bootstrap turn executed.";
    const reviewOverrideJson = JSON.stringify({
      decision: "fork_new_conversation",
      payload: strictSupervisorPayload({
        mode: "explore_and_solve",
        mode_payload: {
          explore_and_solve: {
            user_message: "take a tiny action sample and then return to theory",
          },
        },
      }),
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [
          {
            mode: "explore_and_solve",
            confidence: "high",
            evidence: "configured initial mode",
          },
        ],
        recommended_action: "fork_new_conversation",
      },
      reasoning: "bootstrap the initial mode",
      agent_model: null,
    });

    const { ctx, createForkCalls, updateForkCalls } = makeCtx({
      conversationId: "conversation_bootstrap",
      docForkId: "fork_doc",
    });
    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      agentBaseDir: path.join(workspaceRoot, "agent", "game_ls20"),
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_bootstrap", "fork_doc"),
      models: ["mock-model"],
      provider: "mock",
      cycleLimit: 1,
      supervisor: { enabled: true, reviewOverrideJson },
    });

    expect(updateForkCalls.length).toBeGreaterThan(0);
    expect(createForkCalls.some((call) => String(call.documentText ?? "").includes("mode: explore_and_solve"))).toBe(
      true,
    );
    expect(
      createForkCalls.some((call) =>
        String(call.documentText ?? "").includes("take a tiny action sample and then return to theory"),
      ),
    ).toBe(true);
    expect(result.activeMode).toBe("explore_and_solve");
  });

  it.serial("exports supervisor transition payload separately from active mode state", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-transition-payload-");
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
        "mode_state_machine:",
        "  initial_mode: theory",
        "  transitions:",
        "    theory: [theory]",
      ].join("\n"),
      "utf8",
    );
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "No mode change required.";
    try {
      const reviewOverrideJson = JSON.stringify({
        decision: "append_message_and_continue",
        payload: {
          message: "Stay in theory and start the next level from the same conversation.",
          message_template: "custom",
        },
        transition_payload: {
          wrapup_certified: "true",
          wrapup_level: "1",
        },
        mode_assessment: {
          current_mode_stop_satisfied: false,
          candidate_modes_ranked: [
            {
              mode: "theory",
              confidence: "high",
              evidence: "stay in theory while releasing the pin",
            },
          ],
          recommended_action: "continue",
        },
        reasoning: "release solved-level wrap-up without changing mode",
        agent_model: null,
      });

      const { ctx } = makeCtx({
        conversationId: "conversation_transition_payload",
        docForkId: "fork_doc",
      });
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeModeDoc({
          conversationId: "conversation_transition_payload",
          forkId: "fork_doc",
          mode: "theory",
        }),
        models: ["mock-model"],
        provider: "mock",
        cycleLimit: 1,
        supervisor: { enabled: true, reviewOverrideJson },
      });

      expect(result.activeMode).toBe("theory");
      expect(result.activeModePayload).toEqual({});
      expect(result.activeTransitionPayload).toEqual({
        wrapup_certified: "true",
        wrapup_level: "1",
      });
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  });

  it.serial("reuses an existing target-mode thread for runtime switch_mode requests", async () => {
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
        "        - template: \"probe seed {{supervisor.user_message}}\"",
        "mode_state_machine:",
        "  initial_mode: theory",
        "  transitions:",
        "    theory: [theory, explore_and_solve]",
        "    explore_and_solve: [explore_and_solve]",
      ].join("\n"),
      "utf8",
    );
    process.env.MOCK_PROVIDER_SKIP_DELTAS = "1";
    process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE = "1";
    process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON = JSON.stringify([
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_call",
          name: "Bash",
          summary:
            "switch_mode --target-mode explore_and_solve --reason theory_complete --user-message probe_next_feature",
        },
        raw: {
          method: "item/started",
          params: {
            item: {
              id: "bash_switch",
              name: "Bash",
              input: {
                command:
                  "switch_mode --target-mode explore_and_solve --reason theory_complete --user-message probe_next_feature",
              },
            },
          },
        },
      },
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_result",
          name: "Bash",
          id: "bash_switch",
          summary: "{\"ok\":true}",
          text: "{\"ok\":true}",
        },
        raw: {
          method: "item/completed",
          params: {
            item: {
              id: "bash_switch",
              name: "Bash",
              summary: "{\"ok\":true}",
              input: {
                command:
                  "switch_mode --target-mode explore_and_solve --reason theory_complete --user-message probe_next_feature",
              },
              output: "{\"ok\":true}",
              status: "completed",
            },
          },
        },
      },
      { type: "done", threadId: "thread_switch_mode_interrupt" },
    ]);
    try {
      const conversationId = "conversation_runtime_switch_reuse";
      const currentDoc = makeModeDoc({
        conversationId,
        forkId: "fork_doc",
        mode: "theory",
        userMessage: "Current theory work",
      });
      const exploreDoc = makeModeDoc({
        conversationId,
        forkId: "fork_explore_existing",
        mode: "explore_and_solve",
        userMessage: "Existing explore thread",
      });
      const { ctx, createForkCalls } = makeCtx({
        conversationId,
        docForkId: "fork_doc",
        index: {
          conversationId,
          headId: "fork_doc",
          headIds: ["fork_doc", "fork_explore_existing"],
          forks: [{ id: "fork_doc" }, { id: "fork_explore_existing" }],
        },
        forksById: {
          fork_doc: { id: "fork_doc", documentText: currentDoc, providerThreadId: "thread_theory" },
          fork_explore_existing: {
            id: "fork_explore_existing",
            documentText: exploreDoc,
            providerThreadId: "thread_explore_existing",
          },
        },
      });
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: currentDoc,
        models: ["mock-model"],
        provider: "mock",
        disableSupervision: true,
        cycleLimit: 1,
        supervisor: { enabled: true },
      });

      expect(result.stopReasons).toEqual(["cycle_limit"]);
      expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
      const resumedFork = createForkCalls.find((call) => call.parentId === "fork_explore_existing");
      expect(resumedFork).toBeTruthy();
      expect(resumedFork?.providerThreadId).toBe("thread_explore_existing");
      expect(String(resumedFork?.documentText ?? "")).toContain("mode: explore_and_solve");
      expect(String(resumedFork?.documentText ?? "")).toContain("probe seed probe_next_feature");
    } finally {
      delete process.env.MOCK_PROVIDER_SKIP_DELTAS;
      delete process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE;
      delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
    }
  });

  it.serial("applies accepted switch_mode requests when supervisor returns continue", async () => {
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
        "        - template: \"probe seed {{supervisor.user_message}}\"",
        "mode_state_machine:",
        "  initial_mode: theory",
        "  transitions:",
        "    theory: [theory, explore_and_solve]",
        "    explore_and_solve: [explore_and_solve]",
      ].join("\n"),
      "utf8",
    );
    process.env.MOCK_PROVIDER_SKIP_DELTAS = "1";
    process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE = "1";
    process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON = JSON.stringify([
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_call",
          name: "Bash",
          summary:
            "switch_mode --target-mode explore_and_solve --reason theory_complete --user-message probe_next_feature",
        },
        raw: {
          method: "item/started",
          params: {
            item: {
              id: "bash_switch",
              name: "Bash",
              input: {
                command:
                  "switch_mode --target-mode explore_and_solve --reason theory_complete --user-message probe_next_feature",
              },
            },
          },
        },
      },
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_result",
          name: "Bash",
          id: "bash_switch",
          summary: "{\"ok\":true}",
          text: "{\"ok\":true}",
        },
        raw: {
          method: "item/completed",
          params: {
            item: {
              id: "bash_switch",
              name: "Bash",
              summary: "{\"ok\":true}",
              input: {
                command:
                  "switch_mode --target-mode explore_and_solve --reason theory_complete --user-message probe_next_feature",
              },
              output: "{\"ok\":true}",
              status: "completed",
            },
          },
        },
      },
      { type: "done", threadId: "thread_switch_mode_interrupt" },
    ]);
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "continue",
      payload: strictSupervisorPayload({}),
      transition_payload: {
        wrapup_certified: "true",
        wrapup_level: "1",
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [
          { mode: "explore_and_solve", confidence: "high", evidence: "single concrete probe target" },
        ],
        recommended_action: "continue",
      },
      reasoning: "accept switch",
      agent_model: null,
    });
    try {
      const conversationId = "conversation_runtime_switch_supervisor_continue";
      const currentDoc = makeModeDoc({
        conversationId,
        forkId: "fork_doc",
        mode: "theory",
        userMessage: "Current theory work",
      });
      const exploreDoc = makeModeDoc({
        conversationId,
        forkId: "fork_explore_existing",
        mode: "explore_and_solve",
        userMessage: "Existing explore thread",
      });
      const { ctx, createForkCalls } = makeCtx({
        conversationId,
        docForkId: "fork_doc",
        index: {
          conversationId,
          headId: "fork_doc",
          headIds: ["fork_doc", "fork_explore_existing"],
          forks: [{ id: "fork_doc" }, { id: "fork_explore_existing" }],
        },
        forksById: {
          fork_doc: {
            id: "fork_doc",
            documentText: currentDoc,
            providerThreadId: "thread_theory",
            supervisorThreadId: "supervisor_thread",
          },
          fork_explore_existing: {
            id: "fork_explore_existing",
            documentText: exploreDoc,
            providerThreadId: "thread_explore_existing",
            supervisorThreadId: "supervisor_thread",
          },
        },
      });
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: currentDoc,
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: { enabled: true },
      });

      expect(result.stopReasons).toEqual(["cycle_limit"]);
      expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
      expect(result.activeMode).toBe("explore_and_solve");
      expect(result.activeTransitionPayload).toEqual({
        wrapup_certified: "true",
        wrapup_level: "1",
      });
      expect(
        createForkCalls.some((call) => String(call.documentText ?? "").includes("probe seed probe_next_feature")),
      ).toBe(true);
    } finally {
      delete process.env.MOCK_PROVIDER_SKIP_DELTAS;
      delete process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE;
      delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it.serial("fails loudly and stops remaining inline tools for unsupported inline switch_mode calls", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-");
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"explore","reason":"go explore"}',
      "```",
      "",
      "```tool_call name=write_file",
      '{"path":"should-not-exist.txt","content":"unexpected"}',
      "```",
    ].join("\n");
    try {
      const { ctx, notifications } = makeCtx({
        conversationId: "conversation_inline_switch_error",
        docForkId: "fork_doc",
      });
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_inline_switch_error", "fork_doc"),
        models: ["mock-model"],
        provider: "mock",
        disableSupervision: true,
        cycleLimit: 1,
        supervisor: { enabled: true },
      });

      expect(result.stopReasons).toEqual(["cycle_limit"]);
      await expect(fs.stat(path.join(workspaceRoot, "should-not-exist.txt"))).rejects.toThrow();
      const appended = notifications
        .filter((note) => note.method === "conversation.append")
        .map((note) => String(note.params?.markdown ?? ""))
        .join("\n");
      expect(appended).toContain("switch_mode requests must come from the runtime CLI capture path");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
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
    const parsed = lines.map((line) => JSON.parse(line));
    const turns = parsed.map((entry) => entry.turn);
    expect(turns).toEqual([1, 2]);
    expect(parsed.every((entry) => typeof entry.timing?.turnElapsedMs === "number")).toBe(true);
    expect(parsed.every((entry) => typeof entry.timing?.agentTurnMs === "number")).toBe(true);
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
      transition_payload: null,
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
      transition_payload: null,
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
      transition_payload: null,
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
      const replacedDoc = String(
        replaceEvents.find((note) =>
          String(note?.params?.documentText ?? "").includes("Do not run this command. Continue with a safer approach."),
        )?.params?.documentText ?? "",
      );
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
      transition_payload: null,
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
      transition_payload: null,
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
      transition_payload: null,
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
      transition_payload: null,
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

  it.serial("forces theory to resume explore when compare is clean and one concrete Explore Plan already exists", async () => {
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
    await fs.writeFile(
      path.join(workspaceRoot, "current_compare.md"),
      [
        "# Current Compare (Level 1)",
        "",
        "- compare_ok: true",
        "- all_match: true",
        "- compared_sequences: 1",
        "- diverged_sequences: 0",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRoot, "theory.md"),
      [
        "Game test Theory",
        "",
        "# Explore Plan",
        "- Target class: box-interior-entry-test",
        "  - Goal: Test whether the stack can enter the box interior.",
        "  - Actions: ACTION1 once from current position.",
        "  - Stop: After this single action, record result and return to theory.",
      ].join("\n"),
      "utf8",
    );

    const conversationId = "conversation_force_explore_resume";
    const currentDoc = makeModeDoc({
      conversationId,
      forkId: "fork_doc",
      mode: "theory",
      userMessage: "Theory seed",
    });
    const exploreDoc = makeModeDoc({
      conversationId,
      forkId: "fork_explore_existing",
      mode: "explore_and_solve",
      userMessage: "Existing explore thread",
    });
    const { ctx, createForkCalls } = makeCtx({
      conversationId,
      docForkId: "fork_doc",
      index: {
        conversationId,
        headId: "fork_doc",
        headIds: ["fork_doc", "fork_explore_existing"],
        forks: [{ id: "fork_doc" }, { id: "fork_explore_existing" }],
      },
      forksById: {
        fork_doc: {
          id: "fork_doc",
          documentText: currentDoc,
          providerThreadId: "thread_theory",
          supervisorThreadId: "supervisor_thread",
        },
        fork_explore_existing: {
          id: "fork_explore_existing",
          documentText: exploreDoc,
          providerThreadId: "thread_explore_existing",
          supervisorThreadId: "supervisor_thread",
        },
      },
    });
    const reviewOverrideJson = JSON.stringify({
      decision: "append_message_and_continue",
      payload: {
        message: "Keep refining theory before switching.",
        message_template: "custom",
      },
      mode_assessment: {
        current_mode_stop_satisfied: false,
        candidate_modes_ranked: [{ mode: "explore_and_solve", confidence: "low", evidence: "supervisor said continue" }],
        recommended_action: "continue",
      },
      reasoning: "",
      agent_model: null,
    });

    process.env.MOCK_PROVIDER_SKIP_DELTAS = "1";
    try {
      await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: currentDoc,
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: { enabled: true, stopCondition: "task complete", reviewOverrideJson },
      });
    } finally {
      delete process.env.MOCK_PROVIDER_SKIP_DELTAS;
    }

    expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
    const resumedFork = createForkCalls.find((call) => call.actionSummary === "resume_mode_head (hard)");
    expect(resumedFork).toBeTruthy();
    expect(resumedFork.parentId).toBe("fork_explore_existing");
    expect(resumedFork.providerThreadId).toBe("thread_explore_existing");
    expect(String(resumedFork.documentText ?? "")).toContain("mode: explore_and_solve");
    expect(String(resumedFork.documentText ?? "")).toContain("Current compare is clean");
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

  it("disables cadence reviews when cadence_enabled=false", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-no-cadence-");
    const { ctx, notifications } = makeCtx();
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc(),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          cadenceEnabled: false,
          cadenceTimeMs: 1,
        },
      });
      expect(result.stopReasons).not.toContain("cadence_time");
      expect(
        notifications.some(
          (note) => note.method === "conversation.status" && String(note.params?.message ?? "").includes("cadence"),
        ),
      ).toBe(false);
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
      transition_payload: null,
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

  it("runs v2 validators after a turn and resumes with validator output when they fail", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-v2-validators-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "schema_version: 2",
        "runtime_defaults:",
        "  agent_provider: mock",
        "  agent_model: mock-model",
        "models:",
        "  fast_reader:",
        "    provider: mock",
        "    model: mock-fast",
        "validators:",
        "  fail_check:",
        "    command: |",
        "      echo '{\"ok\": false}'",
        "    parse_as: json",
        "    success:",
        "      type: json_field_truthy",
        "      field: ok",
        "task_profiles:",
        "  spatial_analysis:",
        "    mode: theory",
        "    preferred_models: [fast_reader]",
        "    validators: [fail_check]",
        "process:",
        "  initial_stage: feature_inventory",
        "  stages:",
        "    feature_inventory:",
        "      profile: spatial_analysis",
        "modes:",
        "  theory:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: theory seed",
        "mode_state_machine:",
        "  initial_mode: theory",
      ].join("\n"),
      "utf8",
    );

    const { ctx, createForkCalls } = makeCtx({ conversationId: "conversation_v2_validator" });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "validator loop turn";
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeModeDoc({
          conversationId: "conversation_v2_validator",
          forkId: "fork_doc",
          mode: "theory",
        }),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: { enabled: false },
      });

      expect(result.activeMode).toBe("theory");
      expect((result as any).activeProcessStage).toBe("feature_inventory");
      expect((result as any).activeTaskProfile).toBe("spatial_analysis");
      expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
      expect(String(createForkCalls.at(-1)?.documentText ?? "")).toContain("Post-turn validator failures:");
      expect(String(createForkCalls.at(-1)?.documentText ?? "")).toContain("Validator: fail_check");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  });

  it("does not switch the agent model to a task-profile model from a different provider", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-v2-provider-compat-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "schema_version: 2",
        "runtime_defaults:",
        "  agent_provider: mock",
        "  agent_model: mock-model",
        "models:",
        "  code_repair:",
        "    provider: codex",
        "    model: gpt-5.4",
        "task_profiles:",
        "  model_repair:",
        "    mode: code_model",
        "    preferred_models: [code_repair]",
        "process:",
        "  initial_stage: model_parity",
        "  stages:",
        "    model_parity:",
        "      profile: model_repair",
        "modes:",
        "  code_model:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: code model seed",
        "mode_state_machine:",
        "  initial_mode: code_model",
        "supervisor:",
        "  enabled: false",
      ].join("\n"),
      "utf8",
    );

    const { ctx, notifications, createForkCalls } = makeCtx({ conversationId: "conversation_v2_provider_compat" });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "provider compatibility turn";
    try {
      await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeModeDoc({
          conversationId: "conversation_v2_provider_compat",
          forkId: "fork_doc",
          mode: "code_model",
        }),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: { enabled: false },
      });
      const budgetNotice = notifications.find((note) => note.method === "conversation.budget");
      expect(budgetNotice).toBeUndefined();
      expect(createForkCalls.every((call) => call.model === "mock-model")).toBe(true);
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  });

  it("lets report_process_result drive stage/profile progression on the v2 path", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-v2-process-result-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "schema_version: 2",
        "runtime_defaults:",
        "  agent_provider: mock",
        "  agent_model: mock-model",
        "  supervisor_provider: mock",
        "  supervisor_model: mock-supervisor",
        "task_profiles:",
        "  action_vocabulary:",
        "    mode: explore_and_solve",
        "  spatial_analysis:",
        "    mode: theory",
        "process:",
        "  initial_stage: action_vocabulary",
        "  stages:",
        "    action_vocabulary:",
        "      profile: action_vocabulary",
        "      allowed_next_profiles: [spatial_analysis]",
        "    feature_inventory:",
        "      profile: spatial_analysis",
        "supervisor:",
        "  stop_condition: task complete",
        "modes:",
        "  explore_and_solve:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore seed",
        "  theory:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: theory seed",
        "mode_state_machine:",
        "  initial_mode: explore_and_solve",
        "  transitions:",
        "    explore_and_solve: [theory]",
      ].join("\n"),
      "utf8",
    );
    const { ctx, createForkCalls } = makeCtx({ conversationId: "conversation_v2_process_result" });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=report_process_result",
      '{"outcome":"complete","summary":"action vocabulary established","evidence":"ACTION1 moves the actor","requested_profile":"spatial_analysis","user_message":"Inventory frontier features next."}',
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "fork_new_conversation",
      payload: strictSupervisorPayload({
        mode: "theory",
        mode_payload: { theory: {} },
        wait_for_boundary: false,
      }),
      transition_payload: {
        process_stage: "feature_inventory",
        task_profile: "spatial_analysis",
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [
          { mode: "theory", confidence: "high", evidence: "next process profile maps to theory" },
        ],
        recommended_action: "fork_new_conversation",
      },
      reasoning: "advance from action_vocabulary to feature_inventory",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeModeDoc({
          conversationId: "conversation_v2_process_result",
          forkId: "fork_doc",
          mode: "explore_and_solve",
        }),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
      });
      expect(result.activeMode).toBe("theory");
      expect((result as any).activeProcessStage).toBe("feature_inventory");
      expect((result as any).activeTaskProfile).toBe("spatial_analysis");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it("normalizes stale process transition payload to the chosen mode on the v2 path", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-v2-normalize-transition-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "schema_version: 2",
        "runtime_defaults:",
        "  agent_provider: mock",
        "  agent_model: mock-model",
        "  supervisor_provider: mock",
        "  supervisor_model: mock-supervisor",
        "task_profiles:",
        "  spatial_analysis:",
        "    mode: theory",
        "  model_repair:",
        "    mode: code_model",
        "process:",
        "  initial_stage: feature_inventory",
        "  stages:",
        "    feature_inventory:",
        "      profile: spatial_analysis",
        "    model_repair:",
        "      profile: model_repair",
        "supervisor:",
        "  stop_condition: task complete",
        "modes:",
        "  theory:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: theory seed",
        "  code_model:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: code seed",
        "mode_state_machine:",
        "  initial_mode: theory",
        "  transitions:",
        "    theory: [code_model]",
      ].join("\n"),
      "utf8",
    );
    const { ctx } = makeCtx({ conversationId: "conversation_v2_normalize_transition" });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=report_process_result",
      '{"outcome":"complete","summary":"ready for model repair","requested_profile":"spatial_analysis","user_message":"patch model now"}',
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "fork_new_conversation",
      payload: strictSupervisorPayload({
        mode: "code_model",
        mode_payload: { code_model: {} },
        wait_for_boundary: false,
      }),
      transition_payload: {
        process_stage: "feature_inventory",
        task_profile: "spatial_analysis",
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [
          { mode: "code_model", confidence: "high", evidence: "model repair is the chosen next task" },
        ],
        recommended_action: "fork_new_conversation",
      },
      reasoning: "move from theory to code_model",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeModeDoc({
          conversationId: "conversation_v2_normalize_transition",
          forkId: "fork_doc",
          mode: "theory",
        }),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
      });
      expect(result.activeMode).toBe("code_model");
      expect((result as any).activeProcessStage).toBe("model_repair");
      expect((result as any).activeTaskProfile).toBe("model_repair");
      expect((result as any).activeTransitionPayload).toEqual({
        process_stage: "model_repair",
        task_profile: "model_repair",
      });
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it("enforces fork_fresh resume_strategy for v2 task profiles even when supervisor asks to resume_mode_head", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-v2-fork-fresh-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "schema_version: 2",
        "runtime_defaults:",
        "  agent_provider: mock",
        "  agent_model: mock-model",
        "  supervisor_provider: mock",
        "  supervisor_model: mock-supervisor",
        "task_profiles:",
        "  spatial_analysis:",
        "    mode: theory",
        "    resume_strategy: fork_fresh",
        "process:",
        "  initial_stage: feature_inventory",
        "  stages:",
        "    feature_inventory:",
        "      profile: spatial_analysis",
        "supervisor:",
        "  stop_condition: task complete",
        "modes:",
        "  theory:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: theory seed",
        "mode_state_machine:",
        "  initial_mode: theory",
        "  transitions:",
        "    theory: [theory]",
      ].join("\n"),
      "utf8",
    );
    const existingTheoryFork = {
      id: "fork_existing_theory",
      documentText: makeModeDoc({
        conversationId: "conversation_v2_fork_fresh",
        forkId: "fork_existing_theory",
        mode: "theory",
        userMessage: "old theory head",
      }),
      providerThreadId: "thread_existing_theory",
      supervisorThreadId: "supervisor_thread_existing_theory",
    };
    const { ctx, createForkCalls } = makeCtx({
      conversationId: "conversation_v2_fork_fresh",
      index: {
        conversationId: "conversation_v2_fork_fresh",
        headId: "fork_existing_theory",
        headIds: ["fork_existing_theory"],
        forks: [{ id: "fork_existing_theory" }],
      },
      forksById: {
        fork_existing_theory: existingTheoryFork,
      },
      historyEdited: false,
    });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=report_process_result",
      '{"outcome":"blocked","summary":"need a fresh theory worker","requested_profile":"spatial_analysis","user_message":"Reopen theory with a fresh packet."}',
      "```",
    ].join("\n");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "resume_mode_head",
      payload: strictSupervisorPayload({
        mode: "theory",
        mode_payload: {},
        message: "Fresh theory packet.",
        message_type: "user",
        wait_for_boundary: false,
      }),
      transition_payload: {
        process_stage: "feature_inventory",
        task_profile: "spatial_analysis",
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [
          { mode: "theory", confidence: "high", evidence: "target profile maps to theory" },
        ],
        recommended_action: "resume_mode_head",
      },
      reasoning: "request a fresh theory worker despite same mode",
      agent_model: null,
    });
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeModeDoc({
          conversationId: "conversation_v2_fork_fresh",
          forkId: "fork_doc",
          mode: "theory",
        }),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
      });
      expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
      expect(String(createForkCalls.at(-1)?.documentText ?? "")).toContain("Fresh theory packet.");
      expect(createForkCalls.at(-1)?.providerThreadId).toBeUndefined();
      expect(result.activeMode).toBe("theory");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it("boots schema_version 2 runs from supervisor-owned process state before the first worker mode exists", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-v2-bootstrap-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "schema_version: 2",
        "runtime_defaults:",
        "  agent_provider: mock",
        "  agent_model: mock-model",
        "  supervisor_provider: mock",
        "  supervisor_model: mock-supervisor",
        "task_profiles:",
        "  action_vocabulary:",
        "    mode: explore_and_solve",
        "process:",
        "  initial_stage: action_vocabulary",
        "  stages:",
        "    action_vocabulary:",
        "      profile: action_vocabulary",
        "supervisor:",
        "  stop_condition: task complete",
        "modes:",
        "  explore_and_solve:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore seed",
        "mode_state_machine:",
        "  initial_mode: explore_and_solve",
      ].join("\n"),
      "utf8",
    );

    const bootstrapDoc = [
      "---",
      "conversation_id: conversation_v2_bootstrap",
      "fork_id: fork_doc",
      "process_stage: action_vocabulary",
      "task_profile: action_vocabulary",
      "---",
      "",
      "<!-- supervisor-owned process bootstrap: no worker conversation has started yet -->",
    ].join("\n");
    const { ctx, createForkCalls, updateForkCalls } = makeCtx({ conversationId: "conversation_v2_bootstrap" });
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify({
      decision: "fork_new_conversation",
      payload: strictSupervisorPayload({
        mode: "explore_and_solve",
        mode_payload: { explore_and_solve: {} },
        wait_for_boundary: false,
      }),
      transition_payload: {
        process_stage: "action_vocabulary",
        task_profile: "action_vocabulary",
      },
      mode_assessment: {
        current_mode_stop_satisfied: true,
        candidate_modes_ranked: [
          { mode: "explore_and_solve", confidence: "high", evidence: "initial profile maps to explore_and_solve" },
        ],
        recommended_action: "fork_new_conversation",
      },
      reasoning: "bootstrap into first worker profile",
      agent_model: null,
    });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "bootstrap worker turn";
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: bootstrapDoc,
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
      });

      const bootstrapFrontmatter = String(updateForkCalls[0]?.patch?.documentText ?? "").split("\n---\n")[0] ?? "";
      expect(bootstrapFrontmatter).toContain("process_stage: action_vocabulary");
      expect(bootstrapFrontmatter).not.toContain("\nmode:");
      const initialForkFrontmatter = String(createForkCalls[0]?.documentText ?? "").split("\n---\n")[0] ?? "";
      expect(initialForkFrontmatter).not.toContain("\nmode:");
      expect(String(createForkCalls[1]?.documentText ?? "")).toContain("mode: explore_and_solve");
      expect(result.activeMode).toBe("explore_and_solve");
      expect((result as any).activeProcessStage).toBe("action_vocabulary");
      expect((result as any).activeTaskProfile).toBe("action_vocabulary");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  });

  it("rejects switch_mode on schema_version 2 runs", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-v2-switch-reject-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "schema_version: 2",
        "runtime_defaults:",
        "  agent_provider: mock",
        "  agent_model: mock-model",
        "task_profiles:",
        "  spatial_analysis:",
        "    mode: theory",
        "process:",
        "  initial_stage: feature_inventory",
        "  stages:",
        "    feature_inventory:",
        "      profile: spatial_analysis",
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
        "    theory: [explore_and_solve]",
      ].join("\n"),
      "utf8",
    );
    const { ctx } = makeCtx({ conversationId: "conversation_v2_switch_reject" });
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```tool_call name=switch_mode",
      '{"target_mode":"explore_and_solve","reason":"legacy path"}',
      "```",
    ].join("\n");
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeModeDoc({
          conversationId: "conversation_v2_switch_reject",
          forkId: "fork_doc",
          mode: "theory",
        }),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: { enabled: false },
      });
      expect(result.activeMode).toBe("theory");
      expect(result.stopReasons).toContain("cycle_limit");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  });
});
