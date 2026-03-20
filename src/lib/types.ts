export type SuperState = {
  version: 1;
  workspaceRoot: string;
  conversationId: string;
  activeForkId: string;
  activeMode?: string;
  activeProcessStage?: string;
  activeTaskProfile?: string;
  activeModePayload?: Record<string, string>;
  activeTransitionPayload?: Record<string, string>;
  agentProvider: string;
  agentModel: string;
  supervisorProvider: string;
  supervisorModel: string;
  cycleCount: number;
  createdAt: string;
  updatedAt: string;
  lastStopReasons: string[];
  lastStopDetails: string[];
};

export type SuperEvent = {
  event_id: string;
  ts: string;
  kind: string;
  conversation_id?: string;
  fork_id?: string;
  mode?: string;
  summary?: string;
  payload?: Record<string, unknown>;
};

export type CliMode = "new" | "resume" | "status";

export type CliOptions = {
  mode: CliMode;
  workspaceRoot: string;
  configPath?: string;
  configDir?: string;
  agentDir?: string;
  supervisorDir?: string;
  provider: string;
  model: string;
  supervisorProvider?: string;
  supervisorModel?: string;
  cycleLimit?: number;
  outputPath?: string;
  quiet: boolean;
  prompt?: string;
  startMode?: string;
  yolo: boolean;
  disableSupervision: boolean;
  disableHooks: boolean;
  providerExplicit?: boolean;
  modelExplicit?: boolean;
  supervisorProviderExplicit?: boolean;
  supervisorModelExplicit?: boolean;
};
