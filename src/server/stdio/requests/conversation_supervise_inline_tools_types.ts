import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { BudgetState, TurnResult as AgentTurnResult } from "../supervisor/agent_turn.js";
import type { SupervisorConfig } from "../types.js";
import type { RuntimeContext } from "./context.js";

export type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export type ProcessInlineToolCallsArgs = {
  ctx: RuntimeContext;
  workspaceRoot: string;
  agentWorkspaceRoot: string;
  docPath: string;
  conversationId: string;
  result: AgentTurnResult;
  currentDocText: string;
  currentThreadId?: string;
  currentSupervisorThreadId?: string;
  activeForkId: string;
  switchActiveFork: (nextForkId: string) => void;
  fullResyncNeeded: boolean;
  renderedRunConfig: RenderedRunConfig | null;
  runConfigPath?: string;
  configBaseDir: string;
  agentBaseDir: string;
  supervisorBaseDir: string;
  toolConfig?: NonNullable<RenderedRunConfig>["tools"];
  toolOutput: any;
  disableSupervision: boolean;
  effectiveSupervisor: SupervisorConfig;
  requestAgentRuleRequirements: string[];
  effectiveAgentRequirements: string[];
  effectiveAgentViolations: string[];
  effectiveSupervisorInstructions: string[];
  supervisorProviderName: "mock" | "codex" | "claude";
  supervisorModel: string;
  currentModel: string;
  supervisorModelReasoningEffort?: string;
  supervisorProviderOptions?: Record<string, unknown>;
  effectiveSupervisorConfiguredSystemMessage?: any;
  supervisorTriggers?: NonNullable<RenderedRunConfig>["supervisorTriggers"];
  effectiveStopCondition: string;
  activeMode: string;
  allowedNextModes: string[];
  modePayloadFieldsByMode: Record<string, string[]>;
  modeGuidanceByMode: Record<string, { description?: string; startWhen?: string[]; stopWhen?: string[] }>;
  supervisorWorkspaceRoot: string;
  agentsText?: string;
  workspaceListingText?: string;
  taggedFiles: any[];
  openFiles: any[];
  utilities: any;
  skills: any[];
  skillsToInvoke: any[];
  skillInstructions: any[];
  startedAt: number;
  budget: BudgetState;
  providerName: "mock" | "codex" | "claude";
};

export type InlineToolCallOutcome =
  | {
      kind: "continue";
      currentDocText: string;
      currentThreadId?: string;
      currentSupervisorThreadId?: string;
      fullResyncNeeded: boolean;
    }
  | {
      kind: "stop";
      currentDocText: string;
      nextForkId: string;
      stopReasons: string[];
      stopDetails: string[];
    };
