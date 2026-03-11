import { createProvider } from "../../../providers/factory.js";
import type { ProviderConfig, ProviderPermissionProfile } from "../../../providers/types.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import { isToolAllowedByPolicy, type CustomToolDefinition } from "../../../tools/definitions.js";
import { combineTranscript } from "../helpers.js";
import { runAgentTurn, type BudgetState, type CadenceHitEvent } from "../supervisor/agent_turn.js";
import { applyConfiguredHooks } from "../supervisor/hook_runtime.js";
import type { SupervisorConfig } from "../types.js";
import type { StdioContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;
type AgentTurnResult = Awaited<ReturnType<typeof runAgentTurn>>;

type RunAgentTurnWithHooksArgs = {
  ctx: StdioContext;
  workspaceRoot: string;
  agentWorkspaceRoot: string;
  docPath: string;
  conversationId: string;
  providerName: "mock" | "codex" | "claude" | "gemini";
  currentModel: string;
  sandboxMode: string;
  permissionProfile: ProviderPermissionProfile;
  skipGitRepoCheck: boolean;
  shouldUseFullPrompt: boolean;
  currentThreadId?: string;
  agentModelReasoningEffort?: string;
  providerOptions?: Record<string, unknown>;
  toolConfig?: NonNullable<RenderedRunConfig>["tools"];
  providerFilesystemPolicy?: ProviderConfig["providerFilesystemPolicy"];
  customTools: CustomToolDefinition[] | undefined;
  compilePrompt: any;
  outputSchema: any;
  effectiveSupervisor: SupervisorConfig;
  budget: BudgetState;
  pricing: SupervisorConfig["pricing"];
  sendBudgetUpdate: () => void;
  toolOutput: any;
  activeRuns: Record<string, AbortController>;
  activeRunsByForkId: Record<string, AbortController>;
  activeForkId: string;
  currentDocText: string;
  fullResyncNeeded: boolean;
  hooks: any[];
  turn: number;
  onCadenceHit?: (event: CadenceHitEvent) => void | Promise<void>;
  onToolBoundary?: () => void;
  onAppendMarkdown?: (markdown: string) => void;
  onAssistantText?: (text: string) => void;
};

type RunAgentTurnWithHooksResult = {
  result: AgentTurnResult;
  nextDocText: string;
  fullResyncNeeded: boolean;
};

const CLAUDE_SWITCH_MODE_PROXY_TOOL: CustomToolDefinition = {
  name: "switch_mode",
  description: "Request an agent mode transition in the harness runtime.",
  command: ["true"],
};

export function providerCustomToolsForTurn(args: {
  providerName: "mock" | "codex" | "claude" | "gemini";
  toolConfig?: NonNullable<RenderedRunConfig>["tools"];
  customTools: CustomToolDefinition[] | undefined;
}): CustomToolDefinition[] | undefined {
  const configured = Array.isArray(args.customTools) ? [...args.customTools] : [];
  if (args.providerName !== "claude") {
    return configured.length ? configured : undefined;
  }
  if (!isToolAllowedByPolicy(args.toolConfig?.builtinPolicy, "switch_mode")) {
    return configured.length ? configured : undefined;
  }
  const hasSwitchModeTool = configured.some((tool) => tool.name === "switch_mode");
  if (!hasSwitchModeTool) configured.push({ ...CLAUDE_SWITCH_MODE_PROXY_TOOL });
  return configured.length ? configured : undefined;
}

export async function runAgentTurnWithHooks(args: RunAgentTurnWithHooksArgs): Promise<RunAgentTurnWithHooksResult> {
  const shellPolicyConfigured = Boolean(args.toolConfig?.shellInvocationPolicy?.disallow?.length);
  const approvalPolicy = args.providerName === "codex" && shellPolicyConfigured ? "on-request" : "never";
  const providerCustomTools = providerCustomToolsForTurn({
    providerName: args.providerName,
    toolConfig: args.toolConfig,
    customTools: args.customTools,
  });
  const provider = createProvider({
    provider: args.providerName,
    model: args.currentModel,
    workingDirectory: args.agentWorkspaceRoot,
    sandboxMode: args.sandboxMode,
    approvalPolicy,
    permissionProfile: args.permissionProfile,
    skipGitRepoCheck: args.skipGitRepoCheck,
    threadId: args.shouldUseFullPrompt ? undefined : args.currentThreadId,
    modelReasoningEffort: args.agentModelReasoningEffort,
    providerOptions: args.providerOptions,
    customTools: providerCustomTools,
    shellInvocationPolicy: args.toolConfig?.shellInvocationPolicy,
    providerFilesystemPolicy: args.providerFilesystemPolicy,
  } as ProviderConfig);

  const controller = new AbortController();
  args.activeRuns[args.docPath] = controller;
  args.activeRunsByForkId[args.activeForkId] = controller;

  let result: AgentTurnResult;
  try {
    result = await runAgentTurn({
      ctx: args.ctx,
      docPath: args.docPath,
      provider,
      prompt: args.compilePrompt,
      outputSchema: args.outputSchema,
      supervisor: args.effectiveSupervisor,
      budget: args.budget,
      currentModel: args.currentModel,
      pricing: args.pricing,
      controller,
      sendBudgetUpdate: args.sendBudgetUpdate,
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      toolOutput: args.toolOutput,
      onCadenceHit: args.onCadenceHit,
      onToolBoundary: args.onToolBoundary,
      onAppendMarkdown: args.onAppendMarkdown,
      onAssistantText: args.onAssistantText,
    });
  } finally {
    try {
      await provider.close?.();
    } catch {
      // best-effort cleanup
    }
  }

  let nextDocText = args.currentDocText;
  if (result.appended.length) {
    nextDocText = combineTranscript(nextDocText, result.appended);
  }

  args.ctx.sendNotification({
    method: "conversation.agent_turn_summary",
    params: {
      turn: args.turn,
      hadError: result.hadError,
      errorMessage: result.errorMessage,
      assistantText: result.assistantText,
    },
  });

  const hookApply = await applyConfiguredHooks({
    hooks: args.hooks ?? [],
    trigger: result.hadError ? "agent_error" : "agent_turn_complete",
    workspaceRoot: args.workspaceRoot,
    currentDocText: nextDocText,
    docPath: args.docPath,
    ctx: args.ctx,
    appendNotifications: true,
  });

  return {
    result,
    nextDocText: hookApply.nextDocText,
    fullResyncNeeded: args.fullResyncNeeded || hookApply.changed,
  };
}

export { processInlineToolCalls } from "./conversation_supervise_inline_tools.js";
