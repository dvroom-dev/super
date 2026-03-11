export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type RunConfigRuntimeDefaults = {
  provider?: "codex" | "claude" | "gemini" | "mock";
  model?: string;
  agentProvider?: "codex" | "claude" | "gemini" | "mock";
  agentModel?: string;
  supervisorProvider?: "codex" | "claude" | "gemini" | "mock";
  supervisorModel?: string;
  modelReasoningEffort?: ReasoningEffort;
  agentModelReasoningEffort?: ReasoningEffort;
  supervisorModelReasoningEffort?: ReasoningEffort;
  providerOptions?: Partial<Record<"codex" | "claude" | "gemini" | "mock", Record<string, unknown>>>;
};

type ConfigRecord = Record<string, unknown>;

function asRecord(value: unknown): ConfigRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ConfigRecord;
}

function normalizeProvider(raw: unknown, sourcePath: string): "codex" | "claude" | "gemini" | "mock" | undefined {
  if (raw == null) return undefined;
  const provider = String(raw).trim().toLowerCase();
  if (provider === "codex" || provider === "claude" || provider === "gemini" || provider === "mock") return provider;
  throw new Error(`${sourcePath}: runtime_defaults.provider must be codex|claude|gemini|mock`);
}

function normalizeModel(raw: unknown, sourcePath: string): string | undefined {
  if (raw == null) return undefined;
  const model = String(raw).trim();
  if (!model) throw new Error(`${sourcePath}: runtime_defaults.model must be a non-empty string`);
  return model;
}

export function normalizeReasoningEffort(raw: unknown, fieldPath: string): ReasoningEffort | undefined {
  if (raw == null) return undefined;
  const effort = String(raw).trim().toLowerCase();
  if (effort === "minimal" || effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") {
    return effort;
  }
  throw new Error(`${fieldPath} must be minimal|low|medium|high|xhigh`);
}

export function normalizeRuntimeDefaults(raw: unknown, sourcePath: string): RunConfigRuntimeDefaults | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${sourcePath}: runtime_defaults must be a mapping`);
  }
  const provider = normalizeProvider(obj.provider, sourcePath);
  const model = normalizeModel(obj.model, sourcePath);
  const agentProvider = normalizeProvider(obj.agent_provider ?? obj.agentProvider, sourcePath);
  const agentModel = normalizeModel(obj.agent_model ?? obj.agentModel, sourcePath);
  const supervisorProvider = normalizeProvider(obj.supervisor_provider ?? obj.supervisorProvider, sourcePath);
  const supervisorModel = normalizeModel(obj.supervisor_model ?? obj.supervisorModel, sourcePath);
  const modelReasoningEffort = normalizeReasoningEffort(
    obj.model_reasoning_effort ?? obj.modelReasoningEffort,
    `${sourcePath}: runtime_defaults.model_reasoning_effort`,
  );
  const agentModelReasoningEffort = normalizeReasoningEffort(
    obj.agent_model_reasoning_effort ?? obj.agentModelReasoningEffort,
    `${sourcePath}: runtime_defaults.agent_model_reasoning_effort`,
  );
  const supervisorModelReasoningEffort = normalizeReasoningEffort(
    obj.supervisor_model_reasoning_effort ?? obj.supervisorModelReasoningEffort,
    `${sourcePath}: runtime_defaults.supervisor_model_reasoning_effort`,
  );
  const rawProviderOptions = asRecord(obj.provider_options ?? obj.providerOptions);
  const providerOptions = rawProviderOptions
    ? (Object.fromEntries(
        Object.entries(rawProviderOptions).map(([providerName, options]) => {
          if (providerName !== "codex" && providerName !== "claude" && providerName !== "gemini" && providerName !== "mock") {
            throw new Error(`${sourcePath}: runtime_defaults.provider_options.${providerName} must target codex|claude|gemini|mock`);
          }
          const parsedOptions = asRecord(options);
          if (!parsedOptions) {
            throw new Error(`${sourcePath}: runtime_defaults.provider_options.${providerName} must be a mapping`);
          }
          return [providerName, parsedOptions];
        }),
      ) as RunConfigRuntimeDefaults["providerOptions"])
    : undefined;
  if (
    !provider &&
    !model &&
    !agentProvider &&
    !agentModel &&
    !supervisorProvider &&
    !supervisorModel &&
    !modelReasoningEffort &&
    !agentModelReasoningEffort &&
    !supervisorModelReasoningEffort &&
    !providerOptions
  ) {
    return undefined;
  }
  return {
    provider,
    model,
    agentProvider,
    agentModel,
    supervisorProvider,
    supervisorModel,
    modelReasoningEffort,
    agentModelReasoningEffort,
    supervisorModelReasoningEffort,
    providerOptions,
  };
}
