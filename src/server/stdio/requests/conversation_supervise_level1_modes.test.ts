import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleConversationSupervise } from "./conversation_supervise.js";
import { allowedNextModesFor } from "./conversation_supervise_runtime.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.MOCK_PROVIDER_SKIP_DELTAS;
  delete process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE;
  delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
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

describe("level-1 mode gating", () => {
  it.serial("restricts unsolved level 1 theory to explore_and_solve only", async () => {
    const agentBaseDir = await makeTempRoot("conv-supervise-level1-agent-");
    await fs.mkdir(path.join(agentBaseDir, "level_current"), { recursive: true });
    await fs.writeFile(
      path.join(agentBaseDir, "level_current", "meta.json"),
      JSON.stringify({ level: 1, analysis_level_pinned: false }, null, 2),
      "utf8",
    );

    const modes = await allowedNextModesFor({
      renderedRunConfig: {
        modesEnabled: true,
        modes: {
          theory: {},
          explore_and_solve: {},
          code_model: {},
          recover: {},
        },
        modeStateMachine: {
          transitions: {
            theory: ["explore_and_solve", "code_model", "recover"],
          },
        },
      } as any,
      activeMode: "theory",
      agentBaseDir,
    });

    expect(modes).toEqual(["explore_and_solve"]);
  });

  it.serial("lets unsolved level 1 explore return only to theory", async () => {
    const agentBaseDir = await makeTempRoot("conv-supervise-level1-explore-agent-");
    await fs.mkdir(path.join(agentBaseDir, "level_current"), { recursive: true });
    await fs.writeFile(
      path.join(agentBaseDir, "level_current", "meta.json"),
      JSON.stringify({ level: 1, analysis_level_pinned: false }, null, 2),
      "utf8",
    );

    const modes = await allowedNextModesFor({
      renderedRunConfig: {
        modesEnabled: true,
        modes: {
          theory: {},
          explore_and_solve: {},
          code_model: {},
        },
        modeStateMachine: {
          transitions: {
            explore_and_solve: ["theory", "code_model"],
          },
        },
      } as any,
      activeMode: "explore_and_solve",
      agentBaseDir,
    });

    expect(modes).toEqual(["theory"]);
  });

  it.serial("keeps configured later-level or wrap-up transitions", async () => {
    const agentBaseDir = await makeTempRoot("conv-supervise-level-pin-agent-");
    await fs.mkdir(path.join(agentBaseDir, "level_current"), { recursive: true });
    await fs.writeFile(
      path.join(agentBaseDir, "level_current", "meta.json"),
      JSON.stringify({ level: 1, analysis_level_pinned: true }, null, 2),
      "utf8",
    );

    const modes = await allowedNextModesFor({
      renderedRunConfig: {
        modesEnabled: true,
        modes: {
          theory: {},
          explore_and_solve: {},
          code_model: {},
        },
        modeStateMachine: {
          transitions: {
            theory: ["explore_and_solve", "code_model"],
          },
        },
      } as any,
      activeMode: "theory",
      agentBaseDir,
    });

    expect(modes).toEqual(["explore_and_solve", "code_model"]);
  });

  it.serial("rejects runtime-captured code_model switches on unsolved level 1", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-switch-level1-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "agent", "game_ls20", "level_current"), { recursive: true });
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
        "  code_model:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: code seed",
        "mode_state_machine:",
        "  initial_mode: theory",
        "  transitions:",
        "    theory: [explore_and_solve, code_model]",
        "    explore_and_solve: [theory, code_model]",
        "    code_model: [theory]",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRoot, "agent", "game_ls20", "level_current", "meta.json"),
      JSON.stringify({ level: 1, analysis_level_pinned: false }, null, 2),
      "utf8",
    );
    setRuntimeSwitchProviderEvents("switch_mode --target-mode code_model --reason compare_mismatch");
    const { ctx, notifications, createForkCalls } = makeCtx("conversation_level1_code_model");

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      agentBaseDir: path.join("agent", "game_ls20"),
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeDoc("conversation_level1_code_model", "fork_doc"),
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
    expect(createForkCalls.some((call) => call.actionSummary === "agent:switch_mode theory->code_model")).toBe(false);
    const appended = notifications
      .filter((note) => note.method === "conversation.append")
      .map((note) => String(note.params?.markdown ?? ""))
      .join("\n");
    expect(appended).toContain("switch_mode target_mode 'code_model' is not an allowed transition from 'theory'");
  });
});
