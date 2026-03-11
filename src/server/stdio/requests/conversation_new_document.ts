import type { RuntimeContext } from "./context.js";

export async function handleConversationNewDocument(ctx: RuntimeContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  const docPath = String((params as any)?.docPath ?? "untitled");
  const conversationId = ctx.store.newConversationId(docPath);
  const placeholder = [
    "---",
    `conversation_id: ${conversationId}`,
    "fork_id: __FORK_ID__",
    "---",
    "",
    "# Chat",
    "",
    "```chat role=user",
    "",
    "```",
    "",
  ].join("\n");
  const fork = await ctx.store.createFork({
    workspaceRoot,
    conversationId,
    parentId: undefined,
    documentText: placeholder.replace("__FORK_ID__", "pending"),
    agentRules: [],
  });
  const template = placeholder.replace("__FORK_ID__", fork.id);
  await ctx.store.updateFork(workspaceRoot, conversationId, fork.id, { documentText: template, storage: "snapshot" });
  return { conversationId, forkId: fork.id, template };
}
