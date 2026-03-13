import {
  prepareManagedAgentContext,
  type ContextManagementOverrides,
  type ManagedAgentContextResult,
} from "../../../supervisor/context_management.js";
import { emitContextStats } from "../supervisor/supervise_notifications.js";

export async function buildManagedSuperviseContext(args: {
  documentText: string;
  workspaceRoot: string;
  conversationId: string;
  strategy?: "conservative" | "balanced" | "focused" | "aggressive";
  overrides?: ContextManagementOverrides;
}): Promise<ManagedAgentContextResult> {
  return prepareManagedAgentContext({
    documentText: args.documentText,
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    strategy: args.strategy,
    overrides: args.overrides,
  });
}

export function emitManagedSuperviseContextStats(args: {
  ctx: any;
  docPath: string;
  contextLimit?: number | null;
  sourceBytes: number;
  managedBytes: number;
  managedContext: ManagedAgentContextResult;
  fullPrompt: boolean;
}): void {
  emitContextStats(args.ctx, {
    docPath: args.docPath,
    contextLimit: args.contextLimit ?? null,
    strategy: args.managedContext.stats.strategy ?? null,
    fullPrompt: args.fullPrompt,
    compacted:
      args.managedBytes < args.sourceBytes
      || args.managedContext.stats.offloadedBlocks > 0
      || args.managedContext.stats.trimmedBlocks > 0,
    sourceBytes: args.sourceBytes,
    ...args.managedContext.stats,
  });
}
