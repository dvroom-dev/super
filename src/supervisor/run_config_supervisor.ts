import type { ToolInterceptionConfig } from "./tool_interception.js";
import { normalizeToolInterceptionConfig } from "./run_config_tool_interception.js";
type ConfigRecord = Record<string, unknown>;

export type SupervisorInterjectionTrigger =
  | "run_start_bootstrap"
  | "agent_yield"
  | "agent_compaction"
  | "agent_error"
  | "agent_check_supervisor"
  | "agent_process_result_report"
  | "agent_wrapup_certification_request"
  | "agent_tool_intercept"
  | "agent_switch_mode_request"
  | "cadence";

export type SupervisorInterjectionMessageType =
  | "user"
  | "assistant"
  | "system"
  | "developer"
  | "supervisor";

export type SupervisorMessageTemplate = {
  name: string;
  description: string;
  messageType: SupervisorInterjectionMessageType;
  text: string;
};

export type SupervisorMessageTemplateGroupMap = Partial<
  Record<SupervisorInterjectionTrigger, SupervisorMessageTemplate[]>
>;

export type SupervisorMessageTemplatesByTrigger = Partial<
  Record<SupervisorInterjectionTrigger, SupervisorMessageTemplate[]>
>;

export type RunConfigSupervisor = {
  enabled?: boolean;
  cadenceEnabled?: boolean;
  timeBudgetMs?: number;
  tokenBudgetAdjusted?: number;
  cadenceTimeMs?: number;
  cadenceTokensAdjusted?: number;
  cadenceInterruptPolicy?: "boundary" | "interrupt";
  reviewTimeoutMs?: number;
  returnControlPattern?: string;
  appendSupervisorJudgements?: boolean;
  disableSyntheticCheckSupervisorOnRuleFailure?: boolean;
  stopCondition?: string;
  contextCarryoverLimitBytes?: number;
  workspaceSubdir?: string;
  agentDefaultSystemMessage?: string;
  toolInterception?: ToolInterceptionConfig;
};

function asRecord(value: unknown): ConfigRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ConfigRecord;
}

function normalizePositiveNumber(raw: unknown, label: string, sourcePath: string): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${sourcePath}: ${label} must be a positive number`);
  return Math.floor(value);
}

function normalizeBoolean(raw: unknown, label: string, sourcePath: string): boolean | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "boolean") throw new Error(`${sourcePath}: ${label} must be true or false`);
  return raw;
}

function normalizeString(raw: unknown, label: string, sourcePath: string): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string") throw new Error(`${sourcePath}: ${label} must be a string`);
  const value = raw.trim();
  return value || undefined;
}

function normalizeCadenceInterruptPolicy(
  raw: unknown,
  label: string,
  sourcePath: string,
): "boundary" | "interrupt" | undefined {
  const value = normalizeString(raw, label, sourcePath);
  if (value == null) return undefined;
  if (value === "boundary" || value === "interrupt") return value;
  throw new Error(`${sourcePath}: ${label} must be boundary|interrupt`);
}

const SUPERVISOR_INTERJECTION_TRIGGER_ALIASES: Record<string, SupervisorInterjectionTrigger> = {
  run_start_bootstrap: "run_start_bootstrap",
  agent_yield: "agent_yield",
  agent_compaction: "agent_compaction",
  agent_error: "agent_error",
  agent_check_supervisor: "agent_check_supervisor",
  agent_process_result_report: "agent_process_result_report",
  agent_wrapup_certification_request: "agent_wrapup_certification_request",
  agent_tool_intercept: "agent_tool_intercept",
  agent_switch_mode_request: "agent_switch_mode_request",
  cadence: "cadence",
};

export function normalizeSupervisorInterjectionTrigger(raw: string, sourcePath: string): SupervisorInterjectionTrigger {
  const key = raw.trim().toLowerCase();
  const normalized = SUPERVISOR_INTERJECTION_TRIGGER_ALIASES[key];
  if (normalized) return normalized;
  throw new Error(`${sourcePath}: supervisor.supervisor_triggers trigger '${raw}' is unsupported`);
}

function normalizeSupervisorInterjectionMessageType(
  raw: unknown,
  label: string,
  sourcePath: string,
): SupervisorInterjectionMessageType {
  const value = normalizeString(raw ?? "user", `${label}.message_type`, sourcePath);
  if (
    value === "user" ||
    value === "assistant" ||
    value === "system" ||
    value === "developer" ||
    value === "supervisor"
  ) {
    return value;
  }
  throw new Error(
    `${sourcePath}: ${label}.message_type must be user|assistant|system|developer|supervisor`,
  );
}

export function normalizeSupervisorInterjectionTemplate(
  raw: unknown,
  label: string,
  sourcePath: string,
): SupervisorMessageTemplate | undefined {
  if (raw == null) return undefined;
  const entry = asRecord(raw);
  if (!entry) {
    throw new Error(`${sourcePath}: ${label} must be a mapping`);
  }
  const name = normalizeString(entry.name, `${label}.name`, sourcePath);
  if (!name) {
    throw new Error(`${sourcePath}: ${label}.name is required`);
  }
  if (name === "custom") {
    throw new Error(`${sourcePath}: ${label}.name must not be 'custom'`);
  }
  const description = normalizeString(entry.description, `${label}.description`, sourcePath);
  if (!description) {
    throw new Error(`${sourcePath}: ${label}.description is required`);
  }
  const text = normalizeString(
    entry.text ?? entry.template,
    `${label}.text`,
    sourcePath,
  );
  if (!text) {
    throw new Error(`${sourcePath}: ${label}.text is required`);
  }
  const placeholderMatches = [...text.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((match) =>
    String(match[1] ?? "").trim(),
  );
  const invalid = placeholderMatches.filter((name) => name !== "message");
  if (invalid.length > 0) {
    throw new Error(`${sourcePath}: ${label}.text supports only {{message}} placeholder`);
  }
  return {
    name,
    description,
    messageType: normalizeSupervisorInterjectionMessageType(
      entry.message_type,
      label,
      sourcePath,
    ),
    text,
  };
}

export function normalizeSupervisorInterjectionTemplates(
  raw: unknown,
  label: string,
  sourcePath: string,
): SupervisorMessageTemplate[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${sourcePath}: ${label} must be an array`);
  }
  const out: SupervisorMessageTemplate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const entry = normalizeSupervisorInterjectionTemplate(
      raw[i],
      `${label}[${i}]`,
      sourcePath,
    );
    if (!entry) continue;
    if (seen.has(entry.name)) {
      throw new Error(`${sourcePath}: ${label} contains duplicate template name '${entry.name}'`);
    }
    seen.add(entry.name);
    out.push(entry);
  }
  return out.length ? out : undefined;
}

export function templateAcceptsMessageField(template: SupervisorMessageTemplate): boolean {
  return /\{\{\s*message\s*\}\}/.test(String(template.text ?? ""));
}

export function renderSupervisorMessageTemplatesMarkdown(
  templates: SupervisorMessageTemplate[] | undefined,
): string {
  if (!templates || templates.length === 0) {
    return "";
  }
  const lines = [
    "Message templates for append_message_and_continue:",
    "- Use one template `name` below, or use `message_template=\"custom\"` for raw message.",
  ];
  for (const template of templates) {
    lines.push(`- ${template.name}: ${template.description}`);
  }
  return lines.join("\n");
}

const TEMPLATE_GROUP_ORDER: SupervisorInterjectionTrigger[] = [
  "run_start_bootstrap",
  "agent_yield",
  "agent_compaction",
  "agent_error",
  "agent_check_supervisor",
  "agent_process_result_report",
  "agent_wrapup_certification_request",
  "agent_tool_intercept",
  "agent_switch_mode_request",
  "cadence",
];

export function renderSupervisorMessageTemplatesByTriggerMarkdown(
  groups: SupervisorMessageTemplateGroupMap | undefined,
): string {
  if (!groups) return "";
  const lines: string[] = [];
  for (const trigger of TEMPLATE_GROUP_ORDER) {
    const templates = groups[trigger];
    if (!templates || templates.length === 0) continue;
    lines.push(`Trigger ${trigger}:`);
    for (const template of templates) {
      const customization = templateAcceptsMessageField(template) ? "customization=message" : "customization=none";
      lines.push(`- ${template.name}: ${template.description} (${customization})`);
    }
  }
  if (lines.length === 0) return "";
  return [
    "Message templates by trigger for append_message_and_continue:",
    ...lines,
    "- Use `message_template=\"custom\"` and `message` to send a raw message.",
  ].join("\n");
}

export function normalizeSupervisorConfig(raw: unknown, sourcePath: string): RunConfigSupervisor | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: supervisor must be a mapping`);
  if (obj.agent_message_templates != null || obj.agentMessageTemplates != null || obj.agent_message_by_trigger != null) {
    throw new Error(
      `${sourcePath}: supervisor.agent_message_templates has been renamed to supervisor.supervisor_triggers.<trigger>.message_templates`,
    );
  }
  if (obj.supervisor_interjections != null || obj.supervisorInterjections != null) {
    throw new Error(
      `${sourcePath}: supervisor.supervisor_interjections has been renamed to supervisor.supervisor_triggers.<trigger>.message_templates`,
    );
  }
  if (obj.prompt_by_trigger != null) {
    throw new Error(
      `${sourcePath}: supervisor.prompt_by_trigger has been renamed to supervisor.supervisor_triggers.<trigger>.supervisor_prompt`,
    );
  }

  const enabled = normalizeBoolean(obj.enabled, "supervisor.enabled", sourcePath);
  const cadenceEnabled = normalizeBoolean(
    obj.cadence_enabled ?? obj.cadenceEnabled,
    "supervisor.cadence_enabled",
    sourcePath,
  );
  const timeBudgetMs = normalizePositiveNumber(obj.time_budget_ms, "supervisor.time_budget_ms", sourcePath);
  const tokenBudgetAdjusted = normalizePositiveNumber(
    obj.token_budget_adjusted,
    "supervisor.token_budget_adjusted",
    sourcePath,
  );
  const cadenceTimeMs = normalizePositiveNumber(
    obj.cadence_time_ms,
    "supervisor.cadence_time_ms",
    sourcePath,
  );
  const cadenceTokensAdjusted = normalizePositiveNumber(
    obj.cadence_tokens_adjusted,
    "supervisor.cadence_tokens_adjusted",
    sourcePath,
  );
  const cadenceInterruptPolicy = normalizeCadenceInterruptPolicy(
    obj.cadence_interrupt_policy ?? obj.cadenceInterruptPolicy,
    "supervisor.cadence_interrupt_policy",
    sourcePath,
  );
  const reviewTimeoutMs = normalizePositiveNumber(
    obj.review_timeout_ms,
    "supervisor.review_timeout_ms",
    sourcePath,
  );
  const returnControlPattern = normalizeString(
    obj.return_control_pattern,
    "supervisor.return_control_pattern",
    sourcePath,
  );
  const appendSupervisorJudgements = normalizeBoolean(
    obj.append_supervisor_judgements,
    "supervisor.append_supervisor_judgements",
    sourcePath,
  );
  const disableSyntheticCheckSupervisorOnRuleFailure = normalizeBoolean(
    obj.disable_synthetic_check_supervisor_on_rule_failure,
    "supervisor.disable_synthetic_check_supervisor_on_rule_failure",
    sourcePath,
  );
  const carryoverLimitKbRaw = obj.context_carryover_limit_kb;
  const carryoverLimitBytesFromKb = carryoverLimitKbRaw == null ? undefined : Number(carryoverLimitKbRaw) * 1024;
  const stopCondition = normalizeString(
    obj.stop_condition,
    "supervisor.stop_condition",
    sourcePath,
  );
  const contextCarryoverLimitBytes = normalizePositiveNumber(
    obj.context_carryover_limit_bytes ?? carryoverLimitBytesFromKb,
    "supervisor.context_carryover_limit_bytes",
    sourcePath,
  );
  const workspaceSubdir = normalizeString(
    obj.workspace_subdir,
    "supervisor.workspace_subdir",
    sourcePath,
  );
  const agentDefaultSystemMessage = normalizeString(
    obj.agent_default_system_message,
    "supervisor.agent_default_system_message",
    sourcePath,
  );
  const toolInterception = normalizeToolInterceptionConfig(
    obj.tool_interception,
    sourcePath,
  );

  if (
    enabled == null &&
    cadenceEnabled == null &&
    timeBudgetMs == null &&
    tokenBudgetAdjusted == null &&
    cadenceTimeMs == null &&
    cadenceTokensAdjusted == null &&
    cadenceInterruptPolicy == null &&
    reviewTimeoutMs == null &&
    returnControlPattern == null &&
    appendSupervisorJudgements == null &&
    disableSyntheticCheckSupervisorOnRuleFailure == null &&
    stopCondition == null &&
    contextCarryoverLimitBytes == null &&
    workspaceSubdir == null &&
    agentDefaultSystemMessage == null &&
    toolInterception == null
  ) {
    return undefined;
  }

  const out: RunConfigSupervisor = {};
  if (enabled != null) out.enabled = enabled;
  if (cadenceEnabled != null) out.cadenceEnabled = cadenceEnabled;
  if (timeBudgetMs != null) out.timeBudgetMs = timeBudgetMs;
  if (tokenBudgetAdjusted != null) out.tokenBudgetAdjusted = tokenBudgetAdjusted;
  if (cadenceTimeMs != null) out.cadenceTimeMs = cadenceTimeMs;
  if (cadenceTokensAdjusted != null) out.cadenceTokensAdjusted = cadenceTokensAdjusted;
  if (cadenceInterruptPolicy != null) out.cadenceInterruptPolicy = cadenceInterruptPolicy;
  if (reviewTimeoutMs != null) out.reviewTimeoutMs = reviewTimeoutMs;
  if (returnControlPattern != null) out.returnControlPattern = returnControlPattern;
  if (appendSupervisorJudgements != null) out.appendSupervisorJudgements = appendSupervisorJudgements;
  if (disableSyntheticCheckSupervisorOnRuleFailure != null) {
    out.disableSyntheticCheckSupervisorOnRuleFailure = disableSyntheticCheckSupervisorOnRuleFailure;
  }
  if (stopCondition != null) out.stopCondition = stopCondition;
  if (contextCarryoverLimitBytes != null) out.contextCarryoverLimitBytes = contextCarryoverLimitBytes;
  if (workspaceSubdir != null) out.workspaceSubdir = workspaceSubdir;
  if (agentDefaultSystemMessage != null) out.agentDefaultSystemMessage = agentDefaultSystemMessage;
  if (toolInterception) {
    out.toolInterception = {
      rules: toolInterception.rules.map((rule) => ({
        ...(rule.name ? { name: rule.name } : {}),
        when: rule.when,
        tool: rule.tool,
        matchType: rule.matchType,
        pattern: rule.pattern,
        caseSensitive: rule.caseSensitive,
        ...(rule.action ? { action: { ...rule.action } } : {}),
      })),
    };
  }
  return out;
}
