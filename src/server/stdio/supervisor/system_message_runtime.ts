import { promptContentFromText } from "../../../utils/prompt_content.js";
import type { RenderedRunConfigMessage } from "../../../supervisor/run_config.js";
import { combineSystemMessages } from "../../../supervisor/run_config_helpers.js";
import { applySupervisorTemplateFieldsToMessage } from "./mode_runtime.js";

type ResolveConfiguredSystemMessageArgs = {
  configuredSystemMessage?: RenderedRunConfigMessage;
  modePayload?: Record<string, string>;
  defaultSystemMessage?: string;
};

export function resolveConfiguredSystemMessage(
  args: ResolveConfiguredSystemMessageArgs,
): RenderedRunConfigMessage | undefined {
  const base = applySupervisorTemplateFieldsToMessage(
    args.configuredSystemMessage,
    args.modePayload,
  );
  const defaultText = String(args.defaultSystemMessage ?? "").trim();
  if (!defaultText) return base;
  const appended: RenderedRunConfigMessage = {
    operation: "append",
    text: defaultText,
    images: [],
    content: promptContentFromText(defaultText),
  };
  return combineSystemMessages(base, appended);
}
