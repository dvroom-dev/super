import { SupervisorStore } from "../store/store.ts";
import { applyPatch } from "../store/patch.ts";

export { SupervisorStore };

export async function loadForkDocument(args: {
  store: SupervisorStore;
  workspaceRoot: string;
  conversationId: string;
  forkId: string;
}): Promise<string> {
  const fork = await args.store.loadFork(args.workspaceRoot, args.conversationId, args.forkId);
  if (typeof fork.documentText === "string" && fork.documentText.trim()) return fork.documentText;
  throw new Error(`fork '${args.forkId}' has no reconstructed document text`);
}

export { applyPatch };
