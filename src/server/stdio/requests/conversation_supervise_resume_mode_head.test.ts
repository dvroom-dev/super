import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleConversationSupervise } from "./conversation_supervise.js";
import { applySupervisorForkDecision } from "./conversation_supervise_inline_mode_helpers.js";
import { resolveModePayload } from "../supervisor/mode_runtime.js";

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

function makeModeDoc(args: {
  conversationId: string;
  forkId: string;
  mode: string;
  userMessage: string;
}): string {
  return [
    "---",
    `conversation_id: ${args.conversationId}`,
    `fork_id: ${args.forkId}`,
    `mode: ${args.mode}`,
    "---",
    "",
    "```chat role=user",
    args.userMessage,
    "```",
  ].join("\n");
}

async function writeModeConfig(workspaceRoot: string, implementTransitions: string): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
    [
      "supervisor:",
      "  stop_condition: task complete",
      "modes:",
      "  init:",
      "    user_message:",
      "      operation: append",
      "      parts:",
      "        - literal: init seed",
      "  implement:",
      "    user_message:",
      "      operation: append",
      "      parts:",
      "        - literal: implement seed",
      "mode_state_machine:",
      "  initial_mode: implement",
      "  transitions:",
      `    implement: ${implementTransitions}`,
      "    init: [init, implement]",
    ].join("\n"),
    "utf8",
  );
}

function makeResumeOverride(
  mode = "init",
  modePayload?: Record<string, string>,
  transitionPayload?: Record<string, string>,
): string {
  return JSON.stringify({
    decision: "resume_mode_head",
    payload: {
      mode,
      mode_payload: modePayload ?? {},
      message: "resume handoff",
      message_type: "system",
      wait_for_boundary: false,
    },
    mode_assessment: {
      current_mode_stop_satisfied: true,
      candidate_modes_ranked: [
        { mode, confidence: "high", evidence: "Resume prior mode context." },
      ],
      recommended_action: "resume_mode_head",
    },
    transition_payload: transitionPayload ?? null,
    reasoning: "",
    agent_model: null,
  });
}

type SeedFork = {
  id: string;
  mode: string;
  createdAt: string;
  userMessage: string;
  providerThreadId?: string;
  supervisorThreadId?: string;
  parentId?: string;
  agentRules?: string[];
};

function makeCtx(args: {
  conversationId: string;
  seedForks: SeedFork[];
}) {
  const notifications: any[] = [];
  const createForkCalls: any[] = [];
  const forkMap = new Map<string, any>();
  const forkOrder: string[] = [];

  for (const seed of args.seedForks) {
    forkMap.set(seed.id, {
      id: seed.id,
      parentId: seed.parentId,
      createdAt: seed.createdAt,
      storage: "snapshot",
      documentText: makeModeDoc({
        conversationId: args.conversationId,
        forkId: seed.id,
        mode: seed.mode,
        userMessage: seed.userMessage,
      }),
      agentRules: seed.agentRules ?? [],
      providerThreadId: seed.providerThreadId,
      supervisorThreadId: seed.supervisorThreadId,
    });
    forkOrder.push(seed.id);
  }

  const forkIdFromDocument = (documentText: string): string | undefined => {
    const match = String(documentText ?? "").match(/^\s*fork_id\s*:\s*(.+)\s*$/m);
    return match ? String(match[1] ?? "").trim() : undefined;
  };

  const indexForks = () =>
    forkOrder.map((forkId) => {
      const fork = forkMap.get(forkId);
      return {
        id: fork.id,
        parentId: fork.parentId,
        createdAt: fork.createdAt,
        label: fork.id,
        storage: "snapshot",
        agentRules: fork.agentRules ?? [],
        providerThreadId: fork.providerThreadId,
        supervisorThreadId: fork.supervisorThreadId,
      };
    });

  const indexHeads = () => {
    const forks = indexForks();
    const parentIds = new Set(
      forks
        .map((fork) => fork.parentId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    return forks.filter((fork) => !parentIds.has(fork.id)).map((fork) => fork.id);
  };

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
        return args.conversationId;
      },
      async loadIndex() {
        const forks = indexForks();
        const headIds = indexHeads();
        const headId = headIds.length ? headIds[headIds.length - 1] : undefined;
        return {
          conversationId: args.conversationId,
          headId,
          headIds,
          forks,
        };
      },
      forkIdFromDocument(documentText: string) {
        return forkIdFromDocument(documentText);
      },
      async loadFork(_workspaceRoot: string, _conversationId: string, forkId: string) {
        const fork = forkMap.get(forkId);
        if (!fork) throw new Error(`fork not found: ${forkId}`);
        return fork;
      },
      isHistoryEdited() {
        return true;
      },
      async createFork(call: any) {
        createForkCalls.push(call);
        const id = call.forkId ?? `fork_${createForkCalls.length}`;
        forkMap.set(id, {
          id,
          parentId: call.parentId,
          createdAt: new Date().toISOString(),
          storage: "snapshot",
          documentText: call.documentText,
          agentRules: call.agentRules ?? [],
          providerThreadId: call.providerThreadId,
          supervisorThreadId: call.supervisorThreadId,
        });
        forkOrder.push(id);
        return { id };
      },
    },
  };

  return { ctx, notifications, createForkCalls };
}

describe("conversation.supervise resume_mode_head", () => {
  it.serial("branches from the latest live head in target mode and restores provider/supervisor threads", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-resume-mode-");
    await writeModeConfig(workspaceRoot, "[implement, init]");
    const conversationId = "conversation_resume_mode_head";
    const seedForks: SeedFork[] = [
      {
        id: "fork_init_old",
        mode: "init",
        createdAt: "2026-02-01T00:00:00.000Z",
        userMessage: "old init",
        providerThreadId: "thread_init_old",
        supervisorThreadId: "super_init_old",
      },
      {
        id: "fork_init_stale",
        mode: "init",
        createdAt: "2026-02-02T00:00:00.000Z",
        userMessage: "stale init",
        providerThreadId: "thread_init_stale",
        supervisorThreadId: "super_init_stale",
        parentId: "fork_init_old",
      },
      {
        id: "fork_impl_active",
        mode: "implement",
        createdAt: "2026-02-03T00:00:00.000Z",
        userMessage: "implement now",
        parentId: "fork_init_old",
      },
      {
        id: "fork_init_head",
        mode: "init",
        createdAt: "2026-02-04T00:00:00.000Z",
        userMessage: "latest init",
        providerThreadId: "thread_init_head",
        supervisorThreadId: "super_init_head",
        parentId: "fork_init_stale",
      },
    ];
    const { ctx, createForkCalls } = makeCtx({ conversationId, seedForks });

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeModeDoc({
        conversationId,
        forkId: "fork_impl_active",
        mode: "implement",
        userMessage: "continue implement",
      }),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      supervisorModel: "mock-supervisor",
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
        reviewOverrideJson: makeResumeOverride("init"),
      },
    });

    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
    const resumeFork = createForkCalls[1];
    expect(resumeFork.parentId).toBe("fork_init_head");
    expect(resumeFork.providerThreadId).toBe("thread_init_head");
    expect(resumeFork.supervisorThreadId).toBeUndefined();
    expect(resumeFork.actionSummary).toBe("resume_mode_head (hard)");
    const forkDoc = String(resumeFork.documentText ?? "");
    expect(forkDoc).toContain("mode: init");
    expect(forkDoc).toContain("```chat role=system");
    expect(forkDoc).toContain("resume handoff");
  });

  it.serial("persists resume_mode_head mode payload without rewinding the supervisor thread", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-resume-mode-payload-");
    await writeModeConfig(workspaceRoot, "[implement, init]");
    const conversationId = "conversation_resume_mode_payload";
    const { ctx, createForkCalls } = makeCtx({
      conversationId,
      seedForks: [
        {
          id: "fork_init_head",
          mode: "init",
          createdAt: "2026-02-04T00:00:00.000Z",
          userMessage: "latest init",
          providerThreadId: "thread_init_head",
          supervisorThreadId: "super_init_head",
        },
        {
          id: "fork_impl_active",
          mode: "implement",
          createdAt: "2026-02-05T00:00:00.000Z",
          userMessage: "implement now",
          parentId: "fork_init_head",
        },
      ],
    });

    const result = await applySupervisorForkDecision({
      ctx,
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      conversationId,
      activeForkId: "fork_impl_active",
      switchActiveFork: () => {},
      renderedRunConfig: null,
      runConfigPath: path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      configBaseDir: workspaceRoot,
      agentBaseDir: path.join(workspaceRoot, "agent"),
      supervisorBaseDir: path.join(workspaceRoot, ".ai-supervisor", "supervisor"),
      requestAgentRuleRequirements: [],
      activeMode: "implement",
      allowedNextModes: ["implement", "init"],
      review: JSON.parse(makeResumeOverride("init", { phase_ticket: "alpha" })),
      reasonLabel: "resume",
      detailLabel: "metadata",
      startedAt: Date.now(),
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
      providerName: "claude",
      currentModel: "claude-test",
      supervisorModel: "codex-test",
      currentDocText: makeModeDoc({
        conversationId,
        forkId: "fork_impl_active",
        mode: "implement",
        userMessage: "implement now",
      }),
      currentThreadId: "thread_impl",
      currentSupervisorThreadId: "super_impl",
    });

    expect(result).toBeDefined();
    expect(createForkCalls.length).toBe(2);
    const resumedForkCall = createForkCalls[1];
    expect(resumedForkCall?.supervisorThreadId).toBe("super_impl");
    expect(resolveModePayload(String(resumedForkCall?.documentText ?? ""))).toEqual({ phase_ticket: "alpha" });
    expect(result?.activeTransitionPayload).toEqual({});
  });

  it.serial("returns transition payload metadata when resuming an existing mode head", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-resume-transition-payload-");
    await writeModeConfig(workspaceRoot, "[implement, init]");
    const conversationId = "conversation_resume_transition_payload";
    const { ctx } = makeCtx({
      conversationId,
      seedForks: [
        {
          id: "fork_init_head",
          mode: "init",
          createdAt: "2026-02-04T00:00:00.000Z",
          userMessage: "latest init",
          providerThreadId: "thread_init_head",
          supervisorThreadId: "super_init_head",
        },
        {
          id: "fork_impl_active",
          mode: "implement",
          createdAt: "2026-02-05T00:00:00.000Z",
          userMessage: "implement now",
          parentId: "fork_init_head",
        },
      ],
    });

    const result = await applySupervisorForkDecision({
      ctx,
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      conversationId,
      activeForkId: "fork_impl_active",
      switchActiveFork: () => {},
      renderedRunConfig: null,
      runConfigPath: path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      configBaseDir: workspaceRoot,
      agentBaseDir: path.join(workspaceRoot, "agent"),
      supervisorBaseDir: path.join(workspaceRoot, ".ai-supervisor", "supervisor"),
      requestAgentRuleRequirements: [],
      activeMode: "implement",
      allowedNextModes: ["implement", "init"],
      review: JSON.parse(makeResumeOverride("init", { phase_ticket: "alpha" }, { release_ticket: "rel-1" })),
      reasonLabel: "resume",
      detailLabel: "metadata",
      startedAt: Date.now(),
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
      providerName: "claude",
      currentModel: "claude-test",
      supervisorModel: "codex-test",
      currentDocText: makeModeDoc({
        conversationId,
        forkId: "fork_impl_active",
        mode: "implement",
        userMessage: "implement now",
      }),
      currentThreadId: "thread_impl",
      currentSupervisorThreadId: "super_impl",
    });

    expect(result?.activeTransitionPayload).toEqual({ release_ticket: "rel-1" });
  });

  it.serial("continues to resume prior mode history instead of forcing a fresh fork", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-level-boundary-");
    await writeModeConfig(workspaceRoot, "[implement, init]");

    const conversationId = "conversation_resume_mode_head_level_boundary";
    const seedForks: SeedFork[] = [
      {
        id: "fork_init_old",
        mode: "init",
        createdAt: "2026-02-01T00:00:00.000Z",
        userMessage: "old init",
        providerThreadId: "thread_init_old",
        supervisorThreadId: "super_init_old",
      },
      {
        id: "fork_impl_active",
        mode: "implement",
        createdAt: "2026-02-03T00:00:00.000Z",
        userMessage: "implement now",
        parentId: "fork_init_old",
      },
      {
        id: "fork_init_head",
        mode: "init",
        createdAt: "2026-02-04T00:00:00.000Z",
        userMessage: "latest init",
        providerThreadId: "thread_init_head",
        supervisorThreadId: "super_init_head",
        parentId: "fork_init_old",
      },
    ];
    const { ctx, createForkCalls } = makeCtx({ conversationId, seedForks });

    const result = await applySupervisorForkDecision({
      ctx,
      workspaceRoot,
      docPath: path.join(workspaceRoot, ".ctxs", "session.md"),
      conversationId,
      activeForkId: "fork_impl_active",
      switchActiveFork: () => {},
      renderedRunConfig: null,
      runConfigPath: path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      configBaseDir: workspaceRoot,
      agentBaseDir: path.join(workspaceRoot, "agent"),
      supervisorBaseDir: path.join(workspaceRoot, ".ai-supervisor", "supervisor"),
      requestAgentRuleRequirements: [],
      activeMode: "implement",
      allowedNextModes: ["implement", "init"],
      review: JSON.parse(makeResumeOverride("init")),
      reasonLabel: "boundary",
      detailLabel: "level advanced",
      startedAt: Date.now(),
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
      providerName: "claude",
      currentModel: "claude-test",
      supervisorModel: "codex-test",
      currentDocText: makeModeDoc({
        conversationId,
        forkId: "fork_impl_active",
        mode: "implement",
        userMessage: "implement now",
      }),
      currentThreadId: "thread_impl",
      currentSupervisorThreadId: "super_impl",
    });

    expect(result).toBeDefined();
    expect(createForkCalls.length).toBe(2);
    const resumedForkCall = createForkCalls[1];
    expect(resumedForkCall?.parentId).toBe("fork_init_head");
    expect(resumedForkCall?.providerThreadId).toBe("thread_init_head");
    expect(resumedForkCall?.supervisorThreadId).toBe("super_impl");
    expect(String(resumedForkCall?.documentText ?? "")).toContain("latest init");
  });

  it.serial("resumes the latest historical fork in the requested mode even when it is not a current head", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-resume-mode-");
    await writeModeConfig(workspaceRoot, "[implement, init]");
    const conversationId = "conversation_resume_mode_missing";
    const { ctx, createForkCalls, notifications } = makeCtx({
      conversationId,
      seedForks: [
        {
          id: "fork_init_old",
          mode: "init",
          createdAt: "2026-02-01T00:00:00.000Z",
          userMessage: "old init",
        },
        {
          id: "fork_impl_active",
          mode: "implement",
          createdAt: "2026-02-03T00:00:00.000Z",
          userMessage: "implement now",
          parentId: "fork_init_old",
        },
      ],
    });

    const result = await handleConversationSupervise(ctx, {
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      documentText: makeModeDoc({
        conversationId,
        forkId: "fork_impl_active",
        mode: "implement",
        userMessage: "continue implement",
      }),
      models: ["mock-model"],
      provider: "mock",
      supervisorProvider: "mock",
      supervisorModel: "mock-supervisor",
      cycleLimit: 1,
      supervisor: {
        enabled: true,
        stopCondition: "task complete",
        reviewOverrideJson: makeResumeOverride("init"),
      },
    });

    expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
    const resumeFork = createForkCalls[createForkCalls.length - 1];
    expect(resumeFork?.parentId).toBe("fork_init_old");
    const forkDoc = String(resumeFork?.documentText ?? "");
    expect(forkDoc).toContain("mode: init");
    expect(forkDoc).toContain("old init");
    expect(forkDoc).toContain("resume handoff");
    expect(resumeFork?.providerThreadId).toBeUndefined();
    expect(resumeFork?.supervisorThreadId).toBeUndefined();
    expect(result.stopReasons).toEqual(["cycle_limit"]);
    expect(notifications.some((note) => note.method === "fork.created")).toBe(true);
  });

  it.serial("checkpoints the mode being left so later cross-mode resume restores live explore context", async () => {
    const workspaceRoot = await makeTempRoot("conv-supervise-resume-mode-");
    await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      [
        "supervisor:",
        "  stop_condition: task complete",
        "modes:",
        "  explore_game:",
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
        "  initial_mode: explore_game",
        "  transitions:",
        "    explore_game: [explore_game, code_model]",
        "    code_model: [code_model, explore_game]",
      ].join("\n"),
      "utf8",
    );

    const conversationId = "conversation_resume_mode_checkpoint";
    const { ctx, createForkCalls } = makeCtx({
      conversationId,
      seedForks: [
        {
          id: "fork_explore_seed",
          mode: "explore_game",
          createdAt: "2026-02-01T00:00:00.000Z",
          userMessage: "explore seed",
        },
      ],
    });

    const exploreLiveDoc = [
      makeModeDoc({
        conversationId,
        forkId: "fork_explore_seed",
        mode: "explore_game",
        userMessage: "explore seed",
      }),
      "",
      "```chat role=assistant",
      "I already probed the target state and found a narrow next step.",
      "```",
      "",
      "```tool_call name=Bash",
      "{}",
      "```",
      "",
      "```tool_result",
      "summary: prior targeted probe output",
      "```",
    ].join("\n");

    const exploreToCode = await applySupervisorForkDecision({
      ctx: ctx as any,
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      conversationId,
      activeForkId: "fork_explore_seed",
      switchActiveFork: () => {},
      renderedRunConfig: null,
      runConfigPath: path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      configBaseDir: workspaceRoot,
      agentBaseDir: workspaceRoot,
      supervisorBaseDir: workspaceRoot,
      requestAgentRuleRequirements: [],
      activeMode: "explore_game",
      allowedNextModes: ["code_model"],
      review: {
        decision: "resume_mode_head",
        payload: {
          mode: "code_model",
          message: "repair parity in code_model",
          message_type: "user",
        },
      } as any,
      reasonLabel: "test",
      detailLabel: "checkpoint explore before switching",
      startedAt: Date.now(),
      budget: { adjustedTokensUsed: 0 } as any,
      providerName: "mock",
      currentModel: "mock-model",
      supervisorModel: "mock-supervisor",
      currentDocText: exploreLiveDoc,
      currentThreadId: "thread_explore_live",
      currentSupervisorThreadId: "super_explore_live",
      currentAssistantText: "I already probed the target state and found a narrow next step.",
    });

    expect(exploreToCode).toBeDefined();
    expect(createForkCalls.length).toBeGreaterThanOrEqual(2);
    const checkpointFork = createForkCalls[0];
    expect(checkpointFork.actionSummary).toBe("mode checkpoint");
    expect(checkpointFork.providerThreadId).toBe("thread_explore_live");
    expect(String(checkpointFork.documentText ?? "")).toContain("prior targeted probe output");

    const codeForkCall = createForkCalls[1];
    const codeForkId = String(codeForkCall.forkId ?? "");
    const codeDoc = String(codeForkCall.documentText ?? "");

    const codeLiveDoc = [
      codeDoc,
      "",
      "```chat role=assistant",
      "Model parity is clean; next probe should test completion from the target state.",
      "```",
    ].join("\n");

    const codeToExplore = await applySupervisorForkDecision({
      ctx: ctx as any,
      workspaceRoot,
      docPath: path.join(workspaceRoot, "session.md"),
      conversationId,
      activeForkId: codeForkId,
      switchActiveFork: () => {},
      renderedRunConfig: null,
      runConfigPath: path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
      configBaseDir: workspaceRoot,
      agentBaseDir: workspaceRoot,
      supervisorBaseDir: workspaceRoot,
      requestAgentRuleRequirements: [],
      activeMode: "code_model",
      allowedNextModes: ["explore_game"],
      review: {
        decision: "resume_mode_head",
        payload: {
          mode: "explore_game",
          message: "probe completion with one action",
          message_type: "user",
        },
      } as any,
      reasonLabel: "test",
      detailLabel: "resume explore from checkpoint",
      startedAt: Date.now(),
      budget: { adjustedTokensUsed: 0 } as any,
      providerName: "mock",
      currentModel: "mock-model",
      supervisorModel: "mock-supervisor",
      currentDocText: codeLiveDoc,
      currentThreadId: "thread_code_live",
      currentSupervisorThreadId: "super_code_live",
      currentAssistantText: "Model parity is clean; next probe should test completion from the target state.",
    });

    expect(codeToExplore).toBeDefined();
    expect(codeToExplore?.threadId).toBe("thread_explore_live");
    expect(codeToExplore?.supervisorThreadId).toBe("super_code_live");
    expect(codeToExplore?.docText).toContain("prior targeted probe output");
    expect(codeToExplore?.docText).toContain("probe completion with one action");
    const resumedExploreFork = createForkCalls.at(-1);
    expect(resumedExploreFork?.actionSummary).toBe("resume_mode_head (hard)");
  });
});
