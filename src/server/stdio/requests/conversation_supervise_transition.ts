import { handlePostTurnInterceptions } from "./conversation_supervise_post_turn.js";
import type { BudgetState, TurnResult } from "../supervisor/agent_turn.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { SupervisorConfig } from "../types.js";
import type { RuntimeContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export async function applyTurnTransitions(args: {
  ctx: RuntimeContext;
  workspaceRoot: string;
  docPath: string;
  conversationId: string;
  result: TurnResult;
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
  toolConfig: any;
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
}) {
  const { providerInterception } = await handlePostTurnInterceptions(args);
  if (providerInterception.kind === "stop") {
    return {
      kind: "stop" as const,
      currentDocText: providerInterception.currentDocText,
      nextForkId: providerInterception.nextForkId,
      stopReasons: providerInterception.stopReasons,
      stopDetails: providerInterception.stopDetails,
    };
  }
  if (providerInterception.kind === "continue") {
    return {
      kind: "continue" as const,
      currentDocText: providerInterception.currentDocText,
      currentThreadId: providerInterception.currentThreadId,
      currentSupervisorThreadId: providerInterception.currentSupervisorThreadId,
      fullResyncNeeded: providerInterception.fullResyncNeeded,
    };
  }
  return { kind: "none" as const };
}
