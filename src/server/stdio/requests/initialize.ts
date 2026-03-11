import type { StdioContext } from "./context.js";

export async function handleInitialize(ctx: StdioContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  return { ok: true, workspaceRoot, supervisorHome: ctx.store.getSupervisorHome() };
}
