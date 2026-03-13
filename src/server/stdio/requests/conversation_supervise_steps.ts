import { createProvider } from "../../../providers/factory.js";
import type { ProviderConfig, ProviderPermissionProfile } from "../../../providers/types.js";
import { getProviderOverflowRecovery } from "../../../providers/provider_overflow_recovery.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { CustomToolDefinition } from "../../../tools/definitions.js";
import type { PromptContent } from "../../../utils/prompt_content.js";
import { combineTranscript } from "../helpers.js";
import { runAgentTurn, type BudgetState, type CadenceHitEvent } from "../supervisor/agent_turn.js";
import { applyConfiguredHooks } from "../supervisor/hook_runtime.js";
import { looksLikeContextWindowError } from "../supervisor/supervisor_run_helpers.js";
import type { SupervisorConfig } from "../types.js";
import type { RuntimeContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;
type AgentTurnResult = Awaited<ReturnType<typeof runAgentTurn>>;

type RunAgentTurnWithHooksArgs = {
  ctx: RuntimeContext;
  workspaceRoot: string;
  agentWorkspaceRoot: string;
  docPath: string;
  conversationId: string;
  providerName: "mock" | "codex" | "claude";
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
  rebuildPromptForOverflow?: () => Promise<PromptContent>;
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

export async function runAgentTurnWithHooks(args: RunAgentTurnWithHooksArgs): Promise<RunAgentTurnWithHooksResult> {
  const providerCustomTools = Array.isArray(args.customTools) && args.customTools.length > 0
    ? [...args.customTools]
    : undefined;
  const provider = createProvider({
    provider: args.providerName,
    model: args.currentModel,
    workingDirectory: args.agentWorkspaceRoot,
    sandboxMode: args.sandboxMode,
    approvalPolicy: "never",
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
  let overflowRetryUsed = false;
  let currentPrompt = args.compilePrompt;
  const overflowRecovery = getProviderOverflowRecovery(args.providerName);
  try {
    while (true) {
      result = await runAgentTurn({
        ctx: args.ctx,
        docPath: args.docPath,
        provider,
        prompt: currentPrompt,
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
      const shouldRetryWithProviderCompaction =
        !overflowRetryUsed
        && typeof provider.compactThread === "function"
        && result.hadError
        && looksLikeContextWindowError(String(result.errorMessage ?? ""));
      const shouldRetryWithLocalRebuild =
        !overflowRetryUsed
        && result.hadError
        && looksLikeContextWindowError(String(result.errorMessage ?? ""));
      if (!shouldRetryWithProviderCompaction && !shouldRetryWithLocalRebuild) {
        break;
      }
      const recovery = await overflowRecovery.recoverAgentTurn({
        retryUsed: overflowRetryUsed,
        compactThread: provider.compactThread?.bind(provider),
        rebuildPrompt: args.rebuildPromptForOverflow,
      });
      if (!recovery.retry) {
        overflowRetryUsed = recovery.retryUsed;
        break;
      }
      overflowRetryUsed = recovery.retryUsed;
      currentPrompt = recovery.nextPrompt ?? currentPrompt;
      args.ctx.sendNotification({
        method: "log",
        params: {
          level: "info",
          message: recovery.logMessage ?? "agent context overflow: retrying",
        },
      });
    }
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
