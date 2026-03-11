import { describe, expect, it } from "bun:test";
import { persistAgentTurnWithoutSupervisor } from "./no_supervisor_finalize.js";

describe("persistAgentTurnWithoutSupervisor", () => {
  it("persists a post-turn fork, updates frontmatter, and replaces the conversation doc", async () => {
    const notifications: any[] = [];
    const createForkCalls: any[] = [];
    const switched: string[] = [];
    const ctx: any = {
      store: {
        async createFork(args: any) {
          createForkCalls.push(args);
          return { id: args.forkId };
        },
      },
      sendNotification(note: any) {
        notifications.push(note);
      },
    };
    const currentDocText = [
      "---",
      "conversation_id: conversation_1",
      "fork_id: fork_old",
      "---",
      "",
      "```chat role=user",
      "hi",
      "```",
    ].join("\n");

    const result = await persistAgentTurnWithoutSupervisor({
      ctx,
      workspaceRoot: "/tmp/workspace",
      conversationId: "conversation_1",
      currentDocText,
      currentForkId: "fork_old",
      docPath: "/tmp/workspace/session.md",
      agentRules: ["rule_a"],
      providerName: "codex",
      currentModel: "gpt-5.3-codex",
      supervisorModel: "gpt-5.3-codex",
      currentThreadId: "thread_123",
      currentSupervisorThreadId: "super_thread_123",
      switchActiveFork(nextForkId: string) {
        switched.push(nextForkId);
      },
    });

    expect(createForkCalls).toHaveLength(1);
    expect(createForkCalls[0].parentId).toBe("fork_old");
    expect(createForkCalls[0].providerThreadId).toBe("thread_123");
    expect(createForkCalls[0].supervisorThreadId).toBe("super_thread_123");
    expect(switched).toEqual([result.nextForkId]);
    expect(result.nextDocText).toContain("conversation_id: conversation_1");
    expect(result.nextDocText).toContain(`fork_id: ${result.nextForkId}`);

    const forkCreated = notifications.find((n) => n.method === "fork.created");
    expect(forkCreated?.params?.forkId).toBe(result.nextForkId);
    const replace = notifications.find((n) => n.method === "conversation.replace");
    expect(replace?.params?.baseForkId).toBe(result.nextForkId);
    expect(replace?.params?.documentText).toContain(`fork_id: ${result.nextForkId}`);
  });
});
