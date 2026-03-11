import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareManagedAgentContext } from "./context_management.js";

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

function withFrontmatter(body: string, conversationId = "conversation_ctx"): string {
  return [
    "---",
    `conversation_id: ${conversationId}`,
    "fork_id: fork_ctx",
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

function toolResult(content: string): string {
  return ["```tool_result", content.trim(), "```", ""].join("\n");
}

describe("prepareManagedAgentContext", () => {
  it("offloads large tool_result payloads for agent prompts", async () => {
    const workspace = await makeTempRoot("ctx-mgmt-");
    const conversationId = "conversation_large";
    const largeOutput = "X".repeat(50_000);
    const doc = withFrontmatter(
      [
        "```chat role=user",
        "Run the task",
        "```",
        "",
        toolResult(
          [
            "summary: command_execution large-output",
            "command: cat big.log",
            "status: completed",
            "exit_code: 0",
            "",
            largeOutput,
          ].join("\n"),
        ),
      ].join("\n"),
      conversationId,
    );

    const managed = await prepareManagedAgentContext({
      documentText: doc,
      workspaceRoot: workspace,
      conversationId,
      strategy: "aggressive",
    });

    expect(managed.documentText).toContain("blob_ref: .ai-supervisor/conversations/conversation_large/blobs/");
    expect(managed.stats.offloadedBlocks).toBeGreaterThan(0);
    expect(managed.stats.offloadedBytes).toBeGreaterThan(0);
    expect(managed.documentText).toContain("```supervisor_summary type=context_management");
  });

  it("keeps only recent reasoning snapshots when strategy is aggressive", async () => {
    const workspace = await makeTempRoot("ctx-mgmt-");
    const conversationId = "conversation_snapshots";
    const blocks: string[] = [
      "```chat role=user",
      "Continue",
      "```",
      "",
    ];
    for (let i = 1; i <= 7; i += 1) {
      blocks.push("```tool_call name=reasoning_snapshot");
      blocks.push("{}");
      blocks.push("```");
      blocks.push("");
      blocks.push("```tool_result");
      blocks.push(`snapshot ${i}`);
      blocks.push("```");
      blocks.push("");
    }

    const doc = withFrontmatter(blocks.join("\n"), conversationId);
    const managed = await prepareManagedAgentContext({
      documentText: doc,
      workspaceRoot: workspace,
      conversationId,
      strategy: "aggressive",
    });

    const snapshotCalls = (managed.documentText.match(/```tool_call name=reasoning_snapshot/g) ?? []).length;
    expect(snapshotCalls).toBe(4);
    expect(managed.stats.droppedReasoningSnapshots).toBe(3);
  });

  it("rewrites assistant reasoning chat blocks into reasoning_snapshot tool blocks", async () => {
    const workspace = await makeTempRoot("ctx-mgmt-");
    const conversationId = "conversation_reasoning_rewrite";
    const doc = withFrontmatter(
      [
        "```chat role=user",
        "Continue",
        "```",
        "",
        "```chat role=assistant reasoning=1",
        "Thinking trace line 1",
        "Thinking trace line 2",
        "```",
      ].join("\n"),
      conversationId,
    );

    const managed = await prepareManagedAgentContext({
      documentText: doc,
      workspaceRoot: workspace,
      conversationId,
      strategy: "balanced",
    });

    expect(managed.documentText).not.toContain("```chat role=assistant reasoning=1");
    expect(managed.documentText).toContain("```tool_call name=reasoning_snapshot");
    expect(managed.documentText).toContain("Thinking trace line 1");
  });

  it("keeps balanced context growth bounded across many turns", async () => {
    const workspace = await makeTempRoot("ctx-mgmt-");
    const conversationId = "conversation_budget";
    let doc = withFrontmatter(
      [
        "```chat role=user",
        "Play the level",
        "```",
        "",
      ].join("\n"),
      conversationId,
    );
    const promptSizes: number[] = [];
    let latest = await prepareManagedAgentContext({
      documentText: doc,
      workspaceRoot: workspace,
      conversationId,
      strategy: "balanced",
    });
    for (let turn = 1; turn <= 40; turn += 1) {
      doc = [
        doc.trimEnd(),
        "",
        toolResult(
          [
            "summary: tool_result command_execution python",
            "command: python act.py",
            "status: completed",
            "exit_code: 0",
            "",
            "ok",
          ].join("\n"),
        ),
      ].join("\n");
      latest = await prepareManagedAgentContext({
        documentText: doc,
        workspaceRoot: workspace,
        conversationId,
        strategy: "balanced",
      });
      promptSizes.push(Buffer.byteLength(latest.documentText, "utf8"));
    }

    expect(promptSizes[39] - promptSizes[7]).toBeLessThan(10_000);
    expect(latest.stats.droppedOverflowEvents).toBeGreaterThan(0);
    const toolResultsInPrompt = (latest.documentText.match(/```tool_result/g) ?? []).length;
    expect(toolResultsInPrompt).toBeLessThanOrEqual(24);
  });

  it("aggressive offloads large tool output with blob references", async () => {
    const workspace = await makeTempRoot("ctx-mgmt-");
    const conversationId = "conversation_aggressive_blob";
    const noisyLines = Array.from({ length: 600 }, (_, idx) => `line ${idx + 1}: progress ${"x".repeat(20)}`).join("\n");
    const doc = withFrontmatter(
      [
        "```chat role=user",
        "Run migration",
        "```",
        "",
        toolResult(
          [
            "summary: migration batch",
            "command: psql -f migration.sql",
            "status: completed",
            "exit_code: 0",
            "",
            noisyLines,
          ].join("\n"),
        ),
      ].join("\n"),
      conversationId,
    );

    const managed = await prepareManagedAgentContext({
      documentText: doc,
      workspaceRoot: workspace,
      conversationId,
      strategy: "aggressive",
    });

    expect(managed.documentText).toContain("summary: migration batch");
    expect(managed.documentText).toContain("blob_ref: .ai-supervisor/conversations/conversation_aggressive_blob/blobs/");
    expect(managed.documentText).not.toContain("line 600: progress");
  });
});
