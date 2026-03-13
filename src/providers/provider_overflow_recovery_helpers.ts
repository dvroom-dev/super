import type { PromptContent } from "../utils/prompt_content.js";
import type { ProviderCompactionResult } from "./types.js";

export type OverflowRecoveryMode = "none" | "provider_compaction" | "local_prompt_rebuild";

export type AgentOverflowRecoveryArgs = {
  retryUsed: boolean;
  compactThread?: (options?: { signal?: AbortSignal; reason?: string }) => Promise<ProviderCompactionResult>;
  rebuildPrompt?: () => Promise<PromptContent>;
};

export type AgentOverflowRecoveryResult = {
  retry: boolean;
  retryUsed: boolean;
  mode: OverflowRecoveryMode;
  nextPrompt?: PromptContent;
  threadId?: string;
  details?: string;
  logMessage?: string;
};

export type SupervisorPreflightRecoveryArgs<TPromptState> = {
  reason: string;
  skeletonBytes: number;
  compactThread?: (options?: { signal?: AbortSignal; reason?: string }) => Promise<ProviderCompactionResult>;
  rebuildPrompt?: () => Promise<TPromptState>;
};

export type SupervisorPreflightRecoveryResult<TPromptState> = {
  applied: boolean;
  mode: OverflowRecoveryMode;
  nextPromptState?: TPromptState;
  threadId?: string;
  details?: string;
};

export type SupervisorOverflowRecoveryArgs<TPromptState> = {
  retryUsed: boolean;
  reason: string;
  compactThread?: (options?: { signal?: AbortSignal; reason?: string }) => Promise<ProviderCompactionResult>;
  rebuildPrompt?: () => Promise<TPromptState>;
};

export type SupervisorOverflowRecoveryResult<TPromptState> = {
  retry: boolean;
  retryUsed: boolean;
  mode: OverflowRecoveryMode;
  nextPromptState?: TPromptState;
  threadId?: string;
  details?: string;
};

export type ProviderOverflowRecovery = {
  recoverAgentTurn(args: AgentOverflowRecoveryArgs): Promise<AgentOverflowRecoveryResult>;
  prepareSupervisorReview<TPromptState>(
    args: SupervisorPreflightRecoveryArgs<TPromptState>,
  ): Promise<SupervisorPreflightRecoveryResult<TPromptState>>;
  recoverSupervisorReview<TPromptState>(
    args: SupervisorOverflowRecoveryArgs<TPromptState>,
  ): Promise<SupervisorOverflowRecoveryResult<TPromptState>>;
};

export async function retryWithProviderCompaction(args: {
  retryUsed: boolean;
  compactThread?: (options?: { signal?: AbortSignal; reason?: string }) => Promise<ProviderCompactionResult>;
  reason: string;
  logMessage: string;
}): Promise<AgentOverflowRecoveryResult> {
  if (args.retryUsed || typeof args.compactThread !== "function") {
    return { retry: false, retryUsed: args.retryUsed, mode: "none" };
  }
  const compacted = await args.compactThread({ reason: args.reason });
  if (!compacted.compacted) {
    return {
      retry: false,
      retryUsed: true,
      mode: "provider_compaction",
      threadId: compacted.threadId,
      details: compacted.details,
    };
  }
  return {
    retry: true,
    retryUsed: true,
    mode: "provider_compaction",
    threadId: compacted.threadId,
    details: compacted.details,
    logMessage: args.logMessage.replace("{threadId}", compacted.threadId ?? "unknown"),
  };
}

export async function preflightWithProviderCompaction<TPromptState>(args: {
  compactThread?: (options?: { signal?: AbortSignal; reason?: string }) => Promise<ProviderCompactionResult>;
  reason: string;
}): Promise<SupervisorPreflightRecoveryResult<TPromptState>> {
  if (typeof args.compactThread !== "function") {
    return { applied: false, mode: "none" };
  }
  const compacted = await args.compactThread({ reason: args.reason });
  return {
    applied: Boolean(compacted.compacted),
    mode: compacted.compacted ? "provider_compaction" : "none",
    threadId: compacted.threadId,
    details: compacted.details,
  };
}
