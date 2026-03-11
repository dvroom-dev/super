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

function makeDoc(conversationId = "conversation_parallel", forkId = "fork_doc"): string {
  return [
    "---",
    `conversation_id: ${conversationId}`,
    `fork_id: ${forkId}`,
    "---",
    "",
    "```chat role=user",
    "Start working.",
    "```",
  ].join("\n");
}

function makeCtx(conversationId = "conversation_parallel") {
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

function cadenceReviewOverride(messageTemplate = "supervisor_command"): string {
  return JSON.stringify({
    decision: "append_message_and_continue",
    stop_and_return: null,
    rewrite_with_check_supervisor_and_continue: null,
    append_message_and_continue: {
      message: "CADENCE_NUDGE_CONTINUE",
      message_template: messageTemplate,
    },
    fork_new_conversation: null,
    retry: null,
    return_check_supervisor: null,
    continue: null,
    mode_assessment: {
      current_mode_stop_satisfied: false,
      candidate_modes_ranked: [{ mode: "explore", confidence: "medium", evidence: "Cadence checkpoint guidance." }],
      recommended_action: "continue",
    },
    reasoning: "",
    agent_model: null,
  });
}

function cadenceCustomReviewOverride(): string {
  return JSON.stringify({
    decision: "append_message_and_continue",
    stop_and_return: null,
    rewrite_with_check_supervisor_and_continue: null,
    append_message_and_continue: {
      message: "FREEFORM_SUPERVISOR_MESSAGE",
      message_template: "custom",
    },
    fork_new_conversation: null,
    retry: null,
    return_check_supervisor: null,
    continue: null,
    mode_assessment: {
      current_mode_stop_satisfied: false,
      candidate_modes_ranked: [{ mode: "explore", confidence: "medium", evidence: "Custom cadence message." }],
      recommended_action: "continue",
    },
    reasoning: "",
    agent_model: null,
  });
}

function yieldStopOverride(): string {
  return JSON.stringify({
    decision: "stop_and_return",
    stop_and_return: { reason: "YIELD_STOP" },
    rewrite_with_check_supervisor_and_continue: null,
    append_message_and_continue: null,
    fork_new_conversation: null,
    retry: null,
    return_check_supervisor: null,
    mode_assessment: {
      current_mode_stop_satisfied: true,
      candidate_modes_ranked: [{ mode: "plan", confidence: "low", evidence: "Run is complete." }],
      recommended_action: "continue",
    },
    reasoning: "",
    agent_model: null,
  });
}

function cadenceStopOverride(waitForBoundary: boolean): string {
  return JSON.stringify({
    decision: "stop_and_return",
    payload: {
      reason: "CADENCE_STOP",
      wait_for_boundary: waitForBoundary,
    },
    mode_assessment: {
      current_mode_stop_satisfied: true,
      candidate_modes_ranked: [{ mode: "explore", confidence: "medium", evidence: "Cadence stop requested." }],
      recommended_action: "continue",
    },
    reasoning: "",
    agent_model: null,
  });
}

describe("parallel supervisor trigger exercise", () => {
  it("cadence trigger runs while agent remains in control and injects continuation guidance", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-parallel-");
    const { ctx, notifications, createForkCalls } = makeCtx("conversation_cadence");
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_cadence", "fork_cadence"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 2,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          cadenceTimeMs: 1,
          reviewOverrideJson: cadenceReviewOverride(),
        },
      });

      expect(result.stopReasons).toEqual(["cycle_limit"]);
      expect(createForkCalls).toHaveLength(3);
      expect(
        createForkCalls.some(
          (call) =>
            String(call.documentText ?? "").includes("```supervisor_action mode=soft") &&
            String(call.documentText ?? "").includes("decision: append_message_and_continue") &&
            String(call.documentText ?? "").includes("<supervisor-command trigger=\"cadence\">") &&
            String(call.documentText ?? "").includes("CADENCE_NUDGE_CONTINUE"),
        ),
      ).toBe(true);
      expect(
        notifications.some(
          (note) =>
            note.method === "conversation.supervisor_run_start" &&
            note.params?.mode === "soft",
        ),
      ).toBe(true);
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  });

  it("agent_yield trigger runs on natural stop (legacy agent_return_no_error behavior)", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-parallel-");
    const { ctx, notifications, createForkCalls } = makeCtx("conversation_yield");
    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_yield", "fork_yield"),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      supervisorModel: "mock-supervisor",
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
        reviewOverrideJson: yieldStopOverride(),
      },
    });

    expect(result.stopReasons).toEqual(["agent_stop"]);
    expect(createForkCalls).toHaveLength(2);
    const finalDoc = String(createForkCalls[1]?.documentText ?? "");
    expect(finalDoc).toContain("```supervisor_action mode=hard action=stop");
    expect(finalDoc).toContain("trigger: agent_yield");
    expect(finalDoc).toContain("decision: stop_and_return");
    expect(finalDoc).toContain("resume: false");
    expect(
      notifications.some(
        (note) =>
          note.method === "conversation.supervisor_run_start" &&
          note.params?.mode === "hard",
      ),
    ).toBe(true);
  });

  it("cadence stop decision interrupts immediately by default", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-parallel-");
    const { ctx, notifications } = makeCtx("conversation_cadence_interrupt");
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_cadence_interrupt", "fork_interrupt"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          cadenceTimeMs: 1,
          reviewOverrideJson: cadenceStopOverride(false),
        },
      });
      expect(result.stopReasons).toContain("cadence_time");
      expect(notifications.some((note) => note.method === "conversation.supervisor_turn_decision")).toBe(true);
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  });

  it("cadence stop decision waits for boundary when wait_for_boundary=true", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-parallel-");
    const { ctx, notifications } = makeCtx("conversation_cadence_boundary");
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_cadence_boundary", "fork_boundary"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          cadenceTimeMs: 1,
          reviewOverrideJson: cadenceStopOverride(true),
        },
      });
      expect(result.stopReasons).not.toContain("interrupted");
      expect(
        notifications.some(
          (note) =>
            note.method === "conversation.status" &&
            String(note.params?.message ?? "").includes("cadence supervisor interrupt"),
        ),
      ).toBe(false);
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  });

  it("respects cadence_interrupt_policy=boundary for cadence stop reviews", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-parallel-");
    const { ctx, notifications } = makeCtx("conversation_cadence_policy_boundary");
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_cadence_policy_boundary", "fork_policy_boundary"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          cadenceTimeMs: 1,
          cadenceInterruptPolicy: "boundary",
          reviewOverrideJson: cadenceStopOverride(false),
        },
      });
      expect(result.stopReasons).toContain("cadence_time");
      expect(result.stopReasons).not.toContain("interrupted");
      expect(
        notifications.some(
          (note) =>
            note.method === "conversation.status" &&
            String(note.params?.message ?? "").includes("cadence supervisor interrupt"),
        ),
      ).toBe(false);
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  });

  it("supports configurable injected message_type per trigger template", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-parallel-");
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
        "    requirements: []",
        "    violations: []",
        "supervisor:",
        "  instructions:",
        "    operation: append",
        "    values: []",
        "  stop_condition: task complete",
        "  cadence_time_ms: 1",
        "  supervisor_triggers:",
        "    cadence:",
        "      message_templates:",
        "        - name: system_cadence",
        "          description: send cadence as system message",
        "          message_type: system",
        "          text: |",
        "            <supervisor-command trigger=\"cadence\">{{message}}</supervisor-command>",
      ].join("\n"),
      "utf8",
    );
    const { ctx, createForkCalls } = makeCtx("conversation_message_type");
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_message_type", "fork_type"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          cadenceTimeMs: 1,
          reviewOverrideJson: cadenceReviewOverride("system_cadence"),
        },
      });
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }

    expect(createForkCalls).toHaveLength(2);
    const finalDoc = String(createForkCalls[1]?.documentText ?? "");
    expect(finalDoc).toContain("```chat role=system");
    expect(finalDoc).toContain("<supervisor-command trigger=\"cadence\">CADENCE_NUDGE_CONTINUE</supervisor-command>");
  });

  it("supports freeform custom append messages without templates", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-parallel-");
    const { ctx, createForkCalls } = makeCtx("conversation_custom_message");
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_custom_message", "fork_custom"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          cadenceTimeMs: 1,
          reviewOverrideJson: cadenceCustomReviewOverride(),
        },
      });
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }

    const finalDoc = String(createForkCalls[1]?.documentText ?? "");
    expect(finalDoc).toContain("```chat role=user");
    expect(finalDoc).toContain("FREEFORM_SUPERVISOR_MESSAGE");
  });

  it("supports no-customization templates with empty message payload", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-parallel-");
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
        "    requirements: []",
        "    violations: []",
        "supervisor:",
        "  instructions:",
        "    operation: append",
        "    values: []",
        "  stop_condition: task complete",
        "  cadence_time_ms: 1",
        "  supervisor_triggers:",
        "    cadence:",
        "      message_templates:",
        "        - name: static_cadence",
        "          description: fixed text, no placeholders",
        "          message_type: user",
        "          text: |",
        "            <supervisor-command trigger=\"cadence\">RETURN_CONTROL_NOW</supervisor-command>",
      ].join("\n"),
      "utf8",
    );
    const { ctx, createForkCalls } = makeCtx("conversation_static_message");
    process.env.MOCK_PROVIDER_DELAY_MS = "5";
    try {
      await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc("conversation_static_message", "fork_static"),
        models: ["mock-model"],
        provider: "mock",
        supervisorProvider: "mock",
        supervisorModel: "mock-supervisor",
        cycleLimit: 1,
        supervisor: {
          enabled: true,
          stopCondition: "task complete",
          cadenceTimeMs: 1,
          reviewOverrideJson: JSON.stringify({
            decision: "append_message_and_continue",
            stop_and_return: null,
            rewrite_with_check_supervisor_and_continue: null,
            append_message_and_continue: { message: "", message_template: "static_cadence" },
            fork_new_conversation: null,
            retry: null,
            return_check_supervisor: null,
            continue: null,
            mode_assessment: {
              current_mode_stop_satisfied: false,
              candidate_modes_ranked: [{ mode: "explore", confidence: "medium", evidence: "static cadence guidance" }],
              recommended_action: "continue",
            },
            reasoning: "",
            agent_model: null,
          }),
        },
      });
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }

    const finalDoc = String(createForkCalls[1]?.documentText ?? "");
    expect(finalDoc).toContain("<supervisor-command trigger=\"cadence\">RETURN_CONTROL_NOW</supervisor-command>");
  });
});
