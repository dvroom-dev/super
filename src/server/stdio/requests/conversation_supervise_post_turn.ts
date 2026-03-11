import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { BudgetState, TurnResult } from "../supervisor/agent_turn.js";
import { maybeApplyInferredSwitchModeFromAssistantText } from "./conversation_supervise_inferred_switch.js";
import { processProviderToolInterceptions } from "./conversation_supervise_provider_tool_interception.js";
import type { StdioContext } from "./context.js";
import type { SupervisorConfig } from "../types.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export async function handlePostTurnInterceptions(args: {
  ctx: StdioContext;
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
  supervisorProviderName: "mock" | "codex" | "claude" | "gemini";
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
  providerName: "mock" | "codex" | "claude" | "gemini";
}) {
  const providerInterception = await processProviderToolInterceptions(args);
  const inferredSwitch = !args.result.toolCalls?.length
    ? await maybeApplyInferredSwitchModeFromAssistantText({
        ctx: args.ctx,
        workspaceRoot: args.workspaceRoot,
        docPath: args.docPath,
        conversationId: args.conversationId,
        activeForkId: args.activeForkId,
        switchActiveFork: args.switchActiveFork,
        renderedRunConfig: args.renderedRunConfig,
        requestAgentRuleRequirements: args.requestAgentRuleRequirements,
        activeMode: args.activeMode,
        allowedNextModes: args.allowedNextModes,
        modePayloadFieldsByMode: args.modePayloadFieldsByMode,
        runConfigPath: args.runConfigPath,
        configBaseDir: args.configBaseDir,
        agentBaseDir: args.agentBaseDir,
        supervisorBaseDir: args.supervisorBaseDir,
        budget: args.budget,
        providerName: args.providerName,
        currentModel: args.currentModel,
        supervisorModel: args.supervisorModel,
        currentSupervisorThreadId: args.currentSupervisorThreadId,
        assistantText: args.result.assistantText,
      })
    : undefined;
  return { providerInterception, inferredSwitch };
}
