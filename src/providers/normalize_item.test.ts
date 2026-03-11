import { describe, expect, it } from "bun:test";
import {
  normalizeCodexItem,
  normalizeClaudeAssistantMessage,
  normalizeClaudeReasoningMessage,
  normalizeClaudeGenericEvent,
  normalizeClaudeUserMessage,
} from "./normalize_item.js";

describe("normalize provider items", () => {
  it("normalizes codex command results into transcript-safe tool_result items", () => {
    const normalized = normalizeCodexItem({
      id: "item_1",
      type: "command_execution",
      command: "python act.py",
      status: "completed",
      exit_code: 0,
      aggregated_output: "line 1\nline 2",
    });

    expect(normalized.id).toBe("item_1");
    expect(normalized.provider).toBe("codex");
    expect(normalized.kind).toBe("tool_result");
    expect(normalized.text).toContain("line 1");
    expect(normalized.includeInTranscript).toBe(true);
    expect(normalized.details?.command).toBe("python act.py");
  });

  it("keeps codex reasoning items transcript-visible for synthetic snapshots", () => {
    const normalized = normalizeCodexItem({
      id: "item_r",
      type: "reasoning",
      text: "I should refactor this loop first.",
    });

    expect(normalized.kind).toBe("assistant_meta");
    expect(normalized.includeInTranscript).toBe(true);
    expect(normalized.text).toContain("refactor");
  });

  it("normalizes claude assistant tool_use metadata into tool_call items", () => {
    const normalized = normalizeClaudeAssistantMessage({
      id: "msg_1",
      model: "claude-opus-4-6",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "python act.py" },
        },
      ],
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.provider).toBe("claude");
    expect(normalized?.kind).toBe("tool_call");
    expect(normalized?.includeInTranscript).toBe(true);
    expect(normalized?.summary).toContain("tool_call");
  });

  it("normalizes claude reasoning blocks into assistant_meta transcript items", () => {
    const normalized = normalizeClaudeReasoningMessage({
      id: "msg_reasoning",
      content: [
        { type: "thinking", thinking: "Inspect marker interaction first." },
        { type: "text", text: "action follows" },
      ],
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.provider).toBe("claude");
    expect(normalized?.kind).toBe("assistant_meta");
    expect(normalized?.type).toBe("assistant.reasoning");
    expect(normalized?.includeInTranscript).toBe(true);
    expect(normalized?.text).toContain("marker interaction");
  });

  it("preserves redacted thinking markers when explicit reasoning text is unavailable", () => {
    const normalized = normalizeClaudeReasoningMessage({
      content: [{ type: "redacted_thinking" }],
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.text).toBe("[redacted_thinking]");
    expect(normalized?.details?.redacted_thinking).toBe(true);
  });

  it("normalizes claude tool_result blocks and extracts nested text", () => {
    const items = normalizeClaudeUserMessage({
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_abc",
          is_error: false,
          content: [
            { type: "text", text: "stdout: level complete" },
            { type: "text", text: "next level unlocked" },
          ],
        },
      ],
    });

    expect(items.length).toBe(1);
    expect(items[0].provider).toBe("claude");
    expect(items[0].kind).toBe("tool_result");
    expect(items[0].includeInTranscript).toBe(true);
    expect(items[0].text).toContain("stdout: level complete");
    expect(items[0].summary).toContain("tool_result");
  });

  it("normalizes claude system/auth events as transcript-hidden metadata", () => {
    const normalized = normalizeClaudeGenericEvent({
      type: "system",
      subtype: "status",
      status: "running",
      output: ["ok"],
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.provider).toBe("claude");
    expect(normalized?.kind).toBe("system");
    expect(normalized?.includeInTranscript).toBe(false);
  });
});
