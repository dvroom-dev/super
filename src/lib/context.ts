import type { StdioContext } from "../server/stdio/requests/context.ts";
import type { ServerState } from "../server/stdio/types.ts";
import type { RpcNotificationInput } from "../protocol/rpc.ts";
import { SupervisorStore } from "./store.ts";

export function createSuperContext(args: {
  workspaceRoot: string;
  sendNotification: (note: RpcNotificationInput) => void;
}): StdioContext {
  const store = new SupervisorStore();
  const state: ServerState = { workspaceRoot: args.workspaceRoot };
  const requireWorkspaceRoot = (params: any): string => {
    const wr = params?.workspaceRoot ?? state.workspaceRoot;
    if (!wr || typeof wr !== "string") throw new Error("workspaceRoot is required");
    state.workspaceRoot = wr;
    return wr;
  };
  return {
    store,
    state,
    sendNotification: args.sendNotification,
    requireWorkspaceRoot,
  };
}
