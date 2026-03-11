export type ForkId = string;

export type ForkStorage = "snapshot" | "patch";

export type ForkPatchOp = {
  op: "equal" | "insert" | "delete";
  lines: string[];
};

export type ForkPatch = {
  ops: ForkPatchOp[];
};

export type ForkMeta = {
  id: ForkId;
  parentId?: ForkId;
  createdAt: string;
  // Human label (derived from last user message or optional user title)
  label: string;
  // Short summary of why this fork exists (supervisor or user derived)
  forkSummary?: string;
  // Storage mode for the fork payload
  storage: ForkStorage;
  // Snapshot content (only when storage === "snapshot")
  documentText?: string;
  // Patch payload (only when storage === "patch")
  patch?: ForkPatch;
  // Hash of parent document (for patch verification)
  baseHash?: string;
  // Hash of this document (for integrity checks)
  docHash?: string;
  // Optional supervisor action history for this fork
  actions?: SupervisorAction[];
  // Summary of latest action (for list views)
  actionSummary?: string;
  // Rules at the time of submission
  agentRules: string[];
  // Provider thread/session id used for continuation (optional)
  providerThreadId?: string;
  // Supervisor provider thread/session id used for continuation (optional)
  supervisorThreadId?: string;
  providerName?: string;
  model?: string;
  agentModel?: string;
  supervisorModel?: string;
};

export type ForkSummary = {
  id: ForkId;
  parentId?: ForkId;
  createdAt: string;
  label: string;
  forkSummary?: string;
  storage: ForkStorage;
  baseHash?: string;
  docHash?: string;
  actions?: SupervisorAction[];
  actionSummary?: string;
  agentRules: string[];
  providerThreadId?: string;
  supervisorThreadId?: string;
  providerName?: string;
  model?: string;
  agentModel?: string;
  supervisorModel?: string;
};

export type ConversationIndex = {
  conversationId: string;
  headId?: ForkId;
  headIds: ForkId[];
  forks: ForkSummary[];
};

export type BudgetSnapshot = {
  timeUsedMs?: number;
  adjustedTokensUsed?: number;
  multiplier?: number;
  modelCost?: number;
  minCost?: number;
  cheapestModel?: string;
  timeBudgetMs?: number;
  tokenBudgetAdjusted?: number;
  cadenceTimeMs?: number;
  cadenceTokensAdjusted?: number;
};

export type SupervisorAction = {
  action: string;
  mode?: "hard" | "soft";
  stopReasons?: string[];
  stopDetails?: string[];
  passed?: boolean;
  violations?: string[];
  unfinishedRules?: string[];
  reasoning?: string;
  critique?: string;
  skillNudge?: string;
  corrected?: boolean;
  agentModel?: string;
  supervisorModel?: string;
  budget?: BudgetSnapshot;
  createdAt: string;
  summary?: string;
};
