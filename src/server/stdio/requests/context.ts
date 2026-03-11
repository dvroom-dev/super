import type { SupervisorStore } from "../../../store/store.js";
import type { RpcNotificationInput } from "../../../protocol/rpc.js";
import type { ServerState } from "../types.js";

export type RuntimeContext = {
  store: SupervisorStore;
  state: ServerState;
  sendNotification: (note: RpcNotificationInput) => void;
  requireWorkspaceRoot: (params: any) => string;
};
