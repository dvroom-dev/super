import type {
  AppendMessageTemplateOption,
  SupervisorReviewResult,
  SupervisorTriggerKind,
} from "../../../supervisor/review_schema.js";
import type { RenderedRunConfigSupervisorTriggers } from "../../../supervisor/run_config.js";
import type {
  SupervisorMessageTemplate,
  SupervisorInterjectionTrigger,
  SupervisorInterjectionMessageType,
} from "../../../supervisor/run_config_supervisor.js";

export type SupervisorInjectedMessage = {
  trigger: SupervisorInterjectionTrigger;
  messageType: SupervisorInterjectionMessageType;
  text: string;
};

type BuildSupervisorInjectedMessageArgs = {
  supervisorMode: "hard" | "soft";
  reviewTrigger: SupervisorTriggerKind;
  review: SupervisorReviewResult;
  guidanceText: string;
  messageTemplateName?: string;
  reasons: string[];
  stopDetails: string[];
  supervisorTriggers?: RenderedRunConfigSupervisorTriggers;
};

export function interjectionTriggerForReview(
  supervisorMode: "hard" | "soft",
  reviewTrigger: SupervisorTriggerKind,
): SupervisorInterjectionTrigger {
  if (supervisorMode === "soft") return "cadence";
  if (reviewTrigger === "agent_yield") return "agent_yield";
  if (reviewTrigger === "agent_compaction") return "agent_compaction";
  if (reviewTrigger === "agent_error") return "agent_error";
  if (reviewTrigger === "agent_tool_intercept") return "agent_tool_intercept";
  if (reviewTrigger === "agent_switch_mode_request") return "agent_switch_mode_request";
  return "agent_check_supervisor";
}

function interpolateTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return String(template ?? "").replaceAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    return values[String(key ?? "").trim()] ?? "";
  });
}

function normalizeTemplateText(
  template: SupervisorMessageTemplate | undefined,
  fallback: string,
  values: Record<string, string>,
): string {
  const source = template?.text ?? fallback;
  const rendered = interpolateTemplate(source, values).trim();
  return rendered || fallback;
}

function templateAcceptsMessageField(template: SupervisorMessageTemplate): boolean {
  return /\{\{\s*message\s*\}\}/.test(String(template.text ?? ""));
}

export function messageTemplateSpecsForReview(args: {
  supervisorMode: "hard" | "soft";
  reviewTrigger: SupervisorTriggerKind;
  supervisorTriggers?: RenderedRunConfigSupervisorTriggers;
}): AppendMessageTemplateOption[] {
  const trigger = interjectionTriggerForReview(args.supervisorMode, args.reviewTrigger);
  const templates = args.supervisorTriggers?.[trigger]?.messageTemplates ?? [];
  return templates.map((template) => ({
    name: template.name,
    acceptsMessage: templateAcceptsMessageField(template),
  }));
}

export function messageTemplateNamesForReview(args: {
  supervisorMode: "hard" | "soft";
  reviewTrigger: SupervisorTriggerKind;
  supervisorTriggers?: RenderedRunConfigSupervisorTriggers;
}): string[] {
  return messageTemplateSpecsForReview(args).map((template) => template.name);
}

function selectedTemplateForReview(args: {
  supervisorMode: "hard" | "soft";
  reviewTrigger: SupervisorTriggerKind;
  templateName?: string;
  supervisorTriggers?: RenderedRunConfigSupervisorTriggers;
}): SupervisorMessageTemplate | undefined {
  const requested = String(args.templateName ?? "").trim();
  if (!requested || requested === "custom") return undefined;
  const trigger = interjectionTriggerForReview(args.supervisorMode, args.reviewTrigger);
  const templates = args.supervisorTriggers?.[trigger]?.messageTemplates ?? [];
  return templates.find((template) => template.name === requested);
}

export function buildSupervisorInjectedMessage(
  args: BuildSupervisorInjectedMessageArgs,
): SupervisorInjectedMessage | undefined {
  const fallbackText = String(args.guidanceText ?? "").trim();
  const trigger = interjectionTriggerForReview(args.supervisorMode, args.reviewTrigger);
  const template = selectedTemplateForReview({
    supervisorMode: args.supervisorMode,
    reviewTrigger: args.reviewTrigger,
    templateName: args.messageTemplateName,
    supervisorTriggers: args.supervisorTriggers,
  });
  const acceptsMessage = template ? templateAcceptsMessageField(template) : true;
  if (!template && !fallbackText) return undefined;
  if (acceptsMessage && !fallbackText) return undefined;
  const values: Record<string, string> = {
    message: acceptsMessage ? fallbackText : "",
  };
  const fallback = template?.text?.trim() || fallbackText;
  return {
    trigger,
    messageType: template?.messageType ?? "user",
    text: normalizeTemplateText(template, fallback, values),
  };
}
