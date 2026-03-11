import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendRawProviderEvent } from "./raw_event_store.js";

describe("appendRawProviderEvent", () => {
  it("returns undefined when raw payload is absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "raw-event-store-"));
    const result = await appendRawProviderEvent({
      workspaceRoot: root,
      conversationId: "conversation_1",
      provider: "codex",
      item: { provider: "codex", kind: "other", summary: "event" },
      raw: undefined,
    });
    expect(result).toBeUndefined();
  });

  it("appends ndjson records with normalized metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "raw-event-store-"));
    const rel = await appendRawProviderEvent({
      workspaceRoot: root,
      conversationId: "conversation_2",
      provider: "claude",
      item: {
        id: "item_7",
        provider: "claude",
        kind: "tool_result",
        type: "tool_result",
        summary: "tool result",
      },
      raw: { type: "result", subtype: "success" },
    });

    expect(rel).toBe(".ai-supervisor/conversations/conversation_2/raw_events/events.ndjson");
    const abs = path.join(root, rel!);
    const lines = (await fs.readFile(abs, "utf8")).trim().split(/\n/);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.provider).toBe("claude");
    expect(record.item_id).toBe("item_7");
    expect(record.item_kind).toBe("tool_result");
    expect(record.item_type).toBe("tool_result");
    expect(record.item_summary).toBe("tool result");
    expect(record.raw).toEqual({ type: "result", subtype: "success" });
  });
});
