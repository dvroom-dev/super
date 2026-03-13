import type {
  AgentOverflowRecoveryArgs,
  AgentOverflowRecoveryResult,
  ProviderOverflowRecovery,
  SupervisorOverflowRecoveryArgs,
  SupervisorOverflowRecoveryResult,
  SupervisorPreflightRecoveryArgs,
  SupervisorPreflightRecoveryResult,
} from "../provider_overflow_recovery_helpers.js";

async function rebuildPromptForClaudeAgent(args: AgentOverflowRecoveryArgs): Promise<AgentOverflowRecoveryResult> {
  if (args.retryUsed || typeof args.rebuildPrompt !== "function") {
    return { retry: false, retryUsed: args.retryUsed, mode: "none" };
  }
  return {
    retry: true,
    retryUsed: true,
    mode: "local_prompt_rebuild",
    nextPrompt: await args.rebuildPrompt(),
    logMessage: "agent context overflow: rebuilt Claude prompt and retrying",
  };
}

async function rebuildPromptForClaudeSupervisor<TPromptState>(
  args: { retryUsed: boolean; rebuildPrompt?: () => Promise<TPromptState> },
): Promise<SupervisorOverflowRecoveryResult<TPromptState>> {
  if (args.retryUsed || typeof args.rebuildPrompt !== "function") {
    return { retry: false, retryUsed: args.retryUsed, mode: "none" };
  }
  return {
    retry: true,
    retryUsed: true,
    mode: "local_prompt_rebuild",
    nextPromptState: await args.rebuildPrompt(),
  };
}

export const claudeOverflowRecovery: ProviderOverflowRecovery = {
  recoverAgentTurn(args: AgentOverflowRecoveryArgs): Promise<AgentOverflowRecoveryResult> {
    return rebuildPromptForClaudeAgent(args);
  },

  async prepareSupervisorReview<TPromptState>(
    args: SupervisorPreflightRecoveryArgs<TPromptState>,
  ): Promise<SupervisorPreflightRecoveryResult<TPromptState>> {
    if (typeof args.rebuildPrompt !== "function") {
      return { applied: false, mode: "none" };
    }
    return {
      applied: true,
      mode: "local_prompt_rebuild",
      nextPromptState: await args.rebuildPrompt(),
    };
  },

  recoverSupervisorReview<TPromptState>(
    args: SupervisorOverflowRecoveryArgs<TPromptState>,
  ): Promise<SupervisorOverflowRecoveryResult<TPromptState>> {
    return rebuildPromptForClaudeSupervisor(args);
  },
};
