import { newId } from "../../../utils/ids.js";
import { updateFrontmatterForkId } from "./fork_utils.js";
import type { RuntimeContext } from "../requests/context.js";

export async function persistAgentTurnWithoutSupervisor(args: {
  ctx: RuntimeContext;
  workspaceRoot: string;
  conversationId: string;
  currentDocText: string;
  currentForkId: string;
  docPath: string;
  agentRules: string[];
  providerName: string;
  currentModel: string;
  supervisorModel: string;
  currentThreadId?: string;
  currentSupervisorThreadId?: string;
  switchActiveFork: (nextForkId: string) => void;
}): Promise<{ nextForkId: string; nextDocText: string }> {
  const nextForkId = newId("fork");
  const nextDocWithFork = updateFrontmatterForkId(args.currentDocText, args.conversationId, nextForkId);
  const nextFork = await args.ctx.store.createFork({
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    parentId: args.currentForkId,
    forkId: nextForkId,
    documentText: nextDocWithFork,
    agentRules: args.agentRules,
    providerName: args.providerName,
    model: args.currentModel,
    providerThreadId: args.currentThreadId,
    supervisorThreadId: args.currentSupervisorThreadId,
    actionSummary: "agent:turn",
    agentModel: args.currentModel,
    supervisorModel: args.supervisorModel,
  });
  args.ctx.sendNotification({
    method: "fork.created",
    params: { conversationId: args.conversationId, forkId: nextFork.id, headId: nextFork.id },
  });
  args.switchActiveFork(nextFork.id);
  args.ctx.sendNotification({
    method: "conversation.replace",
    params: { docPath: args.docPath, documentText: nextDocWithFork, baseForkId: nextFork.id },
  });
  return { nextForkId: nextFork.id, nextDocText: nextDocWithFork };
}
