import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSupervisorReviewDocument,
  runSupervisorRecoverySummary,
  runSupervisorReview,
} from "./supervisor_run.js";
import { buildSupervisorResponseSchema } from "../../../supervisor/review_schema.js";
import { SupervisorStore } from "../../../store/store.js";

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

function makeDocumentWithSupervisorActions(): string {
  return [
    "---",
    "conversation_id: conv_test",
    "fork_id: fork_test",
    "---",
    "",
    "```chat role=user",
    "Initial user goal",
    "```",
    "",
    "```chat role=assistant",
    "old turn content should be dropped",
    "```",
    "",
    "```supervisor_action mode=hard action=continue",
    "summary: old supervisor action",
    "```",
    "",
    "```chat role=assistant",
    "middle turn content should be dropped",
    "```",
    "",
    "```supervisor_action mode=hard action=continue",
    "summary: most recent completed supervisor turn",
    "```",
    "",
    "```chat role=assistant",
    "latest turn content should stay",
    "```",
    "",
    "```tool_result",
    "summary: latest tool output should stay",
    "```",
    "",
  ].join("\n");
}

function makeValidSupervisorReview(overrides?: Record<string, unknown>): Record<string, unknown> {
  const base = {
    decision: "append_message_and_continue",
    payload: {
      reason: null,
      advice: null,
      agent_rule_checks: null,
      agent_violation_checks: null,
      message: "continue exploring",
      message_template: "custom",
      message_type: null,
      wait_for_boundary: null,
      mode: null,
      mode_payload: null,
    },
    transition_payload: null,
    mode_assessment: {
      current_mode_stop_satisfied: false,
      candidate_modes_ranked: [
        {
          mode: "explore",
          confidence: "medium",
          evidence: "Need additional evidence before mode transition.",
        },
      ],
      recommended_action: "continue",
    },
    reasoning: "ok",
    agent_model: null,
  };
  if (!overrides) return base;
  const out: Record<string, unknown> = { ...base, ...overrides };
  if (overrides.payload && typeof overrides.payload === "object") {
    out.payload = {
      ...(base.payload as Record<string, unknown>),
      ...(overrides.payload as Record<string, unknown>),
    };
  }
  return out;
}

function makeBaseInputs(workspaceRoot: string, conversationId: string) {
  const allowedNextModes = ["explore", "plan"];
  return {
    workspaceRoot,
    conversationId,
    documentText: makeDocumentWithSupervisorActions(),
    assistantText: "latest turn content should stay",
    stopReasons: ["agent_stop"],
    trigger: "agent_yield" as const,
    stopCondition: "task complete",
    currentMode: "explore",
    allowedNextModes,
    modePayloadFieldsByMode: { explore: [], plan: ["hypothesis"] },
    mode: "hard" as const,
    providerName: "mock",
    model: "mock-model",
    supervisorModel: "mock-model",
    responseSchema: buildSupervisorResponseSchema({
      trigger: "agent_yield",
      allowedNextModes,
      modePayloadFieldsByMode: { explore: [], plan: ["hypothesis"] },
    }),
  };
}

function makeHistoryDoc(args: {
  conversationId: string;
  forkId: string;
  mode: string;
  user: string;
  assistant: string;
  toolName?: string;
}): string {
  return [
    "---",
    `conversation_id: ${args.conversationId}`,
    `fork_id: ${args.forkId}`,
    "---",
    "",
    `mode: ${args.mode}`,
    "",
    "```chat role=user",
    args.user,
    "```",
    "",
    "```chat role=assistant",
    args.assistant,
    "```",
    "",
    args.toolName
      ? ["```tool_call name=" + args.toolName, "{}", "```", "", "```tool_result", "ok", "```", ""].join("\n")
      : "",
  ].join("\n");
}

describe("buildSupervisorReviewDocument", () => {
  it("keeps only content after the latest supervisor_action block", () => {
    const doc = makeDocumentWithSupervisorActions();
    const sliced = buildSupervisorReviewDocument(doc);
    expect(sliced).toContain("conversation_id: conv_test");
    expect(sliced).toContain("latest turn content should stay");
    expect(sliced).toContain("latest tool output should stay");
    expect(sliced).not.toContain("old turn content should be dropped");
    expect(sliced).not.toContain("middle turn content should be dropped");
    expect(sliced).not.toContain("most recent completed supervisor turn");
  });

  it("returns original text when there is no supervisor_action block", () => {
    const doc = [
      "---",
      "conversation_id: conv_test",
      "fork_id: fork_test",
      "---",
      "",
      "```chat role=user",
      "No action blocks here",
      "```",
      "",
    ].join("\n");
    expect(buildSupervisorReviewDocument(doc)).toBe(doc);
  });
});

describe("runSupervisorReview", () => {
  it("builds a fresh recovery packet without carryover history or transcript copying", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-recovery-");
    const outcome = await runSupervisorRecoverySummary({
      workspaceRoot,
      conversationId: "conv_recovery",
      documentText: makeDocumentWithSupervisorActions(),
      providerName: "mock",
      model: "mock-model",
      supervisorModel: "mock-model",
      currentMode: "explore_only",
      currentInstruction: "Test the changed overlap state and stop.",
      stopCondition: "Stop after the bounded probe resolves or a novel event appears.",
    });
    expect(outcome.packet.focus).toContain("Test the changed overlap state and stop.");
    const promptPath = path.join(workspaceRoot, outcome.promptLogRel);
    const responsePath = path.join(workspaceRoot, outcome.responseLogRel);
    const prompt = await fs.readFile(promptPath, "utf8");
    const response = JSON.parse(await fs.readFile(responsePath, "utf8")) as {
      relevant_facts: string[];
      current_execution_state: string[];
      do_this_next: string;
      focus: string;
      avoid: string[];
      stop_condition: string | null;
    };
    expect(prompt).toContain("You are writing a fresh compaction recovery packet for the agent.");
    expect(prompt).toContain("The agent will NOT receive prior transcript history, tool calls, or tool results.");
    expect(prompt).toContain("Include a concrete execution cursor");
    expect(prompt).toContain("Current rendered user-mode instruction:");
    expect(prompt).toContain("Test the changed overlap state and stop.");
    expect(response.current_execution_state[0]).toContain("Current mode: explore_only");
    expect(response.current_execution_state).toContain("Current instruction: Test the changed overlap state and stop.");
    expect(response.do_this_next).toContain("Test the changed overlap state and stop.");
    expect(response.avoid).toContain("Do not reconstruct older transcript history.");
    expect(response.stop_condition).toBe("Stop after the bounded probe resolves or a novel event appears.");
  });

  it("keeps the live tail ahead of persisted summaries while preserving focused review context and blob drill-down", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    const store = new SupervisorStore();
    await store.createFork({
      workspaceRoot,
      conversationId: "conv_focus",
      forkId: "fork_a",
      documentText: makeHistoryDoc({
        conversationId: "conv_focus",
        forkId: "fork_a",
        mode: "explore",
        user: "probe the brightened feature",
        assistant: "The latest real-game change is the brightened feature; test it next.",
        toolName: "Read",
      }),
      agentRules: [],
      actionSummary: "supervise:start",
    });
    await store.createFork({
      workspaceRoot,
      conversationId: "conv_focus",
      parentId: "fork_a",
      forkId: "fork_b",
      documentText: makeHistoryDoc({
        conversationId: "conv_focus",
        forkId: "fork_b",
        mode: "theory",
        user: "write the next handoff",
        assistant: "The next step should discriminate between the lit feature and the fallback theory.",
        toolName: "Edit",
      }),
      agentRules: [],
      actionSummary: "mode checkpoint",
    });
    await store.createFork({
      workspaceRoot,
      conversationId: "conv_other",
      forkId: "fork_x",
      documentText: makeHistoryDoc({
        conversationId: "conv_other",
        forkId: "fork_x",
        mode: "recover",
        user: "replay solved path",
        assistant: "Recovery resumed from the known replay plan.",
        toolName: "Bash",
      }),
      agentRules: [],
      actionSummary: "resume_mode_head",
    });

    const outcome = await runSupervisorReview(makeBaseInputs(workspaceRoot, "conv_focus"));
    const promptPath = path.join(workspaceRoot, outcome.promptLogRel);
    const prompt = await fs.readFile(promptPath, "utf8");

    expect(prompt).toContain("Latest Review Priorities");
    expect(prompt).toContain("Incremental Changes Since Last Supervisor Review");
    expect(prompt).toContain("Active Conversation Tail Skeleton");
    expect(prompt).toContain("Run-Wide Supervisor View");
    expect(prompt).toContain("probe the brightened feature");
    expect(prompt).toContain("The latest real-game change is the brightened feature; test it next.");
    expect(prompt).toContain("conv_other");
    expect(prompt).toContain("blob_ref: review_blobs/");

    const tailIdx = prompt.indexOf("## Active Conversation Tail Skeleton");
    const latestIdx = prompt.indexOf("## Latest Review Priorities");
    const deltaIdx = prompt.indexOf("## Incremental Changes Since Last Supervisor Review");
    const runWideIdx = prompt.indexOf("## Run-Wide Supervisor View");
    expect(tailIdx).toBeGreaterThanOrEqual(0);
    expect(latestIdx).toBeGreaterThan(tailIdx);
    expect(latestIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeGreaterThan(latestIdx);
    expect(runWideIdx).toBeGreaterThan(tailIdx);
  });

  it("builds review prompt from the sliced turn context", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    const outcome = await runSupervisorReview(makeBaseInputs(workspaceRoot, "conv_slice"));

    const promptPath = path.join(workspaceRoot, outcome.promptLogRel);
    const prompt = await fs.readFile(promptPath, "utf8");
    expect(prompt).toContain("Latest Review Priorities");
    expect(prompt).toContain("Run-Wide Supervisor View");
    expect(prompt).toContain("Incremental Changes Since Last Supervisor Review");
    expect(prompt).toContain("Active Conversation Tail Skeleton");
    expect(prompt).toContain("latest turn content should stay");
    expect(prompt).not.toContain("old turn content should be dropped");
    expect(prompt).not.toContain("middle turn content should be dropped");
  });

  it("offloads oversized review blocks and logs managed context stats", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    const largeAssistant = `large_assistant_${"Z".repeat(5000)}`;
    const outcome = await runSupervisorReview({
      ...makeBaseInputs(workspaceRoot, "conv_large"),
      documentText: [
        "---",
        "conversation_id: conv_large",
        "fork_id: fork_large",
        "---",
        "",
        "```supervisor_action mode=hard action=continue",
        "summary: previous supervisor action",
        "```",
        "",
        "```chat role=assistant",
        largeAssistant,
        "```",
        "",
      ].join("\n"),
      assistantText: "large block",
    });

    const promptPath = path.join(workspaceRoot, outcome.promptLogRel);
    const prompt = await fs.readFile(promptPath, "utf8");
    expect(prompt).toContain("blob_ref: review_blobs/");
    expect(prompt).not.toContain(largeAssistant.slice(0, 1200));
    const blobMatch = prompt.match(/blob_ref:\s+(review_blobs\/[^\s]+)/);
    expect(blobMatch).not.toBeNull();
    const blobPath = path.join(workspaceRoot, ".ai-supervisor", "supervisor", "conv_large", String(blobMatch?.[1]));
    const blob = await fs.readFile(blobPath, "utf8");
    expect(blob).toContain(largeAssistant.slice(0, 1200));

    const tracePath = path.join(workspaceRoot, outcome.traceLogRel);
    const trace = await fs.readFile(tracePath, "utf8");
    expect(trace).toContain("managed_context");
    expect(trace).toContain("offloaded_blocks=");
    expect(trace).toContain("agent_reasoning=(default)");
    expect(trace).toContain("supervisor_reasoning=(default)");
  });

  it("returns supervisor provider thread id for resume continuity", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    const outcome = await runSupervisorReview({
      ...makeBaseInputs(workspaceRoot, "conv_thread"),
      threadId: "super_thread_existing",
    });
    expect(outcome.threadId).toBe("super_thread_existing");
  });

  it("interrupts an in-flight supervisor review and continues the same thread", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    process.env.MOCK_PROVIDER_RUNONCE_DELAY_MS = "250";
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify(makeValidSupervisorReview());
    try {
      const firstPromise = runSupervisorReview({
        ...makeBaseInputs(workspaceRoot, "conv_linear"),
        threadId: "super_thread_linear",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const secondOutcome = await runSupervisorReview({
        ...makeBaseInputs(workspaceRoot, "conv_linear"),
        threadId: "super_thread_linear",
      });
      const firstOutcome = await firstPromise;
      expect(secondOutcome.threadId).toBe("super_thread_linear");
      expect(firstOutcome.threadId).toBe("super_thread_linear");
      expect(secondOutcome.review.decision).toBe("append_message_and_continue");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_DELAY_MS;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it("treats empty supervisor provider output as a schema validation error", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    process.env.MOCK_PROVIDER_RUNONCE_EMPTY = "1";
    try {
      const outcome = await runSupervisorReview(makeBaseInputs(workspaceRoot, "conv_empty"));
      expect(outcome.parsedOk).toBe(false);
      expect(outcome.error?.message).toContain("schema validation");
      expect(outcome.raw).toContain("response_excerpt");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_EMPTY;
    }
  });

  it("surfaces provider execution failures distinctly from schema validation errors", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    process.env.MOCK_PROVIDER_RUNONCE_ERROR = "mock provider transport failure";
    try {
      const outcome = await runSupervisorReview(makeBaseInputs(workspaceRoot, "conv_provider_failure"));
      expect(outcome.parsedOk).toBe(false);
      expect(outcome.error?.kind).toBe("provider_execution_error");
      expect(outcome.error?.message).toContain("mock provider transport failure");
      expect(outcome.error?.message).not.toContain("schema validation");
      expect(outcome.raw).toContain("\"error_type\": \"provider_execution_error\"");
      expect(outcome.raw).not.toContain("response_excerpt");
      const tracePath = path.join(workspaceRoot, outcome.traceLogRel);
      const trace = await fs.readFile(tracePath, "utf8");
      expect(trace).toContain("provider_failure");
      expect(trace).toContain("kind=provider_execution_error");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_ERROR;
    }
  });

  it("retries non-Claude review turns through provider compaction on context overflow", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    process.env.MOCK_PROVIDER_RUNONCE_ERROR_SEQUENCE = JSON.stringify([
      "maximum context length exceeded",
      "",
    ]);
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify(makeValidSupervisorReview());
    process.env.MOCK_PROVIDER_COMPACTED_THREAD_ID = "mock_review_compacted";
    try {
      const outcome = await runSupervisorReview({
        ...makeBaseInputs(workspaceRoot, "conv_compact_retry"),
        threadId: "mock_review_initial",
      });
      expect(outcome.parsedOk).toBe(true);
      expect(outcome.threadId).toBe("mock_review_compacted");
      expect(outcome.review.decision).toBe("append_message_and_continue");
      const tracePath = path.join(workspaceRoot, outcome.traceLogRel);
      const trace = await fs.readFile(tracePath, "utf8");
      expect(trace).toContain("context_overflow_detected");
      expect(trace).toContain("compaction_result reason=context_overflow_attempt_1 compacted=true");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_ERROR_SEQUENCE;
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
      delete process.env.MOCK_PROVIDER_COMPACTED_THREAD_ID;
    }
  });

  it("treats non-schema JSON output as a schema validation error", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = "{\"ok\":true}";
    try {
      const outcome = await runSupervisorReview(makeBaseInputs(workspaceRoot, "conv_bad_schema"));
      expect(outcome.parsedOk).toBe(false);
      expect(outcome.error?.message).toContain("schema validation");
      expect(outcome.error?.message).toContain("$.decision");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it("retries with schema feedback and succeeds when the second response is valid", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT_SEQUENCE = JSON.stringify([
      "{\"ok\":true}",
      JSON.stringify(makeValidSupervisorReview()),
    ]);
    try {
      const outcome = await runSupervisorReview(makeBaseInputs(workspaceRoot, "conv_retry_success"));
      expect(outcome.parsedOk).toBe(true);
      expect(outcome.error).toBeUndefined();
      expect(outcome.review.decision).toBe("append_message_and_continue");
      const tracePath = path.join(workspaceRoot, outcome.traceLogRel);
      const trace = await fs.readFile(tracePath, "utf8");
      expect(trace).toContain("schema_retry scheduled");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT_SEQUENCE;
    }
  });

  it("accepts advice for rewrite responses", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify(
      makeValidSupervisorReview({
        decision: "rewrite_with_check_supervisor_and_continue",
        payload: {
          advice: "Stop re-running the same command and verify one hypothesis with a minimal action.",
          agent_rule_checks: [],
        },
      }),
    );
    try {
      const outcome = await runSupervisorReview(makeBaseInputs(workspaceRoot, "conv_critique"));
      expect(outcome.parsedOk).toBe(true);
      expect(outcome.error).toBeUndefined();
      expect(
        outcome.review.decision === "rewrite_with_check_supervisor_and_continue"
          ? outcome.review.payload.advice
          : "",
      ).toContain("Stop re-running");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });

  it("applies cadence trigger prompt overrides for soft reviews", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    const outcome = await runSupervisorReview({
      ...makeBaseInputs(workspaceRoot, "conv_cadence_prompt"),
      mode: "soft",
      configuredSystemMessage: {
        operation: "append",
        text: "base-supervisor-override",
      },
      supervisorTriggers: {
        base: {
          supervisorPrompt: {
            operation: "replace",
            text: "base-trigger-override",
            images: [],
            content: [{ type: "text", text: "base-trigger-override" }],
          },
        },
        cadence: {
          supervisorPrompt: {
            operation: "append",
            text: "cadence-trigger-override",
            images: [],
            content: [{ type: "text", text: "cadence-trigger-override" }],
          },
        },
      },
    });
    const promptPath = path.join(workspaceRoot, outcome.promptLogRel);
    const prompt = await fs.readFile(promptPath, "utf8");
    expect(prompt).toContain("base-trigger-override");
    expect(prompt).toContain("base-supervisor-override");
    expect(prompt).toContain("cadence-trigger-override");
  });

  it("rejects rewrite decisions from soft-mode schema", async () => {
    const workspaceRoot = await makeTempRoot("supervisor-run-");
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = JSON.stringify(
      makeValidSupervisorReview({
        decision: "rewrite_with_check_supervisor_and_continue",
        payload: {
          advice: "This should be blocked in soft mode.",
          agent_rule_checks: [],
        },
      }),
    );
    try {
      const outcome = await runSupervisorReview({
        ...makeBaseInputs(workspaceRoot, "conv_soft_rewrite"),
        mode: "soft",
      });
      expect(outcome.parsedOk).toBe(false);
      expect(outcome.error?.message).toContain("schema validation");
      expect(outcome.review.decision).toBe("stop_and_return");
    } finally {
      delete process.env.MOCK_PROVIDER_RUNONCE_TEXT;
    }
  });
});
