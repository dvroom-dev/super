import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { ProviderName } from "../../../providers/types.js";
import { buildDurableAgentSystemPrompt } from "../../../supervisor/agent_system_prompt.js";
import { resolveModeConfig } from "./mode_runtime.js";
import { resolveConfiguredSystemMessage } from "./system_message_runtime.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export function buildSessionSystemPromptForMode(args: {
  renderedRunConfig: RenderedRunConfig | null;
  mode: string;
  modePayload?: Record<string, string>;
  provider?: ProviderName;
  model?: string;
  agentRules?: string[];
  disableSupervision?: boolean;
}): string {
  const modeConfig = resolveModeConfig(args.renderedRunConfig, args.mode);
  const configuredSystemMessage = resolveConfiguredSystemMessage({
    configuredSystemMessage: modeConfig?.systemMessage ?? args.renderedRunConfig?.systemMessage,
    modePayload: args.modePayload,
  });
  return buildDurableAgentSystemPrompt({
    provider: args.provider ?? args.renderedRunConfig?.runtimeDefaults?.agentProvider,
    model: args.model,
    defaultSystemMessage: args.disableSupervision ? undefined : args.renderedRunConfig?.supervisor?.agentDefaultSystemMessage,
    configuredSystemMessage,
    agentRules: args.agentRules,
  });
}
