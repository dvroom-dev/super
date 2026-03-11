import type { RuntimeContext } from "./context.js";

export async function handleInitialize(ctx: RuntimeContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  return { ok: true, workspaceRoot, supervisorHome: ctx.store.getSupervisorHome() };
}
