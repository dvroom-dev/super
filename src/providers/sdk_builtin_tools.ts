import type { ProviderName } from "./types.js";
import type { RunConfigSdkBuiltinTools } from "../supervisor/run_config_sdk_builtin_tools.js";

type ProviderOptions = Record<string, unknown>;

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
