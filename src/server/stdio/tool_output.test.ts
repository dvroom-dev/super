import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NormalizedProviderItem } from "../../providers/types.js";
import { maybeCompactProviderItem } from "./tool_output.js";

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

describe("maybeCompactProviderItem", () => {
  it("offloads nested large text values and records output refs", async () => {
    const workspaceRoot = await makeTempRoot("tool-out-");
    const conversationId = "conv_nested";
    const nestedOutput = "X".repeat(32_000);
    const item: NormalizedProviderItem = {
      provider: "claude",
      kind: "tool_result",
      type: "tool_result",
      summary: "tool_result toolu_1",
      includeInTranscript: true,
      details: {
        result: {
          stdout: nestedOutput,
        },
      },
    };

    const compacted = await maybeCompactProviderItem({
      item,
      workspaceRoot,
      conversationId,
      toolOutput: { maxBytes: 1024, maxLines: 20 },
    });

    expect(compacted.truncated).toBe(true);
    expect(compacted.outputRefs.length).toBeGreaterThan(0);
    const ref = compacted.outputRefs[0];
    expect(ref.path).toContain("details.result.stdout");

    const stdoutValue = (compacted.item.details as any)?.result?.stdout;
    expect(typeof stdoutValue).toBe("string");
    expect(stdoutValue).toBe("");

    const storedFile = path.join(workspaceRoot, ref.filePath);
    const raw = await fs.readFile(storedFile, "utf8");
    expect(raw.length).toBe(nestedOutput.length);
  });

  it("keeps compact items inline when below configured limits", async () => {
    const workspaceRoot = await makeTempRoot("tool-out-");
    const item: NormalizedProviderItem = {
      provider: "codex",
      kind: "tool_result",
      type: "command_execution",
      summary: "tool_result command_execution",
      includeInTranscript: true,
      text: "ok",
      details: { command: "echo ok" },
    };

    const compacted = await maybeCompactProviderItem({
      item,
      workspaceRoot,
      conversationId: "conv_small",
      toolOutput: { maxBytes: 4096, maxLines: 100 },
    });

    expect(compacted.truncated).toBe(false);
    expect(compacted.outputRefs).toEqual([]);
    expect(compacted.item.text).toBe("ok");
  });

  it("keeps full inline strings when offload threshold is not hit", async () => {
    const workspaceRoot = await makeTempRoot("tool-out-");
    const largeText = "Y".repeat(10_000);
    const item: NormalizedProviderItem = {
      provider: "claude",
      kind: "tool_result",
      type: "tool_result",
      summary: "tool_result large-inline",
      includeInTranscript: true,
      text: largeText,
    };

    const compacted = await maybeCompactProviderItem({
      item,
      workspaceRoot,
      conversationId: "conv_clip",
      toolOutput: { maxBytes: 20_000, maxLines: 20_000 },
    });

    expect(compacted.truncated).toBe(false);
    expect(compacted.outputRefs).toEqual([]);
    expect(compacted.item.text).toBe(largeText);
  });
});
