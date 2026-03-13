import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleConversationSupervise } from "./conversation_supervise.js";
import {
  parseSwitchModeInlineCall,
  validateSwitchModeHandoffText,
} from "./conversation_supervise_switch_mode.js";

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

async function writeModePayloadConfig(workspaceRoot: string): Promise<void> {
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
      "        - template: \"theory ticket {{supervisor.phase_ticket}} note {{supervisor.handoff_note}}\"",
      "  code_model:",
      "    user_message:",
      "      operation: append",
      "      parts:",
      "        - template: \"code ticket {{supervisor.phase_ticket}} note {{supervisor.handoff_note}}\"",
      "  release:",
      "    user_message:",
      "      operation: append",
      "      parts:",
      "        - template: \"release ticket {{supervisor.phase_ticket}} note {{supervisor.handoff_note}}\"",
      "mode_state_machine:",
      "  initial_mode: theory",
      "  transitions:",
      "    theory: [theory, code_model, release]",
      "    code_model: [theory, code_model, release]",
      "    release: [release]",
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

function setRuntimeSwitchProviderEvents(command: string): void {
  process.env.MOCK_PROVIDER_SKIP_DELTAS = "1";
  process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE = "1";
  process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON = JSON.stringify([
    {
      type: "provider_item",
      item: {
        provider: "claude",
        kind: "tool_call",
        name: "Bash",
        summary: command,
      },
      raw: {
        method: "item/started",
        params: {
          item: {
            id: "bash_switch",
            name: "Bash",
            input: { command },
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
            input: { command },
            output: "{\"ok\":true}",
            status: "completed",
          },
        },
      },
    },
    { type: "done", threadId: "thread_switch_mode_interrupt" },
  ]);
}

afterEach(async () => {
  delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
  delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
  delete process.env.MOCK_PROVIDER_RUNONCE_TEXT_SEQUENCE;
  delete process.env.MOCK_PROVIDER_RUNONCE_EMPTY;
  delete process.env.MOCK_PROVIDER_RUNONCE_ERROR;
  delete process.env.MOCK_PROVIDER_SKIP_DELTAS;
  delete process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE;
  delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
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
  it("ignores disabled inline switch_mode requests when CLI switching is the active path", () => {
    const parsed = parseSwitchModeInlineCall({
      call: {
        name: "switch_mode",
        body: '{"target_mode":"explore","reason":"go explore"}',
        args: { target_mode: "explore", reason: "go explore" },
      },
      toolConfig: {
        builtinPolicy: {
          mode: "deny",
          names: ["switch_mode"],
        },
      } as any,
    });

    expect(parsed).toEqual({ kind: "not_switch_mode" });
  });

  it("parses runtime-captured switch_mode requests even when builtin policy omits switch_mode", () => {
    const parsed = parseSwitchModeInlineCall({
      call: {
        name: "switch_mode",
        body: '{"target_mode":"explore_and_solve","reason":"need one probe","user_message":"Probe one action."}',
        args: {
          target_mode: "explore_and_solve",
          reason: "need one probe",
          user_message: "Probe one action.",
        },
        source: "runtime_provider",
      },
      toolConfig: {
        builtinPolicy: {
          mode: "allow",
          names: ["shell", "read_file"],
        },
      } as any,
    });

    expect(parsed).toEqual({
      kind: "request",
      request: {
        targetMode: "explore_and_solve",
        reason: "need one probe",
        modePayload: { user_message: "Probe one action." },
        terminal: true,
      },
    });
  });

  it("rejects mixed probe-plus-route explore handoffs", () => {
    expect(
      validateSwitchModeHandoffText({
        targetMode: "explore_and_solve",
        text: [
          "Probe ACTION1 to confirm vertical movement.",
          "If confirmed, execute UP x3, LEFT x5, DOWN x1 to reach marker_a.",
        ].join(" "),
      }),
    ).toContain("mixed staged agendas");
  });

  it("allows bounded multi-action explore routes with an explicit stop condition", () => {
    expect(
      validateSwitchModeHandoffText({
        targetMode: "explore_and_solve",
        text: [
          "Target class: reach marker_a overlap to test the completion-trigger theory.",
          "Probe sequence: LEFT x3, DOWN x1.",
          "Stop condition: stop on completion, a novel event, route exhausted, or blocked.",
        ].join(" "),
      }),
    ).toBeNull();
  });

  it.serial("allows generic runtime-captured mode_payload entries for any target mode", async () => {
    for (const targetMode of ["theory", "code_model"]) {
      const workspaceRoot = await makeTempRoot(`conv-supervise-switch-payload-${targetMode}-`);
      await writeModePayloadConfig(workspaceRoot);
      setRuntimeSwitchProviderEvents(
        `switch_mode --target-mode ${targetMode} --reason phase_transition --mode-payload phase_ticket=alpha --mode-payload handoff_note=carry`,
      );
      const { ctx, notifications, createForkCalls } = makeCtx(`conversation_payload_${targetMode}`);

      const result = await handleConversationSupervise(ctx, {
        workspaceRoot,
        docPath: path.join(workspaceRoot, "session.md"),
        documentText: makeDoc(`conversation_payload_${targetMode}`, "fork_doc"),
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
      const switchFork = createForkCalls.find((call) => call.actionSummary === `agent:switch_mode theory->${targetMode}`);
      expect(switchFork).toBeDefined();
      expect(String(switchFork?.documentText ?? "")).toContain(`mode: ${targetMode}`);
      const appended = notifications
        .filter((note) => note.method === "conversation.append")
        .map((note) => String(note.params?.markdown ?? ""))
        .join("\n");
      expect(appended).not.toContain("not allowed");
    }
  });

  it.serial("renders required mode_payload fields from generic CLI payload entries", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-payload-release-");
    await writeModePayloadConfig(workspaceRoot);
    setRuntimeSwitchProviderEvents(
      "switch_mode --target-mode release --reason phase_transition --mode-payload phase_ticket=alpha --mode-payload handoff_note=carry",
    );
    const { ctx, notifications, createForkCalls } = makeCtx("conversation_payload_release");

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_payload_release", "fork_doc"),
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
    const switchFork = createForkCalls.find((call) => call.actionSummary === "agent:switch_mode theory->release");
    expect(switchFork).toBeDefined();
    expect(String(switchFork?.documentText ?? "")).toContain("mode: release");
    expect(String(switchFork?.documentText ?? "")).toContain("release ticket alpha note carry");
    const appended = notifications
      .filter((note) => note.method === "conversation.append")
      .map((note) => String(note.params?.markdown ?? ""))
      .join("\n");
    expect(appended).not.toContain("required");
  });
});
