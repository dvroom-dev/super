import type { RuntimeContext } from "./context.js";

export async function handleConversationStop(ctx: RuntimeContext, params: any) {
  const docPath = String((params as any)?.docPath ?? "");
  const forkId = String((params as any)?.forkId ?? "");
  if (!docPath && !forkId) throw new Error("docPath or forkId required");
  const runs = ctx.state.activeRuns;
  const runsByFork = ctx.state.activeRunsByForkId;
  let controller: AbortController | undefined;
  if (forkId) {
    controller = runsByFork ? runsByFork[forkId] : undefined;
  } else if (docPath) {
    controller = runs ? runs[docPath] : undefined;
  }
  if (controller) {
    controller.abort();
    ctx.sendNotification({ method: "conversation.status", params: { message: "stop requested" } });
    return { stopped: true };
  }
  return { stopped: false };
}
