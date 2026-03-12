import { describe, expect, it } from "bun:test";
import type { AgentProvider, ProviderEvent } from "../../../providers/types.js";
import { promptContentFromText } from "../../../utils/prompt_content.js";
import { runAgentTurn, type BudgetState } from "./agent_turn.js";

function makeBudget(overrides?: Partial<BudgetState>): BudgetState {
  return {
    startedAt: Date.now(),
    timeBudgetMs: 0,
    tokenBudgetAdjusted: 0,
    cadenceTimeMs: 0,
    cadenceTokensAdjusted: 0,
    adjustedTokensUsed: 0,
    budgetMultiplier: 1,
    cadenceAnchorAt: Date.now(),
    cadenceTokensAnchor: 0,
    timeBudgetHit: false,
    tokenBudgetHit: false,
    ...overrides,
  };
}

function providerFromEvents(events: ProviderEvent[]): AgentProvider {
  return {
    async *runStreamed() {
      for (const ev of events) yield ev;
    },
    async runOnce() {
      return { text: "" };
    },
  };
}

describe("runAgentTurn", () => {
  it("appends assistant chat and captures usage/thread ids", async () => {
    const notifications: any[] = [];
    const ctx: any = {
      sendNotification(note: any) {
        notifications.push(note);
      },
    };
    const provider = providerFromEvents([
      { type: "assistant_message", text: "done" },
      { type: "usage", usage: { output_tokens: 7 } },
      { type: "done", threadId: "thread_123" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("hi"),
      supervisor: {},
      budget: makeBudget(),
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
    });

    expect(result.assistantFinal).toBe(true);
    expect(result.streamEnded).toBe(true);
    expect(result.newThreadId).toBe("thread_123");
    expect(result.appended).toHaveLength(1);
    expect(result.appended[0]).toContain("```chat role=assistant");
    expect(result.appended[0]).toContain("done");
    expect(notifications.some((n) => n.method === "conversation.usage")).toBe(true);
  });

  it("converts inline tool-call assistant output into tool_call blocks", async () => {
    const notifications: any[] = [];
    const ctx: any = {
      sendNotification(note: any) {
        notifications.push(note);
      },
    };
    const provider = providerFromEvents([
      {
        type: "assistant_message",
        text: [
          "```tool_call name=shell",
          "{\"cmd\": [\"echo\", \"hi\"]}",
          "```",
        ].join("\n"),
      },
      { type: "done", threadId: "thread_tools" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("run tool"),
      supervisor: {},
      budget: makeBudget(),
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
    });

    expect(result.toolCalls?.map((call) => call.name)).toEqual(["shell"]);
    expect(result.assistantFinal).toBe(true);
    expect(result.streamEnded).toBe(false);
    expect(result.appended[0]).toContain("```tool_call name=shell");
    expect(notifications.some((n) => n.method === "conversation.append")).toBe(true);
  });

  it("captures provider-native switch_mode tool calls for runtime handling", async () => {
    const ctx: any = {
      sendNotification() {},
    };
    const provider = providerFromEvents([
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_call",
          name: "switch_mode",
          summary: "tool_call switch_mode",
        },
        raw: {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "switch_mode",
                input: {
                  target_mode: "solve_model",
                  reason: "code_model complete",
                  mode_payload: { user_message: "handoff" },
                },
              },
            ],
          },
        },
      },
      { type: "done", threadId: "thread_switch_mode" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("switch"),
      supervisor: {},
      budget: makeBudget(),
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
    });

    expect(result.toolCalls?.map((call) => call.name)).toEqual(["switch_mode"]);
    expect(result.toolCalls?.[0]?.args?.target_mode).toBe("solve_model");
    expect(result.toolCalls?.[0]?.args?.mode_payload?.user_message).toBe("handoff");
  });

  it("captures codex app-server style switch_mode tool calls for runtime handling", async () => {
    const ctx: any = {
      sendNotification() {},
    };
    const provider = providerFromEvents([
      {
        type: "provider_item",
        item: {
          provider: "codex",
          kind: "tool_call",
          name: "switch_mode",
          summary: "tool_call switch_mode",
        },
        raw: {
          method: "item/started",
          params: {
            threadId: "thread_1",
            turnId: "turn_1",
            item: {
              type: "toolCall",
              name: "switch_mode",
              arguments: {
                target_mode: "solve_model",
                reason: "code_model complete",
              },
            },
          },
        },
      },
      { type: "done", threadId: "thread_switch_mode_codex" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("switch"),
      supervisor: {},
      budget: makeBudget(),
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
    });

    expect(result.toolCalls?.map((call) => call.name)).toEqual(["switch_mode"]);
    expect(result.toolCalls?.[0]?.args?.target_mode).toBe("solve_model");
    expect(result.toolCalls?.[0]?.args?.reason).toBe("code_model complete");
  });

  it("captures xml-style switch_mode blocks from assistant text", async () => {
    const ctx: any = {
      sendNotification() {},
    };
    const provider = providerFromEvents([
      {
        type: "assistant_message",
        text: [
          "Switching modes now:",
          "<switch_mode>",
          "<target_mode>explore_and_solve</target_mode>",
          "<reason>Theory is complete and a concrete probe is ready.</reason>",
          '<mode_payload>{"user_message":"Probe the cross interaction first."}</mode_payload>',
          "</switch_mode>",
        ].join("\n"),
      },
      { type: "done", threadId: "thread_switch_mode_xml" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("switch"),
      supervisor: {},
      budget: makeBudget(),
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
    });

    expect(result.toolCalls?.map((call) => call.name)).toEqual(["switch_mode"]);
    expect(result.toolCalls?.[0]?.args?.target_mode).toBe("explore_and_solve");
    expect(result.toolCalls?.[0]?.args?.reason).toContain("Theory is complete");
    expect(result.toolCalls?.[0]?.args?.mode_payload?.user_message).toBe("Probe the cross interaction first.");
  });

  it("captures provider tool invocation+response events for interception", async () => {
    const ctx: any = {
      sendNotification() {},
    };
    const provider = providerFromEvents([
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_call",
          name: "Bash",
          summary: "tool_call Bash",
        },
        raw: {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_bash_1",
                name: "Bash",
                input: { command: "arc_repl status 2>&1" },
              },
            ],
          },
        },
      },
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_result",
          name: "tool_result",
          summary: "tool_result toolu_bash_1",
          text: "__ARC_INTERCEPT_IDLE_KEEPALIVE__",
        },
        raw: {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_bash_1",
                content: "__ARC_INTERCEPT_IDLE_KEEPALIVE__",
              },
            ],
          },
        },
      },
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_call",
          name: "Bash",
          summary: "tool_call Bash",
        },
        raw: {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_bash_2",
                name: "Bash",
                input: {
                  command: "switch_mode --target-mode explore_game --reason theory_complete",
                },
              },
            ],
          },
        },
      },
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_result",
          name: "tool_result",
          summary: "tool_result toolu_bash_2",
          text: "{\"ok\":true}",
        },
        raw: {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_bash_2",
                content: "{\"ok\":true}",
              },
            ],
          },
        },
      },
      { type: "done", threadId: "thread_tool_events" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("interception"),
      supervisor: {},
      budget: makeBudget(),
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
    });

    expect(result.providerToolEvents).toEqual([
      {
        when: "invocation",
        toolName: "Bash",
        args: { command: "arc_repl status 2>&1" },
      },
      {
        when: "response",
        toolName: "Bash",
        args: { command: "arc_repl status 2>&1" },
        outputText: "__ARC_INTERCEPT_IDLE_KEEPALIVE__",
      },
      {
        when: "invocation",
        toolName: "Bash",
        args: { command: "switch_mode --target-mode explore_game --reason theory_complete" },
      },
      {
        when: "response",
        toolName: "Bash",
        args: { command: "switch_mode --target-mode explore_game --reason theory_complete" },
        outputText: "{\"ok\":true}",
      },
    ]);
  });

  it("captures bash CLI switch_mode calls for runtime handling", async () => {
    const ctx: any = {
      sendNotification() {},
    };
    const provider = providerFromEvents([
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_call",
          name: "Bash",
          summary: "tool_call Bash",
        },
        raw: {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: {
                  command:
                    "switch_mode --target-mode explore_game --reason theory_complete --user-message probe_next_feature",
                },
              },
            ],
          },
        },
      },
      { type: "done", threadId: "thread_switch_mode_bash" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("switch"),
      supervisor: {},
      budget: makeBudget(),
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
    });

    expect(result.toolCalls?.map((call) => call.name)).toEqual(["switch_mode"]);
    expect(result.toolCalls?.[0]?.args?.target_mode).toBe("explore_game");
    expect(result.toolCalls?.[0]?.args?.reason).toBe("theory_complete");
    expect(result.toolCalls?.[0]?.args?.user_message).toBe("probe_next_feature");
  });

  it("marks cadence on token limit without interrupt in boundary mode", async () => {
    const notifications: any[] = [];
    const ctx: any = {
      sendNotification(note: any) {
        notifications.push(note);
      },
    };
    const budget = makeBudget({ cadenceTokensAdjusted: 5 });
    const provider = providerFromEvents([
      { type: "usage", usage: { output_tokens: 6 } },
      { type: "assistant_message", text: "should not be reached" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("go"),
      supervisor: {},
      budget,
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
    });

    expect(result.interrupted).toBe(false);
    expect(result.cadenceHit).toBe(true);
    expect(result.cadenceReason).toBe("cadence_tokens");
    expect(result.assistantText).toBe("should not be reached");
    expect(result.streamEnded).toBe(true);
    expect(notifications.some((n) => n.method === "conversation.usage")).toBe(true);
  });

  it("interrupts when cadence callback requests interruption", async () => {
    const notifications: any[] = [];
    const ctx: any = {
      sendNotification(note: any) {
        notifications.push(note);
      },
    };
    const budget = makeBudget({ cadenceTokensAdjusted: 5 });
    const provider = providerFromEvents([
      { type: "usage", usage: { output_tokens: 6 } },
      { type: "assistant_message", text: "should not be reached" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("go"),
      supervisor: {},
      budget,
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
      onCadenceHit: ({ requestInterrupt }) => {
        requestInterrupt("cadence_supervisor");
      },
    });

    expect(result.interrupted).toBe(true);
    expect(result.cadenceHit).toBe(true);
    expect(result.cadenceReason).toBe("cadence_tokens");
    expect(result.assistantText).toBe("");
    expect(result.streamEnded).toBe(false);
    expect(notifications.some((n) => n.method === "conversation.usage")).toBe(true);
  });

  it("preserves streamed provider thread id when interrupted before done", async () => {
    const ctx: any = {
      sendNotification() {},
    };
    const budget = makeBudget({ cadenceTokensAdjusted: 5 });
    const provider = providerFromEvents([
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "tool_result",
          summary: "tool_result toolu_live",
        },
        raw: {
          type: "user",
          session_id: "thread_stream_live",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_live",
                content: "ok",
              },
            ],
          },
        },
      },
      { type: "usage", usage: { output_tokens: 6 } },
      { type: "assistant_message", text: "should not be reached" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("go"),
      supervisor: {},
      budget,
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
      onCadenceHit: ({ requestInterrupt }) => {
        requestInterrupt("cadence_supervisor");
      },
    });

    expect(result.interrupted).toBe(true);
    expect(result.streamEnded).toBe(false);
    expect(result.newThreadId).toBe("thread_stream_live");
  });

  it("exposes provider steering through the cadence callback", async () => {
    const steerCalls: string[] = [];
    const ctx: any = {
      sendNotification() {},
    };
    const budget = makeBudget({ cadenceTokensAdjusted: 5 });
    const provider: AgentProvider = {
      async *runStreamed() {
        yield { type: "usage", usage: { output_tokens: 6 } };
        yield { type: "assistant_message", text: "continuing after steer" };
      },
      async runOnce() {
        return { text: "" };
      },
      async steerActiveTurn(prompt) {
        steerCalls.push(String((prompt as any)?.[0]?.text ?? ""));
        return {
          applied: true,
          deferred: false,
          threadId: "thread_live",
          turnId: "turn_live",
        };
      },
    };
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("go"),
      supervisor: {},
      budget,
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
      onCadenceHit: async ({ requestSteer }) => {
        await requestSteer("Supervisor: keep modeling and do not abort.");
      },
    });

    expect(steerCalls).toEqual(["Supervisor: keep modeling and do not abort."]);
    expect(result.interrupted).toBe(false);
    expect(result.assistantText).toBe("continuing after steer");
    expect(result.streamEnded).toBe(true);
  });

  it("interrupts and marks compaction when provider emits a compact boundary", async () => {
    const ctx: any = {
      sendNotification() {},
    };
    const provider = providerFromEvents([
      {
        type: "provider_item",
        item: {
          provider: "claude",
          kind: "system",
          summary: "compact boundary",
        },
        raw: {
          type: "system",
          subtype: "compact_boundary",
        },
      },
      { type: "assistant_message", text: "should not be reached" },
    ]);
    const result = await runAgentTurn({
      ctx,
      docPath: "/tmp/session.md",
      provider,
      prompt: promptContentFromText("go"),
      supervisor: {},
      budget: makeBudget(),
      currentModel: "mock-model",
      controller: new AbortController(),
      sendBudgetUpdate: () => {},
      workspaceRoot: "/tmp/work",
      conversationId: "conversation_1",
    });

    expect(result.compactionDetected).toBe(true);
    expect(result.compactionDetails).toContain("compact");
    expect(result.interrupted).toBe(true);
    expect(result.interruptionReason).toBe("provider_compaction");
    expect(result.streamEnded).toBe(false);
  });
});
