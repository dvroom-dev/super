import type { PromptMessageOverride } from "../../../supervisor/compile.js";
import type { RenderedRunConfigSupervisorTriggers } from "../../../supervisor/run_config.js";
import type { SupervisorTriggerKind } from "../../../supervisor/review_schema.js";

export type SupervisorPromptTriggerKind = SupervisorTriggerKind | "cadence";

function dedupeImages(images?: string[]): string[] | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  return Array.from(new Set(images.map((entry) => String(entry ?? "").trim()).filter(Boolean)));
}

function toPromptOverride(
  raw: { operation: "append" | "replace"; text: string; images?: string[] } | undefined,
): PromptMessageOverride | undefined {
  if (!raw) return undefined;
  return {
    operation: raw.operation,
    text: raw.text,
    images: dedupeImages(raw.images),
  };
}

function mergePromptOverrides(
  base: PromptMessageOverride | undefined,
  next: PromptMessageOverride | undefined,
): PromptMessageOverride | undefined {
  if (!base) return next;
  if (!next) return base;
  if (next.operation === "replace") return next;
  const combinedText = [base.text.trim(), next.text.trim()].filter(Boolean).join("\n\n");
  return {
    operation: base.operation === "replace" ? "replace" : "append",
    text: combinedText,
    images: dedupeImages([...(base.images ?? []), ...(next.images ?? [])]),
  };
}

export function resolveSupervisorConfiguredSystemMessage(args: {
  configuredSystemMessage?: PromptMessageOverride;
  supervisorTriggers?: RenderedRunConfigSupervisorTriggers;
  mode?: "hard" | "soft";
  trigger: SupervisorTriggerKind;
}): PromptMessageOverride | undefined {
  const promptTrigger: SupervisorPromptTriggerKind = args.mode === "soft" ? "cadence" : args.trigger;
  const baseOverride = toPromptOverride(args.supervisorTriggers?.base?.supervisorPrompt);
  const withConfigured = mergePromptOverrides(baseOverride, args.configuredSystemMessage);
  return mergePromptOverrides(withConfigured, toPromptOverride(args.supervisorTriggers?.[promptTrigger]?.supervisorPrompt));
}
