import { describe, expect, it } from "bun:test";
import { promptContentFromText } from "../utils/prompt_content.js";
import { getProviderOverflowRecovery } from "./provider_overflow_recovery.js";

describe("provider overflow recovery", () => {
  it("uses local prompt rebuilds for Claude agent overflows", async () => {
    const overflowRecovery = getProviderOverflowRecovery("claude");
    const nextPrompt = promptContentFromText("rebuilt");
    const result = await overflowRecovery.recoverAgentTurn({
      retryUsed: false,
      rebuildPrompt: async () => nextPrompt,
    });

    expect(result.retry).toBe(true);
    expect(result.mode).toBe("local_prompt_rebuild");
    expect(result.nextPrompt).toEqual(nextPrompt);
    expect(result.logMessage).toContain("rebuilt Claude prompt");
  });

  it("does not retry Claude supervisor overflow after local retry was already used", async () => {
    const overflowRecovery = getProviderOverflowRecovery("claude");
    const result = await overflowRecovery.recoverSupervisorReview({
      retryUsed: true,
      reason: "context_overflow_attempt_1",
      rebuildPrompt: async () => ({ prompt: promptContentFromText("unused") }),
    });

    expect(result.retry).toBe(false);
    expect(result.mode).toBe("none");
  });

  it("uses provider compaction for Codex agent overflows", async () => {
    const overflowRecovery = getProviderOverflowRecovery("codex");
    let compactCalls = 0;
    const result = await overflowRecovery.recoverAgentTurn({
      retryUsed: false,
      compactThread: async () => {
        compactCalls += 1;
        return { compacted: true, threadId: "codex_thread_compacted", details: "compacted" };
      },
    });

    expect(compactCalls).toBe(1);
    expect(result.retry).toBe(true);
    expect(result.mode).toBe("provider_compaction");
    expect(result.threadId).toBe("codex_thread_compacted");
  });

  it("uses provider compaction for Codex supervisor preflight", async () => {
    const overflowRecovery = getProviderOverflowRecovery("codex");
    let compactCalls = 0;
    const result = await overflowRecovery.prepareSupervisorReview({
      reason: "preflight_large_skeleton_bytes_131072",
      skeletonBytes: 131072,
      compactThread: async () => {
        compactCalls += 1;
        return { compacted: true, threadId: "codex_supervisor_compacted", details: "compacted" };
      },
    });

    expect(compactCalls).toBe(1);
    expect(result.applied).toBe(true);
    expect(result.mode).toBe("provider_compaction");
    expect(result.threadId).toBe("codex_supervisor_compacted");
  });
});
