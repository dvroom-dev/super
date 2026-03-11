import {
  cloneAgentRuleList,
  cloneRuleList,
  mergePresetLists,
} from "./run_config_helpers.js";
import { mergeModes } from "./run_config_modes.js";
import { mergeSdkBuiltinTools } from "./run_config_sdk_builtin_tools.js";
import { mergeSupervisorTriggers } from "./run_config_supervisor_triggers.js";
import { cloneToolsConfig, mergeToolsConfig } from "./run_config_tools.js";
import type { RunConfig } from "./run_config.js";
import type { ProviderName } from "../providers/types.js";

function clonePromptPart(part: NonNullable<RunConfig["promptParts"]>[string][number]) {
  if (part.kind !== "files") return { ...part };
  return {
    kind: "files" as const,
    value: [...part.value],
    scope: part.scope,
    ...(part.maxBytesPerFile != null ? { maxBytesPerFile: part.maxBytesPerFile } : {}),
    ...(part.strictFileExistence != null ? { strictFileExistence: part.strictFileExistence } : {}),
    baseDir: part.baseDir,
  };
}

function mergePromptParts(
  a?: RunConfig["promptParts"],
  b?: RunConfig["promptParts"],
): RunConfig["promptParts"] | undefined {
  if (!a && !b) return undefined;
  const out: NonNullable<RunConfig["promptParts"]> = {};
  for (const [name, parts] of Object.entries(a ?? {})) {
    out[name] = parts.map((part) => clonePromptPart(part));
  }
  for (const [name, parts] of Object.entries(b ?? {})) {
    out[name] = parts.map((part) => clonePromptPart(part));
  }
  return Object.keys(out).length ? out : undefined;
}

export function mergeRunConfig(a: RunConfig | null, b: RunConfig): RunConfig {
  if (!a) return b;
  return {
    sources: [...a.sources, ...b.sources],
    presets: mergePresetLists(a.presets, b.presets),
    promptParts: mergePromptParts(a.promptParts, b.promptParts),
    runtimeDefaults: b.runtimeDefaults ?? a.runtimeDefaults,
    tools: mergeToolsConfig(a.tools, b.tools),
    sdkBuiltinTools: mergeSdkBuiltinTools(a.sdkBuiltinTools, b.sdkBuiltinTools),
    supervisor: b.supervisor ?? a.supervisor,
    hooks: b.hooks ?? a.hooks,
    cycleLimit: b.cycleLimit ?? a.cycleLimit,
    modesEnabled: b.modesEnabled ?? a.modesEnabled,
    systemMessage: b.systemMessage ?? a.systemMessage,
    supervisorSystemMessage: b.supervisorSystemMessage ?? a.supervisorSystemMessage,
    userMessage: b.userMessage ?? a.userMessage,
    stopCondition: b.stopCondition ?? a.stopCondition,
    modes: mergeModes(a.modes, b.modes, cloneAgentRuleList, cloneRuleList, cloneToolsConfig),
    modeStateMachine: b.modeStateMachine ?? a.modeStateMachine,
    agentRules: b.agentRules ?? a.agentRules,
    supervisorInstructions: b.supervisorInstructions ?? a.supervisorInstructions,
    contextManagementStrategy: b.contextManagementStrategy ?? a.contextManagementStrategy,
    reviewTimeoutMs: b.reviewTimeoutMs ?? a.reviewTimeoutMs,
    toolOutput: b.toolOutput ?? a.toolOutput,
    outputSchemaFile: b.outputSchemaFile ?? a.outputSchemaFile,
    supervisorTriggers: mergeSupervisorTriggers(a.supervisorTriggers, b.supervisorTriggers),
  };
}

export function validateMergedConfig(config: RunConfig): void {
  const validateProviderSpecificTools = (
    provider: ProviderName | undefined,
    label: string,
    tools: RunConfig["tools"] | undefined,
  ) => {
    if (!provider || !tools) return;
    const builtinProviders = Object.keys(tools.providerBuiltinTools ?? {}).filter((key) => Boolean(tools.providerBuiltinTools?.[key as ProviderName]));
    if (builtinProviders.length > 0 && !tools.providerBuiltinTools?.[provider]) {
      throw new Error(`${label}.provider_builtin_tools is configured for ${builtinProviders.join("|")} but missing runtime_defaults.agent_provider '${provider}'`);
    }
    const filesystemProviders = Object.keys(tools.providerFilesystem ?? {}).filter((key) => Boolean(tools.providerFilesystem?.[key as ProviderName]));
    if (filesystemProviders.length > 0 && !tools.providerFilesystem?.[provider]) {
      throw new Error(`${label}.provider_filesystem is configured for ${filesystemProviders.join("|")} but missing runtime_defaults.agent_provider '${provider}'`);
    }
  };

  const configuredAgentProvider = config.runtimeDefaults?.agentProvider ?? config.runtimeDefaults?.provider;
  validateProviderSpecificTools(configuredAgentProvider, "tools", config.tools);
  for (const [modeName, mode] of Object.entries(config.modes ?? {})) {
    validateProviderSpecificTools(configuredAgentProvider, `modes.${modeName}.tools`, mode.tools);
  }

  const modesEnabled = config.modesEnabled ?? true;
  const modeNames = Object.keys(config.modes ?? {});
  const initialMode = config.modeStateMachine?.initialMode;

  if (!modesEnabled) {
    if (config.modes) {
      throw new Error("run-config: modes_enabled=false cannot define modes");
    }
    if (config.modeStateMachine) {
      throw new Error("run-config: modes_enabled=false cannot define mode_state_machine");
    }
    const missing: string[] = [];
    if (!config.systemMessage) missing.push("agent.system_message");
    if (!config.userMessage) missing.push("agent.user_message");
    if (!config.agentRules) missing.push("agent.rules");
    if (!config.supervisorInstructions) missing.push("supervisor.instructions");
    if (missing.length) {
      throw new Error(`run-config: modes_enabled=false requires ${missing.join(", ")}`);
    }
    return;
  }

  if (modeNames.length === 0) {
    throw new Error("run-config: modes_enabled=true requires at least one mode in modes");
  }
  if (!initialMode) {
    throw new Error("run-config: modes_enabled=true requires mode_state_machine.initial_mode");
  }
  if (!modeNames.includes(initialMode)) {
    throw new Error(`run-config: mode_state_machine.initial_mode references unknown mode '${initialMode}'`);
  }

  const transitions = config.modeStateMachine?.transitions;
  if (!transitions) return;
  const knownModes = new Set(modeNames);
  for (const [from, targets] of Object.entries(transitions)) {
    if (!knownModes.has(from)) {
      throw new Error(`run-config: mode_state_machine.transitions references unknown mode '${from}'`);
    }
    for (const target of targets) {
      if (!knownModes.has(target)) {
        throw new Error(`run-config: mode_state_machine.transitions.${from} references unknown mode '${target}'`);
      }
    }
  }
}
