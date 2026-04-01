export type FluxSessionType = "solver" | "modeler" | "bootstrapper";

export type FluxSessionScope = "per_attempt" | "run";
export type FluxResumePolicy = "never" | "always";

export type FluxCommandSpec = {
  command: string[];
};

export type FluxRuntimeDefaults = {
  provider: string;
  model: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  env: Record<string, string>;
};

export type FluxStorageConfig = {
  fluxRoot: string;
  aiRoot: string;
};

export type FluxOrchestratorConfig = {
  tickMs: number;
  solverPreemptGraceMs: number;
  evidencePollMs: number;
  modelerIdleBackoffMs: number;
  bootstrapperIdleBackoffMs: number;
};

export type FluxProblemConfig = {
  provisionInstance: FluxCommandSpec;
  destroyInstance: FluxCommandSpec;
  observeEvidence: FluxCommandSpec;
  syncModelWorkspace?: FluxCommandSpec;
  rehearseSeedOnModel: FluxCommandSpec;
  replaySeedOnRealGame: FluxCommandSpec;
  mergeEvidence: {
    strategy: "append" | "dedupe_by_fingerprint";
  };
};

export type FluxToolsConfig = {
  builtin: string[];
  custom: Array<{
    name: string;
    command: string[];
    cwd?: string;
  }>;
};

export type FluxWorkerConfig = {
  promptFile: string;
  workingDirectory?: string;
  sessionScope: FluxSessionScope;
  resumePolicy: FluxResumePolicy;
  provider?: string;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  turnTimeoutMs?: number;
};

export type FluxSolverConfig = FluxWorkerConfig & {
  cadenceMs: number;
  queueReplacementGraceMs: number;
  tools: FluxToolsConfig;
};

export type FluxModelerConfig = FluxWorkerConfig & {
  triggers: {
    onNewEvidence: boolean;
    onSolverStopped: boolean;
    periodicMs: number;
  };
  outputSchema: string;
  acceptance: {
    command: string[];
    parseAs: "json";
    continueMessageTemplateFile: string;
  };
};

export type FluxBootstrapperConfig = FluxWorkerConfig & {
  outputSchema: string;
  seedBundlePath: string;
  requireModelRehearsalBeforeFinalize: boolean;
  replay: {
    maxAttemptsPerEvent: number;
    continueMessageTemplateFile: string;
  };
};

export type FluxObservabilityConfig = {
  capturePrompts: boolean;
  captureRawProviderEvents: boolean;
  captureToolCalls: boolean;
  captureToolResults: boolean;
  captureQueueSnapshots: boolean;
  captureTimingMetrics: boolean;
};

export type FluxRetentionConfig = {
  keepAllEvents: boolean;
  keepAllSessions: boolean;
  keepAllAttempts: boolean;
};

export type FluxConfig = {
  schemaVersion: 1;
  runtimeDefaults: FluxRuntimeDefaults;
  storage: FluxStorageConfig;
  orchestrator: FluxOrchestratorConfig;
  problem: FluxProblemConfig;
  solver: FluxSolverConfig;
  modeler: FluxModelerConfig;
  bootstrapper: FluxBootstrapperConfig;
  observability: FluxObservabilityConfig;
  retention: FluxRetentionConfig;
};

export type FluxQueueItem = {
  id: string;
  sessionType: FluxSessionType;
  createdAt: string;
  reason: string;
  dedupeKey?: string;
  payload: Record<string, unknown>;
};

export type FluxProblemInstance = {
  instanceId: string;
  workingDirectory: string;
  promptText?: string;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

export type FluxSeedMetadata = {
  targetFrontierLevel?: number;
  rehearsalStatus?: "not_run" | "passed" | "failed";
  lastModelRehearsalSeedHash?: string;
  lastRealReplaySeedHash?: string;
};

export type FluxMessageRecord = {
  messageId: string;
  ts: string;
  turnIndex: number;
  kind: "system" | "user" | "assistant" | "synthetic_assistant" | "tool_call" | "tool_result" | "status" | "control";
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  providerThreadId?: string;
  synthetic?: boolean;
  sourceEventIds?: string[];
  evidenceWatermark?: string;
};

export type FluxSessionRecord = {
  sessionId: string;
  sessionType: FluxSessionType;
  status: "idle" | "running" | "stopped" | "failed";
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  providerThreadId?: string;
  resumePolicy: FluxResumePolicy;
  sessionScope: FluxSessionScope;
  activeAttemptId?: string;
  lastEventCursor?: string;
  lastEvidenceWatermark?: string;
  stopReason?: string;
  latestAssistantText?: string;
};

export type FluxEvidenceRecord = {
  evidenceId: string;
  ts: string;
  attemptId?: string;
  instanceId?: string;
  fingerprint: string;
  summary: string;
  payload: Record<string, unknown>;
};

export type FluxSeedBundle = {
  version: 1;
  generatedAt: string;
  modelRevisionId?: string;
  evidenceWatermark?: string;
  syntheticMessages: Array<{
    role: "user" | "assistant";
    text: string;
  }>;
  replayPlan: Array<{
    tool: string;
    args: Record<string, unknown>;
  }>;
  assertions: Array<Record<string, unknown>>;
  metadata?: FluxSeedMetadata;
};

export type FluxQueueSnapshot = {
  sessionType: FluxSessionType;
  updatedAt: string;
  items: FluxQueueItem[];
};

export type FluxActiveSessionState = {
  sessionId?: string;
  status: "idle" | "running" | "stopping";
  queueItemId?: string;
  pid?: number;
  attemptId?: string;
  instanceId?: string;
  updatedAt: string;
};

export type FluxRunState = {
  version: 1;
  workspaceRoot: string;
  configPath: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  status: "running" | "stopping" | "stopped";
  stopRequested: boolean;
  active: Record<FluxSessionType, FluxActiveSessionState>;
};

export type FluxEvent = {
  eventId: string;
  ts: string;
  kind: string;
  workspaceRoot: string;
  sessionType?: FluxSessionType;
  sessionId?: string;
  queueItemId?: string;
  summary?: string;
  payload?: Record<string, unknown>;
};
