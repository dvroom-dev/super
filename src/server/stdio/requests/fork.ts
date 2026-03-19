import type { RuntimeContext } from "./context.js";

export async function handleForkList(ctx: RuntimeContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  const conversationId = String((params as any)?.conversationId ?? "");
  if (!conversationId) throw new Error("conversationId required");
  const idx = await ctx.store.loadIndex(workspaceRoot, conversationId);
  return {
    conversationId,
    headId: idx.headId,
    headIds: idx.headIds,
    forks: idx.forks.map((f) => ({
      id: f.id,
      parentId: f.parentId,
      createdAt: f.createdAt,
      label: f.label,
      forkSummary: f.forkSummary,
      actionSummary: f.actionSummary,
    })),
  };
}

export async function handleForkListByDoc(ctx: RuntimeContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  const docPath = String((params as any)?.docPath ?? "");
  const documentText = String((params as any)?.documentText ?? "");
  if (!docPath) throw new Error("docPath required");
  let conversationId: string;
  if (!docPath.startsWith("untitled:")) {
    try {
      conversationId = await ctx.store.conversationIdFromDocPath(workspaceRoot, docPath);
    } catch {
      if (documentText) {
        conversationId = await ctx.store.conversationIdFromDocument(docPath, documentText);
      } else {
        throw new Error("conversation_id frontmatter required");
      }
    }
  } else if (documentText) {
    conversationId = await ctx.store.conversationIdFromDocument(docPath, documentText);
  } else {
    throw new Error("conversation_id frontmatter required");
  }
  const idx = await ctx.store.loadIndex(workspaceRoot, conversationId);
  return {
    conversationId,
    headId: idx.headId,
    headIds: idx.headIds,
    forks: idx.forks.map((f) => ({
      id: f.id,
      parentId: f.parentId,
      createdAt: f.createdAt,
      label: f.label,
      forkSummary: f.forkSummary,
      actionSummary: f.actionSummary,
    })),
  };
}

export async function handleForkTree(ctx: RuntimeContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  const docPath = String((params as any)?.docPath ?? "");
  const documentText = String((params as any)?.documentText ?? "");
  let conversationId = "";
  if (docPath) {
    if (!docPath.startsWith("untitled:")) {
      try {
        conversationId = await ctx.store.conversationIdFromDocPath(workspaceRoot, docPath);
      } catch {
        if (documentText) {
          conversationId = await ctx.store.conversationIdFromDocument(docPath, documentText);
        }
      }
    } else if (documentText) {
      conversationId = await ctx.store.conversationIdFromDocument(docPath, documentText);
    }
  }
  if (!conversationId) {
    conversationId = String((params as any)?.conversationId ?? "");
  }
  if (!conversationId) throw new Error("docPath or conversationId required");
  const idx = await ctx.store.loadIndex(workspaceRoot, conversationId);
  return {
    conversationId,
    headId: idx.headId,
    headIds: idx.headIds,
    forks: idx.forks.map((f) => ({
      id: f.id,
      parentId: f.parentId,
      createdAt: f.createdAt,
      label: f.label,
      forkSummary: f.forkSummary,
      actionSummary: f.actionSummary,
      actions: f.actions,
      model: f.model,
      providerName: f.providerName,
      supervisorProviderName: f.supervisorProviderName,
      agentModel: f.agentModel,
      supervisorModel: f.supervisorModel,
    })),
  };
}

export async function handleForkCheckout(ctx: RuntimeContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  const conversationId = String((params as any)?.conversationId ?? "");
  const forkId = String((params as any)?.forkId ?? "");
  if (!conversationId || !forkId) throw new Error("conversationId and forkId required");
  const fork = await ctx.store.loadFork(workspaceRoot, conversationId, forkId);
  return { fork };
}
