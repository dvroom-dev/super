import type { ProviderName } from "./types.js";
import type { RunConfigSdkBuiltinTools } from "../supervisor/run_config_sdk_builtin_tools.js";

type ProviderOptions = Record<string, unknown>;

const CODEX_COMMAND_EXECUTION_TOOL = "commandExecution";
const CODEX_FILE_CHANGE_TOOL = "fileChange";
const CODEX_MCP_TOOL = "mcpToolCall";

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function hasConfiguredTools(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== "object") return false;
  return true;
}

function normalizeCodexPolicyNames(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const normalized = name.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  for (const name of names) {
    switch (name) {
      case "Bash":
      case "Glob":
      case "Grep":
      case "Read":
        push(CODEX_COMMAND_EXECUTION_TOOL);
        break;
      case "Edit":
      case "MultiEdit":
      case "Write":
        push(CODEX_FILE_CHANGE_TOOL);
        break;
      default:
        push(name);
        break;
    }
  }
  return out;
}

function withPolicyApplied(
  provider: ProviderName,
  baseOptions: ProviderOptions,
  policy: { mode: "allow" | "deny"; names: string[] },
): ProviderOptions {
  const existingAllow = asStringList(baseOptions.allowedTools);
  const existingDeny = asStringList(baseOptions.disallowedTools);
  if (existingAllow.length > 0 && existingDeny.length > 0) {
    throw new Error(`provider_options.${provider} cannot specify both allowedTools and disallowedTools`);
  }

  if (provider === "claude") {
    if (policy.mode === "allow") {
      if (existingDeny.length > 0) {
        throw new Error("sdk_builtin_tools.claude.allow conflicts with provider_options.claude.disallowedTools");
      }
      if (hasConfiguredTools(baseOptions.tools)) {
        throw new Error("sdk_builtin_tools.claude.allow conflicts with provider_options.claude.tools");
      }
      return {
        ...baseOptions,
        tools: [...policy.names],
      };
    }
    if (existingAllow.length > 0) {
      throw new Error("sdk_builtin_tools.claude.deny conflicts with provider_options.claude.allowedTools");
    }
    return { ...baseOptions, disallowedTools: [...policy.names] };
  }

  if (provider === "mock") {
    // MockProvider does not expose builtin SDK tools; keep the configured policy
    // valid for config parity, but do not try to translate it into provider options.
    return { ...baseOptions };
  }

  if (provider === "codex") {
    const normalizedNames = normalizeCodexPolicyNames(policy.names);
    if (policy.mode === "allow") {
      if (existingDeny.length > 0) {
        throw new Error("sdk_builtin_tools.codex.allow conflicts with provider_options.codex.disallowedTools");
      }
      return { ...baseOptions, allowedTools: normalizedNames };
    }
    if (existingAllow.length > 0) {
      throw new Error("sdk_builtin_tools.codex.deny conflicts with provider_options.codex.allowedTools");
    }
    return { ...baseOptions, disallowedTools: [...normalizedNames] };
  }

  throw new Error(`sdk_builtin_tools.${provider} is not supported`);
}

export function applySdkBuiltinToolsToProviderOptions(args: {
  provider: ProviderName;
  providerOptions?: Record<string, unknown>;
  sdkBuiltinTools?: RunConfigSdkBuiltinTools;
  label?: string;
}): Record<string, unknown> | undefined {
  const providers = Object.keys(args.sdkBuiltinTools ?? {}).filter((key) => Boolean(args.sdkBuiltinTools?.[key as ProviderName]));
  const policy = args.sdkBuiltinTools?.[args.provider];
  const base = args.providerOptions ? { ...args.providerOptions } : {};
  if (providers.length > 0 && !policy) {
    const label = args.label ?? "sdk_builtin_tools";
    throw new Error(`${label} is configured for ${providers.join("|")} but missing active provider '${args.provider}'`);
  }
  if (!policy) {
    return Object.keys(base).length ? base : undefined;
  }
  const withPolicy = withPolicyApplied(args.provider, base, policy);
  return Object.keys(withPolicy).length ? withPolicy : undefined;
}
