import type { ToolNamePolicy } from "../tools/definitions.js";
import type { ProviderName } from "../providers/types.js";

export type RunConfigSdkBuiltinToolPolicy = ToolNamePolicy<string>;
export type RunConfigSdkBuiltinTools = Partial<Record<ProviderName, RunConfigSdkBuiltinToolPolicy>>;

const SUPPORTED_PROVIDERS: ProviderName[] = ["codex", "claude", "gemini", "mock"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeToolNameList(raw: unknown, fieldPath: string): string[] {
  const items = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") throw new Error(`${fieldPath} entries must be strings`);
    const name = item.trim();
    if (!name) throw new Error(`${fieldPath} entries must be non-empty strings`);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (out.length === 0) {
    throw new Error(`${fieldPath} must include at least one tool name`);
  }
  return out;
}

function normalizeProviderPolicy(
  raw: unknown,
  sourcePath: string,
  providerName: ProviderName,
): RunConfigSdkBuiltinToolPolicy | undefined {
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: sdk_builtin_tools.${providerName} must be a mapping`);

  const allowRaw = obj.allow ?? obj.allow_tools ?? obj.allowTools;
  const denyRaw = obj.deny ?? obj.deny_tools ?? obj.denyTools ?? obj.disallow ?? obj.exclude;
  if (allowRaw != null && denyRaw != null) {
    throw new Error(`${sourcePath}: sdk_builtin_tools.${providerName} cannot specify both allow and deny`);
  }
  if (allowRaw != null) {
    return {
      mode: "allow",
      names: normalizeToolNameList(allowRaw, `${sourcePath}: sdk_builtin_tools.${providerName}.allow`),
    };
  }
  if (denyRaw != null) {
    return {
      mode: "deny",
      names: normalizeToolNameList(denyRaw, `${sourcePath}: sdk_builtin_tools.${providerName}.deny`),
    };
  }
  return undefined;
}

function clonePolicy(policy: RunConfigSdkBuiltinToolPolicy): RunConfigSdkBuiltinToolPolicy {
  return {
    mode: policy.mode,
    names: [...policy.names],
  };
}

function mergePolicy(
  a?: RunConfigSdkBuiltinToolPolicy,
  b?: RunConfigSdkBuiltinToolPolicy,
): RunConfigSdkBuiltinToolPolicy | undefined {
  if (!a && !b) return undefined;
  if (!a) return b ? clonePolicy(b) : undefined;
  if (!b) return clonePolicy(a);
  if (a.mode !== b.mode) return clonePolicy(b);
  if (a.mode === "deny") {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const name of [...a.names, ...b.names]) {
      if (seen.has(name)) continue;
      seen.add(name);
      merged.push(name);
    }
    return { mode: "deny", names: merged };
  }
  const allowed = new Set(a.names);
  return { mode: "allow", names: b.names.filter((name) => allowed.has(name)) };
}

export function cloneSdkBuiltinTools(
  tools?: RunConfigSdkBuiltinTools,
): RunConfigSdkBuiltinTools | undefined {
  if (!tools) return undefined;
  const out: RunConfigSdkBuiltinTools = {};
  for (const provider of SUPPORTED_PROVIDERS) {
    const policy = tools[provider];
    if (!policy) continue;
    out[provider] = clonePolicy(policy);
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeSdkBuiltinTools(raw: unknown, sourcePath: string): RunConfigSdkBuiltinTools | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: sdk_builtin_tools must be a mapping`);
  const out: RunConfigSdkBuiltinTools = {};
  for (const [providerName, value] of Object.entries(obj)) {
    if (!SUPPORTED_PROVIDERS.includes(providerName as ProviderName)) {
      throw new Error(`${sourcePath}: sdk_builtin_tools.${providerName} must target codex|claude|gemini|mock`);
    }
    const provider = providerName as ProviderName;
    const policy = normalizeProviderPolicy(value, sourcePath, provider);
    if (policy) out[provider] = policy;
  }
  return Object.keys(out).length ? out : undefined;
}

export function mergeSdkBuiltinTools(
  a?: RunConfigSdkBuiltinTools,
  b?: RunConfigSdkBuiltinTools,
): RunConfigSdkBuiltinTools | undefined {
  if (!a && !b) return undefined;
  const out: RunConfigSdkBuiltinTools = {};
  for (const provider of SUPPORTED_PROVIDERS) {
    const policy = mergePolicy(a?.[provider], b?.[provider]);
    if (!policy) continue;
    out[provider] = policy;
  }
  return Object.keys(out).length ? out : undefined;
}
