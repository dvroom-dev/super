type ConfigRecord = Record<string, unknown>;

export type RunConfigHookTrigger =
  | "agent_turn_complete"
  | "supervisor_turn_complete"
  | "agent_error"
  | "supervisor_error";

export type RunConfigHook = {
  trigger: RunConfigHookTrigger;
  action: string;
  appendStdoutAsUserMessage: boolean;
};

function asRecord(value: unknown): ConfigRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ConfigRecord;
}

function normalizeHookTrigger(raw: unknown, sourcePath: string): RunConfigHookTrigger {
  const value = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, RunConfigHookTrigger> = {
    agent_turn_complete: "agent_turn_complete",
    agent_turn_complete_without_error: "agent_turn_complete",
    supervisor_turn_complete: "supervisor_turn_complete",
    supervisor_turn_complete_without_error: "supervisor_turn_complete",
    agent_error: "agent_error",
    supervisor_error: "supervisor_error",
  };
  const normalized = aliases[value];
  if (normalized) return normalized;
  throw new Error(
    `${sourcePath}: hook.trigger '${String(raw)}' is invalid (expected agent_turn_complete|supervisor_turn_complete|agent_error|supervisor_error)`,
  );
}

function normalizeHook(raw: unknown, sourcePath: string): RunConfigHook {
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: hooks entries must be mappings`);
  const trigger = normalizeHookTrigger(obj.trigger, sourcePath);
  const actionRaw = obj.action ?? obj.command;
  if (typeof actionRaw !== "string" || !actionRaw.trim()) {
    throw new Error(`${sourcePath}: hook.action must be a non-empty string`);
  }
  const appendRaw =
    obj.append_stdout_as_user_message ??
    obj.appendStdoutAsUserMessage ??
    obj.append_stdout ??
    obj.appendStdout;
  if (appendRaw != null && typeof appendRaw !== "boolean") {
    throw new Error(`${sourcePath}: hook.append_stdout_as_user_message must be true or false`);
  }
  return {
    trigger,
    action: actionRaw.trim(),
    appendStdoutAsUserMessage: appendRaw == null ? true : appendRaw,
  };
}

export function normalizeHooks(raw: unknown, sourcePath: string): RunConfigHook[] | undefined {
  if (raw == null) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  const hooks = values.map((value) => normalizeHook(value, sourcePath));
  return hooks.length ? hooks : undefined;
}

export function normalizeCycleLimit(raw: unknown, sourcePath: string): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${sourcePath}: cycle_limit must be a positive number`);
  }
  return Math.floor(value);
}
