import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { BudgetState } from "../supervisor/agent_turn.js";
import { applyInferredSwitchModeRequestFork } from "./conversation_supervise_switch_mode.js";
import type { RuntimeContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export async function maybeApplyInferredSwitchModeFromAssistantText(args: {
  ctx: RuntimeContext;
  workspaceRoot: string;
  docPath: string;
  conversationId: string;
  activeForkId: string;
  switchActiveFork: (nextForkId: string) => void;
  renderedRunConfig: RenderedRunConfig | null;
  requestAgentRuleRequirements: string[];
  activeMode: string;
  allowedNextModes: string[];
  modePayloadFieldsByMode: Record<string, string[]>;
  runConfigPath?: string;
  configBaseDir: string;
  agentBaseDir: string;
  supervisorBaseDir: string;
  budget: BudgetState;
  providerName: "mock" | "codex" | "claude";
  currentModel: string;
  supervisorModel: string;
  currentSupervisorThreadId?: string;
  assistantText: string;
}) {
  if (!args.assistantText.trim()) return undefined;
  return applyInferredSwitchModeRequestFork({
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
    assistantText: args.assistantText,
    sourceLabel: "agent",
  });
}
