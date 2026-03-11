import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { ProviderName } from "../../../providers/types.js";
import { mergeAgentRuleSet, ensureLeadingSystemMessage, resolveActiveMode, resolveModeConfig, resolveModePayload } from "./mode_runtime.js";
import { buildSessionSystemPromptForMode } from "./session_system_prompt.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export function seedDocumentWithSessionSystemPrompt(args: {
  documentText: string;
  renderedRunConfig: RenderedRunConfig | null;
  requestAgentRuleRequirements?: string[];
  provider?: ProviderName;
  model?: string;
  disableSupervision?: boolean;
}): string {
  const activeMode = resolveActiveMode(args.documentText, args.renderedRunConfig);
  const modeConfig = resolveModeConfig(args.renderedRunConfig, activeMode);
  const agentRules = mergeAgentRuleSet({
    requestRequirements: args.requestAgentRuleRequirements,
    configured: modeConfig?.agentRules ?? args.renderedRunConfig?.agentRules,
  }).requirements;
  return ensureLeadingSystemMessage(
    args.documentText,
    buildSessionSystemPromptForMode({
      renderedRunConfig: args.renderedRunConfig,
      mode: activeMode,
      modePayload: resolveModePayload(args.documentText),
      provider: args.provider,
      model: args.model,
      agentRules,
      disableSupervision: args.disableSupervision,
    }),
  );
}
