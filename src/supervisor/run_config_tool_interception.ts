import type {
  ToolInterceptionAction,
  ToolInterceptionConfig,
  ToolInterceptionMatchType,
  ToolInterceptionRule,
  ToolInterceptionTool,
  ToolInterceptionWhen,
} from "./tool_interception.js";

type ConfigRecord = Record<string, unknown>;

function asRecord(value: unknown): ConfigRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ConfigRecord;
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

function normalizeToolInterceptionWhen(
  raw: unknown,
  label: string,
  sourcePath: string,
): ToolInterceptionWhen {
  const value = normalizeString(raw, `${label}.when`, sourcePath);
  if (value === "invocation" || value === "response") return value;
  throw new Error(`${sourcePath}: ${label}.when must be invocation|response`);
}

function normalizeToolInterceptionTool(
  raw: unknown,
  label: string,
  sourcePath: string,
): ToolInterceptionTool {
  const value = normalizeString(raw, `${label}.tool`, sourcePath);
  if (value === "bash" || value === "mcp") return value;
  throw new Error(`${sourcePath}: ${label}.tool must be bash|mcp`);
}

function normalizeToolInterceptionMatchType(
  raw: unknown,
  label: string,
  sourcePath: string,
): ToolInterceptionMatchType {
  const value = normalizeString(raw, `${label}.match_type`, sourcePath);
  if (value === "exact_match" || value === "contains" || value === "regex") return value;
  throw new Error(`${sourcePath}: ${label}.match_type must be exact_match|contains|regex`);
}

function normalizeStringMap(
  raw: unknown,
  label: string,
  sourcePath: string,
): Record<string, string> | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: ${label} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [keyRaw, valueRaw] of Object.entries(obj)) {
    const key = String(keyRaw ?? "").trim();
    if (!key) continue;
    const value = normalizeString(valueRaw, `${label}.${key}`, sourcePath);
    if (!value) throw new Error(`${sourcePath}: ${label}.${key} must be a non-empty string`);
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeToolInterceptionAction(
  raw: unknown,
  label: string,
  sourcePath: string,
): ToolInterceptionAction | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: ${label} must be a mapping`);
  const type = normalizeString(obj.type, `${label}.type`, sourcePath);
  if (type !== "runtime_switch_mode" && type !== "supervisor_switch_mode") {
    throw new Error(`${sourcePath}: ${label}.type must be runtime_switch_mode|supervisor_switch_mode`);
  }
  const targetMode = normalizeString(obj.target_mode ?? obj.targetMode, `${label}.target_mode`, sourcePath);
  if (!targetMode) throw new Error(`${sourcePath}: ${label}.target_mode is required`);
  const reason = normalizeString(obj.reason, `${label}.reason`, sourcePath);
  if (!reason) throw new Error(`${sourcePath}: ${label}.reason is required`);
  const modePayload = normalizeStringMap(obj.mode_payload ?? obj.modePayload, `${label}.mode_payload`, sourcePath);
  return {
    type,
    targetMode,
    reason,
    ...(modePayload ? { modePayload } : {}),
  };
}

function normalizeToolInterceptionRule(
  raw: unknown,
  label: string,
  sourcePath: string,
): ToolInterceptionRule {
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: ${label} must be a mapping`);
  const matchObj = asRecord(obj.match);
  const when = normalizeToolInterceptionWhen(obj.when ?? obj.on, label, sourcePath);
  const tool = normalizeToolInterceptionTool(obj.tool, label, sourcePath);
  const matchType = normalizeToolInterceptionMatchType(
    obj.match_type ?? matchObj?.type ?? matchObj?.match_type,
    label,
    sourcePath,
  );
  const pattern = normalizeString(obj.pattern ?? matchObj?.pattern, `${label}.pattern`, sourcePath);
  if (!pattern) throw new Error(`${sourcePath}: ${label}.pattern is required`);
  const caseSensitiveRaw = obj.case_sensitive ?? matchObj?.case_sensitive;
  const caseSensitive = caseSensitiveRaw == null
    ? true
    : (normalizeBoolean(caseSensitiveRaw, `${label}.case_sensitive`, sourcePath) ?? true);
  if (matchType === "regex") {
    try {
      const flags = caseSensitive ? "" : "i";
      void new RegExp(pattern, flags);
    } catch (err: any) {
      throw new Error(`${sourcePath}: ${label}.pattern is not a valid regex: ${err?.message ?? String(err)}`);
    }
  }
  const name = normalizeString(obj.name, `${label}.name`, sourcePath);
  const action = normalizeToolInterceptionAction(obj.action, `${label}.action`, sourcePath);
  return {
    ...(name ? { name } : {}),
    when,
    tool,
    matchType,
    pattern,
    caseSensitive,
    ...(action ? { action } : {}),
  };
}

export function normalizeToolInterceptionConfig(
  raw: unknown,
  sourcePath: string,
): ToolInterceptionConfig | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${sourcePath}: supervisor.tool_interception must be a mapping`);
  }
  const rulesRaw = obj.rules;
  if (!Array.isArray(rulesRaw)) {
    throw new Error(`${sourcePath}: supervisor.tool_interception.rules must be an array`);
  }
  const rules: ToolInterceptionRule[] = [];
  for (let i = 0; i < rulesRaw.length; i += 1) {
    rules.push(
      normalizeToolInterceptionRule(
        rulesRaw[i],
        `supervisor.tool_interception.rules[${i}]`,
        sourcePath,
      ),
    );
  }
  if (rules.length === 0) return undefined;
  return { rules };
}
