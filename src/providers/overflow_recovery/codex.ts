import type {
  AgentOverflowRecoveryArgs,
  ProviderOverflowRecovery,
  SupervisorOverflowRecoveryArgs,
  SupervisorPreflightRecoveryArgs,
} from "../provider_overflow_recovery_helpers.js";
import {
  preflightWithProviderCompaction,
  retryWithProviderCompaction,
} from "../provider_overflow_recovery_helpers.js";

export const codexOverflowRecovery: ProviderOverflowRecovery = {
  recoverAgentTurn(args: AgentOverflowRecoveryArgs) {
    return retryWithProviderCompaction({
      retryUsed: args.retryUsed,
      compactThread: args.compactThread,
      reason: "agent_context_overflow",
      logMessage: "agent context overflow: compacted provider thread and retrying (thread={threadId})",
    });
  },

  prepareSupervisorReview<TPromptState>(args: SupervisorPreflightRecoveryArgs<TPromptState>) {
    return preflightWithProviderCompaction<TPromptState>({
      compactThread: args.compactThread,
      reason: args.reason,
    });
  },

  async recoverSupervisorReview<TPromptState>(args: SupervisorOverflowRecoveryArgs<TPromptState>) {
    if (args.retryUsed || typeof args.compactThread !== "function") {
      return { retry: false, retryUsed: args.retryUsed, mode: "none" };
    }
    const compacted = await args.compactThread({ reason: args.reason });
    return {
      retry: Boolean(compacted.compacted),
      retryUsed: true,
      mode: compacted.compacted ? "provider_compaction" : "none",
      threadId: compacted.threadId,
      details: compacted.details,
    };
  },
};
