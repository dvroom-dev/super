import {
  builtinToolNames,
  isBuiltinToolName,
  type BuiltinToolName,
  type CustomToolDefinition,
  type ToolDefinitionsConfig,
  type ToolNamePolicy,
} from "../tools/definitions.js";
import type { ProviderName } from "../providers/types.js";
import type {
  ProviderFilesystemPathPolicy,
  ProviderFilesystemPolicy,
  RunConfigProviderFilesystemPolicies,
} from "../providers/filesystem_permissions.js";
import {
  cloneSdkBuiltinTools,
  mergeSdkBuiltinTools,
  normalizeSdkBuiltinTools,
  type RunConfigSdkBuiltinTools,
} from "./run_config_sdk_builtin_tools.js";
import type { ShellInvocationRule, ShellInvocationMatchType, ShellInvocationPolicy } from "../tools/shell_invocation_policy.js";
export type RunConfigTools = ToolDefinitionsConfig & {
  providerBuiltinTools?: RunConfigSdkBuiltinTools;
  providerFilesystem?: RunConfigProviderFilesystemPolicies;
};
type BuiltinToolPolicy = ToolNamePolicy<BuiltinToolName>;
const SUPPORTED_PROVIDERS: ProviderName[] = ["codex", "claude", "mock"];
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function normalizeBuiltinToolList(raw: unknown, fieldPath: string): BuiltinToolName[] {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: BuiltinToolName[] = [];
  const seen = new Set<BuiltinToolName>();
  for (const item of items) {
    if (typeof item !== "string") throw new Error(`${fieldPath} entries must be strings`);
    const name = item.trim();
    if (!isBuiltinToolName(name)) {
      throw new Error(
        `${fieldPath} '${name}' must be one of ${builtinToolNames().join("|")}`,
      );
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (out.length === 0) {
    throw new Error(`${fieldPath} must include at least one builtin tool name`);
  }
  return out;
}

function normalizeBuiltinPolicy(obj: Record<string, unknown>, sourcePath: string): BuiltinToolPolicy | undefined {
  const builtin = asRecord(obj.builtin ?? obj.builtins);
  const allowRaw =
    builtin?.allow ??
    builtin?.allow_builtin ??
    builtin?.allowBuiltins ??
    obj.allow_builtin ??
    obj.allowBuiltins;
  const denyRaw =
    builtin?.deny ??
    builtin?.deny_builtin ??
    builtin?.denyBuiltins ??
    obj.deny_builtin ??
    obj.denyBuiltins ??
    obj.exclude_builtin ??
    obj.excludeBuiltins ??
    obj.exclude_builtin_tools ??
    obj.excludeBuiltinTools;

  if (allowRaw != null && denyRaw != null) {
    throw new Error(`${sourcePath}: tools cannot specify both allow and deny builtin tool lists`);
  }
  if (allowRaw != null) {
    return {
      mode: "allow",
      names: normalizeBuiltinToolList(allowRaw, `${sourcePath}: tools.allow_builtin`),
    };
  }
  if (denyRaw != null) {
    return {
      mode: "deny",
      names: normalizeBuiltinToolList(denyRaw, `${sourcePath}: tools.deny_builtin`),
    };
  }
  return undefined;
}

function normalizeCommand(raw: unknown, fieldPath: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${fieldPath} must be a non-empty string[]`);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${fieldPath} must contain only non-empty strings`);
    }
    out.push(entry);
  }
  return out;
}

function normalizeCustomTool(raw: unknown, sourcePath: string): CustomToolDefinition {
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: tools.custom entries must be mappings`);
  const name = String(obj.name ?? "").trim();
  if (!name) throw new Error(`${sourcePath}: tools.custom.name is required`);
  if (isBuiltinToolName(name)) {
    throw new Error(`${sourcePath}: tools.custom '${name}' conflicts with builtin tool name`);
  }
  const description = String(obj.description ?? "").trim();
  if (!description) throw new Error(`${sourcePath}: tools.custom '${name}' requires description`);
  const command = normalizeCommand(obj.command, `${sourcePath}: tools.custom '${name}'.command`);
  const cwdRaw = obj.cwd;
  const cwd = cwdRaw == null ? undefined : String(cwdRaw).trim();
  if (cwdRaw != null && !cwd) {
    throw new Error(`${sourcePath}: tools.custom '${name}'.cwd must be a non-empty string`);
  }
  return { name, description, command, cwd };
}

function normalizeCustomTools(raw: unknown, sourcePath: string): CustomToolDefinition[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(`${sourcePath}: tools.custom must be an array`);
  const out: CustomToolDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const tool = normalizeCustomTool(entry, sourcePath);
    const key = tool.name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${sourcePath}: duplicate tools.custom name '${tool.name}'`);
    }
    seen.add(key);
    out.push(tool);
  }
  return out;
}

function normalizeShellInvocationMatchType(raw: unknown, fieldPath: string): ShellInvocationMatchType {
  const value = String(raw ?? "").trim();
  if (value === "exact_match" || value === "contains" || value === "regex") return value;
  throw new Error(`${fieldPath} must be exact_match|contains|regex`);
}

function normalizeBoolean(raw: unknown, fieldPath: string): boolean | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "boolean") throw new Error(`${fieldPath} must be true or false`);
  return raw;
}

function normalizePathList(raw: unknown, fieldPath: string): string[] | undefined {
  if (raw == null) return undefined;
  const items = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") throw new Error(`${fieldPath} entries must be strings`);
    const value = item.trim();
    if (!value) throw new Error(`${fieldPath} entries must be non-empty strings`);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length ? out : undefined;
}

function clonePathPolicy(policy?: ProviderFilesystemPathPolicy): ProviderFilesystemPathPolicy | undefined {
  if (!policy) return undefined;
  return {
    allow: policy.allow ? [...policy.allow] : undefined,
    deny: policy.deny ? [...policy.deny] : undefined,
  };
}

function mergePathPolicy(
  a?: ProviderFilesystemPathPolicy,
  b?: ProviderFilesystemPathPolicy,
): ProviderFilesystemPathPolicy | undefined {
  if (!a && !b) return undefined;
  const allow = (() => {
    const left = a?.allow ?? [];
    const right = b?.allow ?? [];
    if (!left.length && !right.length) return undefined;
    if (!left.length) return [...right];
    if (!right.length) return [...left];
    const rightSet = new Set(right);
    return left.filter((entry) => rightSet.has(entry));
  })();
  const deny = (() => {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const entry of [...(a?.deny ?? []), ...(b?.deny ?? [])]) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
    return merged.length ? merged : undefined;
  })();
  if (!allow && !deny) return undefined;
  return { allow, deny };
}

function normalizeFilesystemPathPolicy(
  raw: unknown,
  fieldPath: string,
): ProviderFilesystemPathPolicy | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${fieldPath} must be a mapping`);
  const allow = normalizePathList(obj.allow, `${fieldPath}.allow`);
  const deny = normalizePathList(obj.deny, `${fieldPath}.deny`);
  if (!allow && !deny) return undefined;
  return { allow, deny };
}

function cloneFilesystemPolicy(policy?: ProviderFilesystemPolicy): ProviderFilesystemPolicy | undefined {
  if (!policy) return undefined;
  return {
    read: clonePathPolicy(policy.read),
    write: clonePathPolicy(policy.write),
    create: clonePathPolicy(policy.create),
    allowNewFiles: policy.allowNewFiles,
  };
}

function mergeFilesystemPolicy(
  a?: ProviderFilesystemPolicy,
  b?: ProviderFilesystemPolicy,
): ProviderFilesystemPolicy | undefined {
  if (!a && !b) return undefined;
  const read = mergePathPolicy(a?.read, b?.read);
  const write = mergePathPolicy(a?.write, b?.write);
  const create = mergePathPolicy(a?.create, b?.create);
  const allowNewFiles = b?.allowNewFiles ?? a?.allowNewFiles;
  if (!read && !write && !create && allowNewFiles == null) return undefined;
  return { read, write, create, allowNewFiles };
}

function normalizeProviderFilesystemPolicy(
  raw: unknown,
  sourcePath: string,
  providerName: ProviderName,
): ProviderFilesystemPolicy | undefined {
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: tools.provider_filesystem.${providerName} must be a mapping`);
  const read = normalizeFilesystemPathPolicy(obj.read, `${sourcePath}: tools.provider_filesystem.${providerName}.read`);
  const write = normalizeFilesystemPathPolicy(obj.write, `${sourcePath}: tools.provider_filesystem.${providerName}.write`);
  const create = normalizeFilesystemPathPolicy(obj.create, `${sourcePath}: tools.provider_filesystem.${providerName}.create`);
  const allowNewFiles = normalizeBoolean(
    obj.allow_new_files ?? obj.allowNewFiles,
    `${sourcePath}: tools.provider_filesystem.${providerName}.allow_new_files`,
  );
  if (!read && !write && !create && allowNewFiles == null) return undefined;
  return { read, write, create, allowNewFiles };
}

function normalizeProviderFilesystem(
  obj: Record<string, unknown>,
  sourcePath: string,
): RunConfigProviderFilesystemPolicies | undefined {
  const raw = obj.provider_filesystem ?? obj.providerFilesystem;
  if (raw == null) return undefined;
  const policiesObj = asRecord(raw);
  if (!policiesObj) throw new Error(`${sourcePath}: tools.provider_filesystem must be a mapping`);
  const out: RunConfigProviderFilesystemPolicies = {};
  for (const [providerName, value] of Object.entries(policiesObj)) {
    if (!SUPPORTED_PROVIDERS.includes(providerName as ProviderName)) {
      throw new Error(`${sourcePath}: tools.provider_filesystem.${providerName} must target codex|claude|mock`);
    }
    const provider = providerName as ProviderName;
    const policy = normalizeProviderFilesystemPolicy(value, sourcePath, provider);
    if (policy) out[provider] = policy;
  }
  return Object.keys(out).length ? out : undefined;
}

function cloneProviderFilesystem(
  policies?: RunConfigProviderFilesystemPolicies,
): RunConfigProviderFilesystemPolicies | undefined {
  if (!policies) return undefined;
  const out: RunConfigProviderFilesystemPolicies = {};
  for (const provider of SUPPORTED_PROVIDERS) {
    const policy = policies[provider];
    if (!policy) continue;
    out[provider] = cloneFilesystemPolicy(policy);
  }
  return Object.keys(out).length ? out : undefined;
}

function mergeProviderFilesystem(
  a?: RunConfigProviderFilesystemPolicies,
  b?: RunConfigProviderFilesystemPolicies,
): RunConfigProviderFilesystemPolicies | undefined {
  if (!a && !b) return undefined;
  const out: RunConfigProviderFilesystemPolicies = {};
  for (const provider of SUPPORTED_PROVIDERS) {
    const policy = mergeFilesystemPolicy(a?.[provider], b?.[provider]);
    if (!policy) continue;
    out[provider] = policy;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeShellInvocationRule(
  raw: unknown,
  label: string,
): ShellInvocationRule {
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${label} must be a mapping`);
  const matchType = normalizeShellInvocationMatchType(obj.match_type, `${label}.match_type`);
  const pattern = String(obj.pattern ?? "").trim();
  if (!pattern) throw new Error(`${label}.pattern is required`);
  const caseSensitive = normalizeBoolean(obj.case_sensitive, `${label}.case_sensitive`) ?? true;
  if (matchType === "regex") {
    try {
      const flags = caseSensitive ? "" : "i";
      void new RegExp(pattern, flags);
    } catch (err: any) {
      throw new Error(`${label}.pattern is not a valid regex: ${err?.message ?? String(err)}`);
    }
  }
  return { matchType, pattern, caseSensitive };
}

function normalizeShellInvocationPolicy(obj: Record<string, unknown>, sourcePath: string): ShellInvocationPolicy | undefined {
  const policyObj = asRecord(obj.shell_invocation_policy ?? obj.shellInvocationPolicy);
  if (!policyObj) return undefined;
  const normalizeRuleList = (raw: unknown, label: string): ShellInvocationRule[] | undefined => {
    if (raw == null) return undefined;
    if (!Array.isArray(raw)) {
      throw new Error(`${sourcePath}: tools.shell_invocation_policy.${label} must be an array`);
    }
    return raw.map((entry, index) =>
      normalizeShellInvocationRule(entry, `${sourcePath}: tools.shell_invocation_policy.${label}[${index}]`),
    );
  };
  const allow = normalizeRuleList(policyObj.allow, "allow");
  const disallow = normalizeRuleList(policyObj.disallow, "disallow");
  if (!allow?.length && !disallow?.length) {
    return undefined;
  }
  return { ...(allow?.length ? { allow } : {}), ...(disallow?.length ? { disallow } : {}) };
}

function cloneCustomTool(tool: CustomToolDefinition): CustomToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    command: [...tool.command],
    cwd: tool.cwd,
  };
}

function cloneBuiltinPolicy(policy?: BuiltinToolPolicy): BuiltinToolPolicy | undefined {
  if (!policy) return undefined;
  return { mode: policy.mode, names: [...policy.names] };
}

function cloneShellInvocationPolicy(policy?: ShellInvocationPolicy): ShellInvocationPolicy | undefined {
  if (!policy) return undefined;
  return {
    ...(policy.allow?.length
      ? {
          allow: policy.allow.map((rule) => ({
            matchType: rule.matchType,
            pattern: rule.pattern,
            caseSensitive: rule.caseSensitive,
          })),
        }
      : {}),
    ...(policy.disallow?.length
      ? {
          disallow: policy.disallow.map((rule) => ({
            matchType: rule.matchType,
            pattern: rule.pattern,
            caseSensitive: rule.caseSensitive,
          })),
        }
      : {}),
  };
}

function mergeBuiltinPolicies(a?: BuiltinToolPolicy, b?: BuiltinToolPolicy): BuiltinToolPolicy | undefined {
  if (!a && !b) return undefined;
  if (!a) return cloneBuiltinPolicy(b);
  if (!b) return cloneBuiltinPolicy(a);
  if (a.mode !== b.mode) return cloneBuiltinPolicy(b);
  if (a.mode === "deny") {
    const merged: BuiltinToolName[] = [];
    const seen = new Set<BuiltinToolName>();
    for (const name of [...a.names, ...b.names]) {
      if (seen.has(name)) continue;
      seen.add(name);
      merged.push(name);
    }
    return { mode: "deny", names: merged };
  }
  const allowed = new Set(a.names);
  return {
    mode: "allow",
    names: b.names.filter((name) => allowed.has(name)),
  };
}

export function cloneToolsConfig(tools?: RunConfigTools): RunConfigTools | undefined {
  if (!tools) return undefined;
  return {
    builtinPolicy: cloneBuiltinPolicy(tools.builtinPolicy),
    customTools: (tools.customTools ?? []).map(cloneCustomTool),
    shellInvocationPolicy: cloneShellInvocationPolicy(tools.shellInvocationPolicy),
    providerBuiltinTools: cloneSdkBuiltinTools(tools.providerBuiltinTools),
    providerFilesystem: cloneProviderFilesystem(tools.providerFilesystem),
  };
}

export function normalizeToolsConfig(raw: unknown, sourcePath: string): RunConfigTools | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: tools must be a mapping`);
  const builtinPolicy = normalizeBuiltinPolicy(obj, sourcePath);
  const customTools = normalizeCustomTools(obj.custom ?? obj.custom_tools ?? obj.customTools, sourcePath);
  const shellInvocationPolicy = normalizeShellInvocationPolicy(obj, sourcePath);
  const providerBuiltinTools = normalizeSdkBuiltinTools(
    obj.provider_builtin_tools ?? obj.providerBuiltinTools,
    `${sourcePath}: tools`,
  );
  const providerFilesystem = normalizeProviderFilesystem(obj, sourcePath);
  if (!builtinPolicy && customTools.length === 0 && !shellInvocationPolicy && !providerBuiltinTools && !providerFilesystem) {
    return undefined;
  }
  return { builtinPolicy, customTools, shellInvocationPolicy, providerBuiltinTools, providerFilesystem };
}

export function mergeToolsConfig(a?: RunConfigTools, b?: RunConfigTools): RunConfigTools | undefined {
  if (!a && !b) return undefined;
  const builtinPolicy = mergeBuiltinPolicies(a?.builtinPolicy, b?.builtinPolicy);
  const mergedCustomByName = new Map<string, CustomToolDefinition>();
  for (const tool of a?.customTools ?? []) {
    mergedCustomByName.set(tool.name.toLowerCase(), cloneCustomTool(tool));
  }
  for (const tool of b?.customTools ?? []) {
    mergedCustomByName.set(tool.name.toLowerCase(), cloneCustomTool(tool));
  }
  const customTools = Array.from(mergedCustomByName.values());
  const mergedShellDisallowRules: ShellInvocationRule[] = [];
  const seenShellRules = new Set<string>();
  for (const rule of [...(a?.shellInvocationPolicy?.disallow ?? []), ...(b?.shellInvocationPolicy?.disallow ?? [])]) {
    const key = `${rule.matchType}:${rule.caseSensitive ? "1" : "0"}:${rule.pattern}`;
    if (seenShellRules.has(key)) continue;
    seenShellRules.add(key);
    mergedShellDisallowRules.push({
      matchType: rule.matchType,
      pattern: rule.pattern,
      caseSensitive: rule.caseSensitive,
    });
  }
  const mergeAllowRules = (
    left: ShellInvocationRule[] | undefined,
    right: ShellInvocationRule[] | undefined,
  ): ShellInvocationRule[] | undefined => {
    if (right) {
      return right.map((rule) => ({
        matchType: rule.matchType,
        pattern: rule.pattern,
        caseSensitive: rule.caseSensitive,
      }));
    }
    if (!left) return undefined;
    return left.map((rule) => ({
      matchType: rule.matchType,
      pattern: rule.pattern,
      caseSensitive: rule.caseSensitive,
    }));
  };
  const mergedShellAllowRules = mergeAllowRules(
    a?.shellInvocationPolicy?.allow,
    b?.shellInvocationPolicy?.allow,
  );
  const shellInvocationPolicy =
    mergedShellAllowRules?.length || mergedShellDisallowRules.length > 0
      ? {
          ...(mergedShellAllowRules?.length ? { allow: mergedShellAllowRules } : {}),
          ...(mergedShellDisallowRules.length > 0 ? { disallow: mergedShellDisallowRules } : {}),
        }
      : undefined;
  const providerBuiltinTools = mergeSdkBuiltinTools(a?.providerBuiltinTools, b?.providerBuiltinTools);
  const providerFilesystem = mergeProviderFilesystem(a?.providerFilesystem, b?.providerFilesystem);
  if (!builtinPolicy && customTools.length === 0 && !shellInvocationPolicy && !providerBuiltinTools && !providerFilesystem) return undefined;
  return {
    builtinPolicy,
    customTools,
    shellInvocationPolicy,
    providerBuiltinTools,
    providerFilesystem,
  };
}
