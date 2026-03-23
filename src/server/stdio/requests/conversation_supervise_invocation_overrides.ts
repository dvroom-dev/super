import { isBuiltinToolName, type BuiltinToolName, type ToolNamePolicy } from "../../../tools/definitions.js";
import { cloneToolsConfig, type RunConfigTools } from "../../../supervisor/run_config_tools.js";
import type { ProviderFilesystemPolicy, RunConfigProviderFilesystemPolicies } from "../../../providers/filesystem_permissions.js";
import type { RunConfigSdkBuiltinTools } from "../../../supervisor/run_config_sdk_builtin_tools.js";

export function parseCsvList(raw: unknown): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  return text
    .split(/[,\n]/)
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

function parseBooleanOverride(raw: unknown): boolean | undefined {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  throw new Error(`invalid boolean override '${String(raw)}'`);
}

export function parseReasoningEffortOverride(raw: unknown): string | undefined {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (["minimal", "low", "medium", "high", "xhigh"].includes(text)) return text;
  throw new Error(`invalid agent reasoning override '${String(raw)}'`);
}

function parseBuiltinPolicyOverride(
  transitionPayload: Record<string, string>,
): ToolNamePolicy<BuiltinToolName> | undefined {
  const allow = parseCsvList(transitionPayload.builtin_allow);
  const deny = parseCsvList(transitionPayload.builtin_deny);
  if (allow.length && deny.length) {
    throw new Error("transition_payload cannot specify both builtin_allow and builtin_deny");
  }
  if (allow.length) {
    const names = allow.filter((name): name is BuiltinToolName => isBuiltinToolName(name));
    if (names.length !== allow.length) {
      throw new Error(`transition_payload builtin_allow contains unsupported builtin tool name(s): ${allow.join(", ")}`);
    }
    return { mode: "allow", names };
  }
  if (deny.length) {
    const names = deny.filter((name): name is BuiltinToolName => isBuiltinToolName(name));
    if (names.length !== deny.length) {
      throw new Error(`transition_payload builtin_deny contains unsupported builtin tool name(s): ${deny.join(", ")}`);
    }
    return { mode: "deny", names };
  }
  return undefined;
}

function parseProviderFilesystemOverride(
  transitionPayload: Record<string, string>,
): ProviderFilesystemPolicy | undefined {
  const readAllow = parseCsvList(transitionPayload.fs_read_allow);
  const readDeny = parseCsvList(transitionPayload.fs_read_deny);
  const writeAllow = parseCsvList(transitionPayload.fs_write_allow);
  const writeDeny = parseCsvList(transitionPayload.fs_write_deny);
  const createAllow = parseCsvList(transitionPayload.fs_create_allow);
  const createDeny = parseCsvList(transitionPayload.fs_create_deny);
  for (const [label, values] of [
    ["fs_read_allow", readAllow],
    ["fs_read_deny", readDeny],
    ["fs_write_allow", writeAllow],
    ["fs_write_deny", writeDeny],
    ["fs_create_allow", createAllow],
    ["fs_create_deny", createDeny],
  ] as const) {
    for (const value of values) {
      if (value.startsWith("/") || value.startsWith("..") || value.includes("/../")) {
        throw new Error(`${label} must stay within the current sandbox tree: ${value}`);
      }
    }
  }
  const allowNewFiles = parseBooleanOverride(transitionPayload.fs_allow_new_files);
  const read = readAllow.length || readDeny.length ? { allow: readAllow.length ? readAllow : undefined, deny: readDeny.length ? readDeny : undefined } : undefined;
  const write = writeAllow.length || writeDeny.length ? { allow: writeAllow.length ? writeAllow : undefined, deny: writeDeny.length ? writeDeny : undefined } : undefined;
  const create = createAllow.length || createDeny.length ? { allow: createAllow.length ? createAllow : undefined, deny: createDeny.length ? createDeny : undefined } : undefined;
  if (!read && !write && !create && allowNewFiles == null) return undefined;
  return { read, write, create, allowNewFiles };
}

export function applyTransitionToolOverrides(args: {
  baseTools: RunConfigTools | undefined;
  providerName: "mock" | "codex" | "claude";
  transitionPayload: Record<string, string>;
}): RunConfigTools | undefined {
  const builtinPolicy = parseBuiltinPolicyOverride(args.transitionPayload);
  const providerFilesystemOverride = parseProviderFilesystemOverride(args.transitionPayload);
  const providerBuiltinAllow = parseCsvList(args.transitionPayload.provider_builtin_allow);
  const providerBuiltinDeny = parseCsvList(args.transitionPayload.provider_builtin_deny);
  if (!builtinPolicy && !providerFilesystemOverride && !providerBuiltinAllow.length && !providerBuiltinDeny.length) {
    return args.baseTools;
  }
  if (providerBuiltinAllow.length && providerBuiltinDeny.length) {
    throw new Error("transition_payload cannot specify both provider_builtin_allow and provider_builtin_deny");
  }
  const next = cloneToolsConfig(args.baseTools) ?? {};
  if (builtinPolicy) next.builtinPolicy = builtinPolicy;
  if (providerFilesystemOverride) {
    const currentPolicies: RunConfigProviderFilesystemPolicies = { ...(next.providerFilesystem ?? {}) };
    currentPolicies[args.providerName] = providerFilesystemOverride;
    next.providerFilesystem = currentPolicies;
  }
  if (providerBuiltinAllow.length || providerBuiltinDeny.length) {
    const current: RunConfigSdkBuiltinTools = { ...(next.providerBuiltinTools ?? {}) };
    current[args.providerName] = providerBuiltinAllow.length
      ? { mode: "allow", names: providerBuiltinAllow }
      : { mode: "deny", names: providerBuiltinDeny };
    next.providerBuiltinTools = current;
  }
  return next;
}

export function resolveTransitionInvocationOverrides(transitionPayload: Record<string, string>) {
  const provider = String(transitionPayload.agent_provider ?? "").trim();
  const model = String(transitionPayload.agent_model ?? "").trim();
  const reasoningEffort = parseReasoningEffortOverride(transitionPayload.agent_reasoning_effort);
  const validatorKeysRaw = String(transitionPayload.validator_keys ?? "").trim();
  const validatorKeys = !validatorKeysRaw
    ? undefined
    : validatorKeysRaw.toLowerCase() === "none"
      ? []
      : parseCsvList(validatorKeysRaw);
  const resumeStrategy = String(transitionPayload.resume_strategy ?? "").trim();
  return {
    provider: provider || undefined,
    model: model || undefined,
    reasoningEffort,
    validatorKeys,
    resumeStrategy: resumeStrategy === "same_conversation" || resumeStrategy === "fork_fresh"
      ? resumeStrategy
      : undefined,
  };
}
