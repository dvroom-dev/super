type ConfigRecord = Record<string, unknown>;

export type SupervisorPromptTrigger =
  | "run_start_bootstrap"
  | "base"
  | "agent_yield"
  | "agent_compaction"
  | "agent_error"
  | "agent_check_supervisor"
  | "agent_tool_intercept"
  | "agent_switch_mode_request"
  | "cadence";

export type SupervisorTriggerEntry<TPrompt, TAgentMessage> = {
  supervisorPrompt?: TPrompt;
  messageTemplates?: TAgentMessage[];
};

export type SupervisorTriggers<TPrompt, TAgentMessage> = Partial<
  Record<SupervisorPromptTrigger, SupervisorTriggerEntry<TPrompt, TAgentMessage>>
>;

const SUPERVISOR_PROMPT_TRIGGER_ALIASES: Record<string, SupervisorPromptTrigger> = {
  run_start_bootstrap: "run_start_bootstrap",
  base: "base",
  agent_yield: "agent_yield",
  agent_compaction: "agent_compaction",
  agent_error: "agent_error",
  agent_check_supervisor: "agent_check_supervisor",
  agent_tool_intercept: "agent_tool_intercept",
  agent_switch_mode_request: "agent_switch_mode_request",
  cadence: "cadence",
};

export function normalizeSupervisorPromptTrigger(raw: string, sourcePath: string): SupervisorPromptTrigger {
  const key = raw.trim().toLowerCase();
  const normalized = SUPERVISOR_PROMPT_TRIGGER_ALIASES[key];
  if (normalized) return normalized;
  throw new Error(`${sourcePath}: supervisor prompt trigger '${raw}' is unsupported`);
}

export function normalizeSupervisorTriggers<TPrompt, TAgentMessage>(args: {
  raw: unknown;
  sourcePath: string;
  asRecord: (value: unknown) => ConfigRecord | null;
  normalizePrompt: (raw: unknown, label: string, sourcePath: string) => TPrompt | undefined;
  normalizeMessageTemplates: (raw: unknown, label: string, sourcePath: string) => TAgentMessage[] | undefined;
}): SupervisorTriggers<TPrompt, TAgentMessage> | undefined {
  if (args.raw == null) return undefined;
  const obj = args.asRecord(args.raw);
  if (!obj) {
    throw new Error(`${args.sourcePath}: supervisor.supervisor_triggers must be a mapping`);
  }
  const out: SupervisorTriggers<TPrompt, TAgentMessage> = {};
  for (const [key, value] of Object.entries(obj)) {
    const trigger = normalizeSupervisorPromptTrigger(key, args.sourcePath);
    const entry = args.asRecord(value);
    if (!entry) {
      throw new Error(`${args.sourcePath}: supervisor.supervisor_triggers.${key} must be a mapping`);
    }
    const supervisorPrompt = args.normalizePrompt(
      entry.supervisor_prompt,
      `supervisor.supervisor_triggers.${key}.supervisor_prompt`,
      args.sourcePath,
    );
    if (entry.agent_message != null || entry.agentMessage != null) {
      throw new Error(
        `${args.sourcePath}: supervisor.supervisor_triggers.${key}.agent_message has been renamed to supervisor.supervisor_triggers.${key}.message_templates`,
      );
    }
    const messageTemplates = args.normalizeMessageTemplates(
      entry.message_templates,
      `supervisor.supervisor_triggers.${key}.message_templates`,
      args.sourcePath,
    );
    if (!supervisorPrompt && !messageTemplates) continue;
    out[trigger] = {
      ...(supervisorPrompt ? { supervisorPrompt } : {}),
      ...(messageTemplates ? { messageTemplates } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export function mergeSupervisorTriggers<TPrompt, TAgentMessage>(
  left: SupervisorTriggers<TPrompt, TAgentMessage> | undefined,
  right: SupervisorTriggers<TPrompt, TAgentMessage> | undefined,
): SupervisorTriggers<TPrompt, TAgentMessage> | undefined {
  if (!left && !right) return undefined;
  const out: SupervisorTriggers<TPrompt, TAgentMessage> = {};
  const triggers = new Set<SupervisorPromptTrigger>([
    ...(Object.keys(left ?? {}) as SupervisorPromptTrigger[]),
    ...(Object.keys(right ?? {}) as SupervisorPromptTrigger[]),
  ]);
  for (const trigger of triggers) {
    const l = left?.[trigger];
    const r = right?.[trigger];
    const merged: SupervisorTriggerEntry<TPrompt, TAgentMessage> = {
      ...(l?.supervisorPrompt ? { supervisorPrompt: l.supervisorPrompt } : {}),
      ...(l?.messageTemplates ? { messageTemplates: l.messageTemplates } : {}),
      ...(r?.supervisorPrompt ? { supervisorPrompt: r.supervisorPrompt } : {}),
      ...(r?.messageTemplates ? { messageTemplates: r.messageTemplates } : {}),
    };
    if (merged.supervisorPrompt || merged.messageTemplates) out[trigger] = merged;
  }
  return Object.keys(out).length ? out : undefined;
}

export function cloneSupervisorTriggers<TPrompt, TAgentMessage>(args: {
  raw: SupervisorTriggers<TPrompt, TAgentMessage> | undefined;
  clonePrompt: (raw: TPrompt) => TPrompt;
  cloneMessageTemplate: (raw: TAgentMessage) => TAgentMessage;
}): SupervisorTriggers<TPrompt, TAgentMessage> | undefined {
  const raw = args.raw;
  if (!raw) return undefined;
  return Object.fromEntries(
    Object.entries(raw).map(([trigger, entry]) => [
      trigger,
      {
        ...(entry.supervisorPrompt ? { supervisorPrompt: args.clonePrompt(entry.supervisorPrompt) } : {}),
        ...(entry.messageTemplates
          ? { messageTemplates: entry.messageTemplates.map((template) => args.cloneMessageTemplate(template)) }
          : {}),
      },
    ]),
  ) as SupervisorTriggers<TPrompt, TAgentMessage>;
}
