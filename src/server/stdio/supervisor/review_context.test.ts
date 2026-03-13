import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildManagedSupervisorReviewContext } from "./review_context.js";

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

describe("buildManagedSupervisorReviewContext", () => {
  it("drops older review blocks to stay under the source byte cap", async () => {
    const workspaceRoot = await makeTempRoot("review-context-");
    const blocks: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      blocks.push("```chat role=assistant");
      blocks.push(`block_${i}: ${"x".repeat(180)}`);
      blocks.push("```");
      blocks.push("");
    }
    const documentText = [
      "---",
      "conversation_id: conv_trim",
      "fork_id: fork_trim",
      "---",
      "",
      "```supervisor_action mode=hard action=continue",
      "summary: prior review",
      "```",
      "",
      ...blocks,
    ].join("\n");

    const managed = await buildManagedSupervisorReviewContext({
      documentText,
      workspaceRoot,
      conversationId: "conv_trim",
      maxSourceBytes: 700,
      maxInlineBytes: 10_000,
      kindsToOffload: ["tool_result"],
    });

    expect(managed.droppedBlocks).toBeGreaterThan(0);
    expect(managed.managedBytes).toBeLessThanOrEqual(700);
    expect(managed.reviewDocumentText).toContain("block_7");
    expect(managed.reviewDocumentText).not.toContain("block_0");
  });

  it("keeps only the latest tail blocks after the last supervisor action", async () => {
    const workspaceRoot = await makeTempRoot("review-context-");
    const blocks: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      blocks.push("```chat role=assistant");
      blocks.push(`tail_block_${i}`);
      blocks.push("```");
      blocks.push("");
    }
    const documentText = [
      "---",
      "conversation_id: conv_tail",
      "fork_id: fork_tail",
      "---",
      "",
      "```supervisor_action mode=hard action=continue",
      "summary: prior review",
      "```",
      "",
      ...blocks,
    ].join("\n");

    const managed = await buildManagedSupervisorReviewContext({
      documentText,
      workspaceRoot,
      conversationId: "conv_tail",
      maxTailBlocks: 4,
      maxSourceBytes: 1024 * 1024,
      maxInlineBytes: 10_000,
      kindsToOffload: ["tool_result"],
    });

    expect(managed.droppedBlocks).toBeGreaterThanOrEqual(6);
    expect(managed.reviewDocumentText).toContain("tail_block_9");
    expect(managed.reviewDocumentText).toContain("tail_block_6");
    expect(managed.reviewDocumentText).not.toContain("tail_block_0");
    expect(managed.reviewDocumentText).not.toContain("tail_block_5");
  });

  it("offloads large chat and tool_result blocks into blob refs", async () => {
    const workspaceRoot = await makeTempRoot("review-context-");
    const largeChat = `chat_payload_${"A".repeat(2500)}`;
    const largeTool = `tool_payload_${"B".repeat(2400)}`;
    const documentText = [
      "---",
      "conversation_id: conv_blob",
      "fork_id: fork_blob",
      "---",
      "",
      "```supervisor_action mode=hard action=continue",
      "summary: prior review",
      "```",
      "",
      "```chat role=assistant",
      largeChat,
      "```",
      "",
      "```tool_result",
      largeTool,
      "```",
      "",
    ].join("\n");

    const managed = await buildManagedSupervisorReviewContext({
      documentText,
      workspaceRoot,
      conversationId: "conv_blob",
      maxSourceBytes: 1024 * 1024,
      maxInlineBytes: 256,
      kindsToOffload: ["chat", "tool_result"],
    });

    expect(managed.offloadedBlocks).toBeGreaterThanOrEqual(2);
    expect(managed.skeletonText).toContain("blob_ref:");
    expect(managed.skeletonText).toContain("line:");
    expect(managed.skeletonText).not.toContain(largeChat.slice(0, 256));
    expect(managed.skeletonText).not.toContain(largeTool.slice(0, 256));
  });

  it("thins tool call/result blocks to one short preview line plus status even when they are small", async () => {
    const workspaceRoot = await makeTempRoot("review-context-");
    const documentText = [
      "```tool_call name=Bash",
      "command: python3 inspect_sequence.py --current-mismatch",
      '{"command":"python3 inspect_sequence.py --current-mismatch"}',
      "```",
      "",
      "```tool_result",
      "status: success",
      "Mismatch at seq_0007 step 8",
      "Open level_current/sequences/seq_0007/step_0008/diff.hex",
      "```",
      "",
    ].join("\n");

    const managed = await buildManagedSupervisorReviewContext({
      documentText,
      workspaceRoot,
      conversationId: "conv_thin",
      maxInlineBytes: 4096,
      kindsToOffload: ["tool_call", "tool_result"],
    });

    expect(managed.skeletonText).toContain("line: python3 inspect_sequence.py --current-mismatch");
    expect(managed.skeletonText).toContain("status: success");
    expect(managed.skeletonText).toContain("line: Mismatch at seq_0007 step 8");
    expect(managed.skeletonText).toContain("blob_ref:");
    expect(managed.skeletonText).not.toContain('{"command":"python3 inspect_sequence.py --current-mismatch"}');
    expect(managed.skeletonText).not.toContain("Open level_current/sequences/seq_0007/step_0008/diff.hex");
  });

  it("caps tool previews below 100 characters", async () => {
    const workspaceRoot = await makeTempRoot("review-context-");
    const longLine = `tool_preview_${"x".repeat(200)}`;
    const documentText = [
      "```tool_result",
      "status: success",
      longLine,
      "```",
      "",
    ].join("\n");

    const managed = await buildManagedSupervisorReviewContext({
      documentText,
      workspaceRoot,
      conversationId: "conv_preview_cap",
      maxInlineBytes: 4096,
      kindsToOffload: ["tool_result"],
    });

    const lineMatch = managed.skeletonText.match(/line:\s+([^\n]+)/);
    expect(lineMatch).not.toBeNull();
    expect(String(lineMatch?.[1] ?? "").length).toBeLessThan(100);
  });

  it("can place blob refs under a caller-provided supervisor workspace", async () => {
    const workspaceRoot = await makeTempRoot("review-context-");
    const blobDir = path.join(workspaceRoot, ".ai-supervisor", "supervisor", "conv_blob_local", "review_blobs");
    const largeTool = `tool_payload_${"C".repeat(2400)}`;
    const documentText = [
      "```supervisor_action mode=hard action=continue",
      "summary: prior review",
      "```",
      "",
      "```tool_result",
      largeTool,
      "```",
      "",
    ].join("\n");

    const managed = await buildManagedSupervisorReviewContext({
      documentText,
      workspaceRoot,
      conversationId: "conv_blob_local",
      maxInlineBytes: 256,
      kindsToOffload: ["tool_result"],
      blobDir,
      blobPathBase: "review_blobs",
    });

    expect(managed.skeletonText).toContain("blob_ref: review_blobs/");
    const blobMatch = managed.skeletonText.match(/blob_ref:\s+(review_blobs\/[^\s]+)/);
    expect(blobMatch).not.toBeNull();
    const blobPath = path.join(path.dirname(blobDir), String(blobMatch?.[1]));
    const raw = await fs.readFile(blobPath, "utf8");
    expect(raw).toContain("tool_payload_");
  });

  it("keeps short explicit tool errors inline for supervisor review", async () => {
    const workspaceRoot = await makeTempRoot("review-context-");
    const documentText = [
      "```tool_result",
      "(ok=false)",
      "",
      "[error]",
      "switch_mode.mode_payload.wrapup_certified is not allowed for mode 'theory'",
      "```",
      "",
    ].join("\n");

    const managed = await buildManagedSupervisorReviewContext({
      documentText,
      workspaceRoot,
      conversationId: "conv_inline_error",
      maxInlineBytes: 4096,
      kindsToOffload: ["tool_result"],
    });

    expect(managed.skeletonText).toContain("(ok=false)");
    expect(managed.skeletonText).toContain("wrapup_certified is not allowed");
    expect(managed.skeletonText).not.toContain("blob_ref:");
  });
});
