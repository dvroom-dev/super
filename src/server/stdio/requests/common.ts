import type { ForkMeta } from "../../../store/types.js";
import type { RuntimeContext } from "./context.js";

export function selectBaseForkId(args: {
  explicitBaseForkId?: string;
  docForkId?: string;
  indexHeadId?: string;
  knownForkIds?: string[];
}): string | undefined {
  const explicitBaseForkId = args.explicitBaseForkId?.trim();
  if (explicitBaseForkId) {
    return explicitBaseForkId;
  }

  const docForkId = args.docForkId?.trim();
  const indexHeadId = args.indexHeadId?.trim();
  const knownForkIds = new Set((args.knownForkIds ?? []).map((id) => String(id).trim()).filter(Boolean));

  if (docForkId && knownForkIds.has(docForkId)) {
    return docForkId;
  }
  if (indexHeadId) {
    return indexHeadId;
  }
  return undefined;
}

export async function loadForkSafe(
  ctx: RuntimeContext,
  workspaceRoot: string,
  conversationId: string,
  forkId: string
): Promise<ForkMeta | undefined> {
  try {
    return await ctx.store.loadFork(workspaceRoot, conversationId, forkId);
  } catch (err: any) {
    ctx.sendNotification({
      method: "log",
      params: { level: "warn", message: `baseForkId not found (${forkId}): ${err?.message ?? err}` },
    });
    return undefined;
  }
}
