import type { UtilityStatus } from "../../supervisor/compile.js";
import type { ToolInterceptionConfig } from "../../supervisor/tool_interception.js";

export type ServerState = {
  workspaceRoot?: string;
  utilities?: UtilityStatus[];
  activeRuns?: Record<string, AbortController>;
  activeRunsByForkId?: Record<string, AbortController>;
  activeRunMeta?: Record<string, { docPath: string; conversationId: string }>;
};

export type SupervisorConfig = {
  enabled?: boolean;
  timeBudgetMs?: number;
  tokenBudgetAdjusted?: number;
  cadenceTimeMs?: number;
  cadenceTokensAdjusted?: number;
  cadenceInterruptPolicy?: "boundary" | "interrupt";
  reviewTimeoutMs?: number;
  contextLimit?: number;
  minRemainingTokens?: number;
  returnControlPattern?: string;
  reviewOverrideJson?: string;
  appendSupervisorJudgements?: boolean;
  disableSyntheticCheckSupervisorOnRuleFailure?: boolean;
  stopCondition?: string;
  contextCarryoverLimitBytes?: number;
  workspaceSubdir?: string;
  agentDefaultSystemMessage?: string;
  toolInterception?: ToolInterceptionConfig;
  pricing?: {
    updatedAt?: string;
    outputUsdPerMillion?: Record<string, number>;
  };
};
