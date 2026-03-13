import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TurnResult } from "./agent_turn.js";
import { appendTurnTelemetry, buildTurnTelemetryBase, loadLastTurnTelemetryTurn } from "./telemetry.js";

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

function makeResult(overrides?: Partial<TurnResult>): TurnResult {
  return {
    appended: [],
    assistantText: "assistant output",
    errorMessage: null,
    assistantFinal: true,
    hadError: false,
    interrupted: false,
    interruptionReason: null,
    abortedBySupervisor: false,
    abortError: false,
    streamEnded: true,
    usage: { input_tokens: 5, output_tokens: 7 },
    cadenceHit: false,
    cadenceReason: null,
    compactionDetected: false,
    compactionDetails: null,
    ...overrides,
  };
}

describe("telemetry", () => {
  it("builds a normalized base turn telemetry record", () => {
    const base = buildTurnTelemetryBase({
      conversationId: "conv_1",
      forkId: "fork_1",
      turn: 3,
      provider: "codex",
      agentModel: "gpt-5.3-codex",
      supervisorModel: "gpt-5.3-codex",
      promptMode: "incremental",
      promptBytes: 1234,
      parseErrors: 2,
      agentReasoningEffort: "low",
      supervisorReasoningEffort: "high",
      contextStrategy: "balanced",
      sourceBytes: 4321,
      managedBytes: 2100,
      contextStats: {
        strategy: "balanced",
        trimmedBlocks: 4,
        droppedItemStartedEvents: 1,
        droppedEmptySuccessfulCommands: 2,
        droppedReasoningSnapshots: 3,
        droppedOverflowEvents: 5,
        offloadedBlocks: 6,
        offloadedBytes: 777,
      },
      result: makeResult({ toolCalls: [{ name: "shell", body: '{"command":"echo ok"}', args: { command: "echo ok" } }] }),
      stopReasons: ["agent_stop"],
      stopDetails: ["agent stopped naturally"],
      adjustedTokensUsed: 999,
      elapsedMs: 2500,
      turnElapsedMs: 400,
      promptBuildMs: 50,
      agentTurnMs: 200,
      inlineToolMs: 25,
      transitionMs: 30,
      finalizeMs: 40,
      supervisorReviewMs: 55,
    });

    expect(base.prompt.mode).toBe("incremental");
    expect(base.prompt.bytes).toBe(1234);
    expect(base.prompt.agentReasoningEffort).toBe("low");
    expect(base.prompt.supervisorReasoningEffort).toBe("high");
    expect(base.context.strategy).toBe("balanced");
    expect(base.context.trimmedBlocks).toBe(4);
    expect(base.agent.assistantBytes).toBeGreaterThan(0);
    expect(base.agent.toolCalls).toBe(1);
    expect(base.stop.reasons).toEqual(["agent_stop"]);
    expect(base.timing.turnElapsedMs).toBe(400);
    expect(base.timing.promptBuildMs).toBe(50);
    expect(base.timing.agentTurnMs).toBe(200);
    expect(base.budget.adjustedTokensUsed).toBe(999);
  });

  it("appends telemetry records and sanitizes usage fields", async () => {
    const root = await makeTempRoot("telemetry-");
    const base = buildTurnTelemetryBase({
      conversationId: "conv_2",
      forkId: "fork_2",
      turn: 1,
      provider: "claude",
      agentModel: "claude-opus-4-6",
      supervisorModel: "claude-opus-4-6",
      promptMode: "full",
      promptBytes: 99,
      parseErrors: 0,
      contextStrategy: "aggressive",
      sourceBytes: 1000,
      managedBytes: 250,
      contextStats: {
        strategy: "aggressive",
        trimmedBlocks: 8,
        droppedItemStartedEvents: 2,
        droppedEmptySuccessfulCommands: 1,
        droppedReasoningSnapshots: 0,
        droppedOverflowEvents: 0,
        offloadedBlocks: 3,
        offloadedBytes: 4096,
      },
      result: makeResult({
        usage: {
          inputTokens: 21,
          completion_tokens: 34,
          totalTokens: 55,
          ignored_field: 999,
        },
      }),
      stopReasons: ["cadence_tokens"],
      stopDetails: ["cadence token limit reached"],
      adjustedTokensUsed: 55,
      elapsedMs: 1200,
      turnElapsedMs: 300,
      promptBuildMs: 20,
      agentTurnMs: 140,
      inlineToolMs: 0,
      transitionMs: 10,
      finalizeMs: 15,
      supervisorReviewMs: 30,
    });

    await appendTurnTelemetry(root, "conv_2", {
      ...base,
      supervisor: {
        triggered: true,
        mode: "soft",
        action: "replace",
        resume: true,
        edits: 1,
        appendEdits: 0,
        replaceEdits: 1,
        blocks: 2,
        violations: 1,
      },
    });

    const telemetryPath = path.join(root, ".ai-supervisor", "conversations", "conv_2", "telemetry", "turns.ndjson");
    const raw = await fs.readFile(telemetryPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]) as any;
    expect(entry.provider).toBe("claude");
    expect(entry.supervisor.triggered).toBe(true);
    expect(entry.timing.turnElapsedMs).toBe(300);
    expect(entry.timing.supervisorReviewMs).toBe(30);
    expect(entry.agent.usage).toEqual({
      input_tokens: 21,
      output_tokens: 34,
      total_tokens: 55,
    });
  });

  it("loads the last recorded turn number from telemetry", async () => {
    const root = await makeTempRoot("telemetry-");
    const base = buildTurnTelemetryBase({
      conversationId: "conv_3",
      forkId: "fork_3",
      turn: 1,
      provider: "claude",
      agentModel: "claude-opus-4-6",
      supervisorModel: "gpt-5.3-codex",
      promptMode: "incremental",
      promptBytes: 42,
      parseErrors: 0,
      contextStrategy: "aggressive",
      sourceBytes: 100,
      managedBytes: 80,
      contextStats: {
        strategy: "aggressive",
        trimmedBlocks: 0,
        droppedItemStartedEvents: 0,
        droppedEmptySuccessfulCommands: 0,
        droppedReasoningSnapshots: 0,
        droppedOverflowEvents: 0,
        offloadedBlocks: 0,
        offloadedBytes: 0,
      },
      result: makeResult(),
      stopReasons: ["agent_stop"],
      stopDetails: ["agent stopped"],
      adjustedTokensUsed: 12,
      elapsedMs: 250,
      turnElapsedMs: 90,
      promptBuildMs: 10,
      agentTurnMs: 40,
      inlineToolMs: 0,
      transitionMs: 5,
      finalizeMs: 12,
      supervisorReviewMs: 0,
    });

    await appendTurnTelemetry(root, "conv_3", {
      ...base,
      turn: 1,
      supervisor: { triggered: false, mode: "none" },
    });
    await appendTurnTelemetry(root, "conv_3", {
      ...base,
      turn: 2,
      forkId: "fork_4",
      supervisor: { triggered: true, mode: "soft", action: "fork", resume: true },
    });

    await fs.appendFile(
      path.join(root, ".ai-supervisor", "conversations", "conv_3", "telemetry", "turns.ndjson"),
      "{not-json}\n",
      "utf8",
    );

    expect(await loadLastTurnTelemetryTurn(root, "conv_3")).toBe(2);
    expect(await loadLastTurnTelemetryTurn(root, "missing_conv")).toBe(0);
  });
});
