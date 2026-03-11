import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { type ContextManagementStrategy, normalizeContextManagementStrategy } from "./context_management.js";
import type { PromptContent } from "../utils/prompt_content.js";
import { RUN_CONFIG_PRESETS, type RunConfigPresetName, resolvePresetRules } from "./presets.js";
import { renderSystemMessage, renderUserMessage, renderOutputSchema, type RenderScopeRoots } from "./run_config_render.js";
import { normalizeSupervisorConfig, normalizeSupervisorInterjectionTemplates, type SupervisorMessageTemplate, type RunConfigSupervisor } from "./run_config_supervisor.js";
import { cloneSupervisorTriggers, mergeSupervisorTriggers, normalizeSupervisorTriggers, type SupervisorPromptTrigger, type SupervisorTriggerEntry, type SupervisorTriggers } from "./run_config_supervisor_triggers.js";
import { normalizeCycleLimit, normalizeHooks, type RunConfigHook } from "./run_config_hooks.js";
import { cloneToolsConfig, mergeToolsConfig, normalizeToolsConfig, type RunConfigTools } from "./run_config_tools.js";
import { cloneSdkBuiltinTools, normalizeSdkBuiltinTools, type RunConfigSdkBuiltinTools } from "./run_config_sdk_builtin_tools.js";
import { discoverRunConfigPaths } from "./run_config_discovery.js";
import { normalizeRuntimeDefaults, type RunConfigRuntimeDefaults } from "./run_config_runtime_defaults.js";
import { cloneModes, normalizeModeStateMachine, normalizeModes, type RunConfigMode, type RunConfigModeStateMachine } from "./run_config_modes.js";
import { mergeRunConfig, validateMergedConfig } from "./run_config_merge.js";
import { clonePromptPartsMap, normalizePromptPartsMap } from "./run_config_prompt_parts.js";
import { applyRuleList, applyAgentRuleList, asRecord, assertNoLegacyPromptKeys, combineSystemMessages, combineUserMessages, normalizeAgentRuleList, normalizeBoolean, normalizeOperation, normalizeOutputSchemaFile, normalizePresets, normalizePromptMessage, normalizeReviewTimeoutMs, normalizeRuleList, normalizeStopCondition, normalizeToolOutput } from "./run_config_helpers.js";
import { interpolateRunConfigVariables } from "./run_config_vars.js";
import type { ToolOutputConfig } from "../tools/tool_output.js";
export type RunConfigOperation = "append" | "replace";
export type RunConfigFileListScope = "config_file" | "agent_file" | "supervisor_file";
export type RunConfigPart =
  | { kind: "literal"; value: string; baseDir: string }
  | { kind: "file"; value: string; baseDir: string }
  | { kind: "config_file"; value: string; baseDir: string }
  | { kind: "agent_file"; value: string; baseDir: string }
  | { kind: "supervisor_file"; value: string; baseDir: string }
  | { kind: "prompt_part"; value: string; baseDir: string }
  | {
    kind: "files";
    value: string[];
    scope: RunConfigFileListScope;
    maxBytesPerFile?: number;
    strictFileExistence?: boolean;
    baseDir: string;
  }
  | { kind: "builtin"; value: "tools" | "message_templates"; baseDir: string }
  | { kind: "image"; value: string; baseDir: string }
  | { kind: "template"; value: string; baseDir: string };
export type RunConfigPromptMessage = {
  operation: RunConfigOperation;
  parts: RunConfigPart[];
  sourcePath: string;
};
export type RunConfigSystemMessage = RunConfigPromptMessage;
export type RunConfigUserMessage = RunConfigPromptMessage;
export type RunConfigStringList = {
  operation: RunConfigOperation;
  values: string[];
  sourcePath: string;
};
export type RunConfigAgentRules = {
  operation: RunConfigOperation;
  requirements: string[];
  violations: string[];
  sourcePath: string;
};
export type RenderedRunConfigAgentRules = {
  requirements: string[];
  violations: string[];
};
export type RunConfigModeDefinition = RunConfigMode<RunConfigPromptMessage, RunConfigPromptMessage, RunConfigAgentRules, RunConfigStringList, RunConfigTools>;
export type RenderedRunConfigModeDefinition = RunConfigMode<RenderedRunConfigMessage, RenderedRunConfigUserMessage, RenderedRunConfigAgentRules, string[], RunConfigTools>;
export type RunConfigSupervisorTriggerEntry = SupervisorTriggerEntry<RunConfigPromptMessage, SupervisorMessageTemplate>;
export type RenderedRunConfigSupervisorTriggerEntry = SupervisorTriggerEntry<RenderedRunConfigMessage, SupervisorMessageTemplate>;
export type RunConfigSupervisorTriggers = SupervisorTriggers<RunConfigPromptMessage, SupervisorMessageTemplate>;
export type RenderedRunConfigSupervisorTriggers = SupervisorTriggers<RenderedRunConfigMessage, SupervisorMessageTemplate>;
export type RunConfig = {
  sources: string[];
  presets?: RunConfigPresetName[];
  promptParts?: Record<string, RunConfigPart[]>;
  runtimeDefaults?: RunConfigRuntimeDefaults;
  tools?: RunConfigTools;
  sdkBuiltinTools?: RunConfigSdkBuiltinTools;
  supervisor?: RunConfigSupervisor;
  hooks?: RunConfigHook[];
  cycleLimit?: number;
  modesEnabled?: boolean;
  systemMessage?: RunConfigPromptMessage;
  supervisorSystemMessage?: RunConfigPromptMessage;
  userMessage?: RunConfigPromptMessage;
  stopCondition?: string;
  modes?: Record<string, RunConfigModeDefinition>;
  modeStateMachine?: RunConfigModeStateMachine;
  agentRules?: RunConfigAgentRules;
  supervisorInstructions?: RunConfigStringList;
  contextManagementStrategy?: ContextManagementStrategy;
  reviewTimeoutMs?: number;
  toolOutput?: ToolOutputConfig;
  outputSchemaFile?: { value: string; baseDir: string; sourcePath: string };
  supervisorTriggers?: RunConfigSupervisorTriggers;
};
export type RenderedRunConfigMessage = {
  operation: RunConfigOperation;
  text: string;
  images: string[];
  content: PromptContent;
};
export type RenderedRunConfigUserMessage = {
  operation: RunConfigOperation;
  text: string;
  content: PromptContent;
};
export type RenderedRunConfig = {
  sources: string[];
  presets: RunConfigPresetName[];
  promptParts?: Record<string, RunConfigPart[]>;
  runtimeDefaults?: RunConfigRuntimeDefaults;
  tools?: RunConfigTools;
  sdkBuiltinTools?: RunConfigSdkBuiltinTools;
  supervisor?: RunConfigSupervisor;
  hooks: RunConfigHook[];
  cycleLimit?: number;
  modesEnabled: boolean;
  systemMessage?: RenderedRunConfigMessage;
  supervisorSystemMessage?: RenderedRunConfigMessage;
  userMessage?: RenderedRunConfigUserMessage;
  stopCondition?: string;
  modes?: Record<string, RenderedRunConfigModeDefinition>;
  modeStateMachine?: RunConfigModeStateMachine;
  agentRules: RenderedRunConfigAgentRules;
  supervisorInstructions: string[];
  contextManagementStrategy?: ContextManagementStrategy;
  reviewTimeoutMs?: number;
  toolOutput?: ToolOutputConfig;
  outputSchema?: any;
  supervisorTriggers?: RenderedRunConfigSupervisorTriggers;
};
export type LoadRunConfigOptions = {
  explicitConfigPath?: string;
  globalHomeDir?: string;
  cliVars?: Record<string, string>;
};
export { discoverRunConfigPaths } from "./run_config_discovery.js";
const DEFAULT_SUPERVISOR_PROMPT_CONFIG = fileURLToPath(new URL("./defaults/supervisor_prompt_defaults.yaml", import.meta.url));
export function normalizeUserMessage(raw: unknown, sourcePath: string): RunConfigPromptMessage | undefined { return normalizePromptMessage(raw, "user_message", sourcePath); }
function clonePromptPart(part: RunConfigPart): RunConfigPart {
  if (part.kind === "files") {
    return {
      kind: "files",
      value: [...part.value],
      scope: part.scope,
      ...(part.maxBytesPerFile != null ? { maxBytesPerFile: part.maxBytesPerFile } : {}),
      ...(part.strictFileExistence != null ? { strictFileExistence: part.strictFileExistence } : {}),
      baseDir: part.baseDir,
    };
  }
  return { ...part };
}

const normalizeSupervisorPromptByTrigger = (
  raw: unknown,
  sourcePath: string,
): RunConfigSupervisorTriggers | undefined => normalizeSupervisorTriggers({
    raw,
    sourcePath,
    asRecord,
    normalizePrompt: normalizePromptMessage,
    normalizeMessageTemplates: normalizeSupervisorInterjectionTemplates,
  });
const cloneSupervisorPromptByTrigger = (
  raw: RunConfigSupervisorTriggers | undefined,
): RunConfigSupervisorTriggers | undefined => cloneSupervisorTriggers({
    raw,
    clonePrompt: (entry) => ({
      operation: entry.operation,
      parts: entry.parts.map((part) => clonePromptPart(part)),
      sourcePath: entry.sourcePath,
    }),
    cloneMessageTemplate: (entry) => ({
      name: entry.name,
      description: entry.description,
      messageType: entry.messageType,
      text: entry.text,
    }),
  });
let defaultSupervisorConfigBundlePromise: Promise<{ supervisor?: RunConfigSupervisor; supervisorTriggers?: RunConfigSupervisorTriggers }> | undefined;
async function loadDefaultSupervisorConfigBundle(): Promise<{ supervisor?: RunConfigSupervisor; supervisorTriggers?: RunConfigSupervisorTriggers }> {
  if (!defaultSupervisorConfigBundlePromise) {
    defaultSupervisorConfigBundlePromise = (async () => {
      try {
        const raw = await fs.readFile(DEFAULT_SUPERVISOR_PROMPT_CONFIG, "utf8");
        const parsed = YAML.parse(raw) as unknown;
        const obj = asRecord(parsed);
        if (!obj) return {};
        const supervisorObj = asRecord(obj.supervisor);
        if (obj.supervisor_prompt_by_trigger != null) {
          throw new Error(
            `${DEFAULT_SUPERVISOR_PROMPT_CONFIG}: supervisor_prompt_by_trigger has been renamed to supervisor.supervisor_triggers`,
          );
        }
        const promptByTriggerRaw = supervisorObj?.supervisor_triggers;
        return {
          supervisor: normalizeSupervisorConfig(obj.supervisor, DEFAULT_SUPERVISOR_PROMPT_CONFIG),
          supervisorTriggers: normalizeSupervisorPromptByTrigger(promptByTriggerRaw, DEFAULT_SUPERVISOR_PROMPT_CONFIG),
        };
      } catch (err: any) {
        if (err?.code === "ENOENT") return {};
        throw err;
      }
    })();
  }
  return defaultSupervisorConfigBundlePromise;
}
async function loadDefaultSupervisorConfig(): Promise<RunConfigSupervisor | undefined> {
  const bundle = await loadDefaultSupervisorConfigBundle();
  return bundle.supervisor ? { ...bundle.supervisor } : undefined;
}
async function loadDefaultSupervisorTriggers(): Promise<RunConfigSupervisorTriggers | undefined> {
  const bundle = await loadDefaultSupervisorConfigBundle();
  return cloneSupervisorPromptByTrigger(bundle.supervisorTriggers);
}
async function readRunConfigFile(
  configPath: string,
  inheritedVars: Record<string, string>,
  overrideVars: Record<string, string>,
): Promise<{ config: RunConfig; vars: Record<string, string> }> {
  const resolved = path.resolve(configPath);
  const raw = await fs.readFile(resolved, "utf8");
  const parsed = YAML.parse(raw) as unknown;
  const interpolated = interpolateRunConfigVariables({
    raw: parsed,
    sourcePath: resolved,
    inheritedVars,
    overrideVars,
  });
  const interpolatedRaw = interpolated.value;
  const obj = asRecord(interpolatedRaw);
  if (!obj) {
    throw new Error(`${resolved}: config must be a YAML mapping`);
  }
  assertNoLegacyPromptKeys(obj, resolved);

  const agentObjRaw = obj.agent;
  const agentObj = agentObjRaw == null ? undefined : asRecord(agentObjRaw);
  if (agentObjRaw != null && !agentObj) {
    throw new Error(`${resolved}: agent must be a mapping`);
  }
  const supervisorObj = asRecord(obj.supervisor);
  if (obj.supervisor != null && !supervisorObj) {
    throw new Error(`${resolved}: supervisor must be a mapping`);
  }
  if (obj.supervisor_prompt_by_trigger != null) {
    throw new Error(`${resolved}: supervisor_prompt_by_trigger has been renamed to supervisor.supervisor_triggers`);
  }
  const supervisorConfig = normalizeSupervisorConfig(obj.supervisor, resolved);
  const supervisorTriggers = normalizeSupervisorPromptByTrigger(
    supervisorObj?.supervisor_triggers,
    resolved,
  );
  const stopConditionRaw = supervisorObj?.stop_condition ?? supervisorConfig?.stopCondition;
  const normalizedModes = normalizeModes(obj.modes, resolved, {
    normalizeSystemMessage: (rawMessage, sourcePath) => normalizePromptMessage(rawMessage, "system_message", sourcePath),
    normalizeUserMessage,
    normalizeAgentRules: normalizeAgentRuleList,
    normalizeSupervisorInstructions: normalizeRuleList,
    normalizeTools: (rawTools, label, sourcePath) => normalizeToolsConfig(rawTools, `${sourcePath}: ${label}`),
  });
  const modeNames = new Set(Object.keys(normalizedModes ?? {}));
  const modeStateMachineRaw = obj.mode_state_machine;
  const presetsRaw = (() => {
    if (obj.presets != null || obj.preset != null) return obj.presets ?? obj.preset;
    if (obj.benchmark_strict === true) return ["benchmark_strict"];
    return undefined;
  })();
  const reviewTimeoutRaw = supervisorObj?.review_timeout_ms ?? supervisorConfig?.reviewTimeoutMs;
  const agentSystemMessageRaw = agentObj?.system_message;
  const agentUserMessageRaw = agentObj?.user_message;
  const agentRulesRaw = agentObj?.rules;
  const supervisorInstructionsRaw = supervisorObj?.instructions;
  const supervisorSystemMessageRaw = supervisorObj?.system_message;

  return {
    config: {
      sources: [resolved],
      presets: normalizePresets(presetsRaw, resolved),
      promptParts: normalizePromptPartsMap({
        raw: obj.prompt_parts ?? obj.promptParts,
        sourcePath: resolved,
        normalizePromptMessage,
      }),
      runtimeDefaults: normalizeRuntimeDefaults(obj.runtime_defaults, resolved),
      tools: normalizeToolsConfig(obj.tools, resolved),
      sdkBuiltinTools: normalizeSdkBuiltinTools(obj.sdk_builtin_tools, resolved),
      supervisor: supervisorConfig,
      hooks: normalizeHooks(obj.hooks, resolved),
      cycleLimit: normalizeCycleLimit(obj.cycle_limit, resolved),
      modesEnabled: normalizeBoolean(obj.modes_enabled, "modes_enabled", resolved),
      systemMessage: normalizePromptMessage(agentSystemMessageRaw, "agent.system_message", resolved),
      supervisorSystemMessage: normalizePromptMessage(
        supervisorSystemMessageRaw,
        "supervisor.system_message",
        resolved,
      ),
      userMessage: normalizePromptMessage(agentUserMessageRaw, "agent.user_message", resolved),
      stopCondition: normalizeStopCondition(stopConditionRaw, resolved),
      modes: normalizedModes,
      modeStateMachine: normalizeModeStateMachine(modeStateMachineRaw, resolved, modeNames),
      agentRules: normalizeAgentRuleList(agentRulesRaw, "agent.rules", resolved),
      supervisorInstructions: normalizeRuleList(
        supervisorInstructionsRaw,
        "supervisor.instructions",
        resolved,
      ),
      contextManagementStrategy: normalizeContextManagementStrategy(obj.context_management_strategy, resolved),
      reviewTimeoutMs: normalizeReviewTimeoutMs(reviewTimeoutRaw, resolved),
      toolOutput: normalizeToolOutput(obj.tool_output, resolved),
      outputSchemaFile: normalizeOutputSchemaFile(obj.output_schema_file, resolved),
      supervisorTriggers,
    },
    vars: interpolated.vars,
  };
}

export async function loadRunConfigForDirectory(cwd: string, options?: LoadRunConfigOptions): Promise<RunConfig | null> {
  const configPaths = options?.explicitConfigPath
    ? [path.resolve(cwd, options.explicitConfigPath)]
    : await discoverRunConfigPaths(cwd, options);
  if (configPaths.length === 0) return null;

  let merged: RunConfig | null = null;
  let resolvedVars: Record<string, string> = {};
  const overrideVars = options?.cliVars ?? {};
  for (const configPath of configPaths) {
    const loaded = await readRunConfigFile(configPath, resolvedVars, overrideVars);
    resolvedVars = loaded.vars;
    merged = mergeRunConfig(merged, loaded.config);
  }
  if (merged) validateMergedConfig(merged);
  return merged;
}
export async function renderRunConfig(
  config: RunConfig | null,
  roots?: RenderScopeRoots,
): Promise<RenderedRunConfig | null> {
  if (!config) config = { sources: [] };
  const presets = (config.presets ?? []).filter((preset) => (RUN_CONFIG_PRESETS as readonly string[]).includes(preset));
  const presetRules = resolvePresetRules(presets);
  const modesEnabled = config.modesEnabled ?? true;
  const systemMessage = await renderSystemMessage(config.systemMessage, config.tools, undefined, roots, config.promptParts);
  const supervisorSystemMessage = await renderSystemMessage(
    config.supervisorSystemMessage,
    config.tools,
    undefined,
    roots,
    config.promptParts,
  );
  const userMessage = await renderUserMessage(config.userMessage, config.tools, roots, config.promptParts);
  const baseAgentRules = applyAgentRuleList(
    { requirements: [...presetRules.agentRules], violations: [] },
    config.agentRules,
  );
  const baseSupervisorInstructions = applyRuleList([...presetRules.supervisorInstructions], config.supervisorInstructions);
  const mergedSupervisorPromptByTrigger = mergeSupervisorTriggers(
    await loadDefaultSupervisorTriggers(),
    config.supervisorTriggers,
  );
  const supervisorMessageTemplateGroups = mergedSupervisorPromptByTrigger
    ? Object.fromEntries(
        Object.entries(mergedSupervisorPromptByTrigger)
          .map(([trigger, entry]) => [trigger, entry.messageTemplates ?? []])
          .filter(([_trigger, templates]) => templates.length > 0),
      )
    : undefined;
  const supervisorTriggers = mergedSupervisorPromptByTrigger
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(mergedSupervisorPromptByTrigger).map(async ([trigger, entry]) => {
            const rendered: RenderedRunConfigSupervisorTriggerEntry = {
              ...(entry.messageTemplates
                ? {
                    messageTemplates: entry.messageTemplates.map((template) => ({
                      name: template.name,
                      description: template.description,
                      messageType: template.messageType,
                      text: template.text,
                    })),
                  }
                : {}),
              ...(entry.supervisorPrompt
                ? {
                    supervisorPrompt: await renderSystemMessage(
                      entry.supervisorPrompt,
                      config.tools,
                      supervisorMessageTemplateGroups,
                      roots,
                      config.promptParts,
                    ),
                  }
                : {}),
            };
            return [trigger, rendered];
          }),
        ),
      )
    : undefined;

  const modes = config.modes
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(config.modes).map(async ([modeName, mode]) => {
            const effectiveModeTools = mergeToolsConfig(config.tools, mode.tools);
            const modeSystem = await renderSystemMessage(mode.systemMessage, effectiveModeTools, undefined, roots, config.promptParts);
            const modeUser = await renderUserMessage(mode.userMessage, effectiveModeTools, roots, config.promptParts);
            const renderedMode: RenderedRunConfigModeDefinition = {
              systemMessage: combineSystemMessages(systemMessage, modeSystem),
              userMessage: combineUserMessages(userMessage, modeUser),
              agentRules: applyAgentRuleList(baseAgentRules, mode.agentRules),
              supervisorInstructions: applyRuleList(baseSupervisorInstructions, mode.supervisorInstructions),
              tools: cloneToolsConfig(effectiveModeTools),
              agentModelReasoningEffort: mode.agentModelReasoningEffort,
              supervisorModelReasoningEffort: mode.supervisorModelReasoningEffort,
              description: mode.description,
              startWhen: mode.startWhen ? [...mode.startWhen] : undefined,
              stopWhen: mode.stopWhen ? [...mode.stopWhen] : undefined,
            };
            return [modeName, renderedMode];
          }),
        ),
      )
    : undefined;

  const outputSchema = await renderOutputSchema(config.outputSchemaFile);
  const defaultSupervisor = await loadDefaultSupervisorConfig();
  let supervisor = defaultSupervisor || config.supervisor ? { ...(defaultSupervisor ?? {}), ...(config.supervisor ?? {}) } : undefined;
  if (typeof config.reviewTimeoutMs === "number") supervisor = { ...(supervisor ?? {}), reviewTimeoutMs: config.reviewTimeoutMs };
  const renderedSupervisor = supervisor
    ? {
        ...supervisor,
        ...(supervisor.toolInterception
          ? {
              toolInterception: {
                rules: supervisor.toolInterception.rules.map((rule) => ({
                  ...(rule.name ? { name: rule.name } : {}),
                  when: rule.when,
                  tool: rule.tool,
                  matchType: rule.matchType,
                  pattern: rule.pattern,
                  caseSensitive: rule.caseSensitive,
                  ...(rule.action ? { action: { ...rule.action } } : {}),
                })),
              },
            }
          : {}),
      } : undefined;
  return {
    sources: [...config.sources],
    presets: [...presets],
    promptParts: clonePromptPartsMap(config.promptParts),
    runtimeDefaults: config.runtimeDefaults ? { ...config.runtimeDefaults } : undefined,
    tools: cloneToolsConfig(config.tools),
    sdkBuiltinTools: cloneSdkBuiltinTools(config.sdkBuiltinTools),
    supervisor: renderedSupervisor,
    hooks: [...(config.hooks ?? [])],
    cycleLimit: config.cycleLimit,
    modesEnabled,
    systemMessage,
    supervisorSystemMessage,
    userMessage,
    stopCondition: config.stopCondition,
    modes: cloneModes(
      modes,
      (raw) => (raw ? { requirements: [...raw.requirements], violations: [...raw.violations] } : undefined),
      (raw) => (raw ? [...raw] : undefined),
      (raw) => cloneToolsConfig(raw),
    ),
    modeStateMachine: config.modeStateMachine
      ? {
          initialMode: config.modeStateMachine.initialMode,
          transitions: config.modeStateMachine.transitions
            ? Object.fromEntries(
                Object.entries(config.modeStateMachine.transitions).map(([from, to]) => [from, [...to]]),
              )
            : undefined,
        }
      : undefined,
    agentRules: { requirements: [...baseAgentRules.requirements], violations: [...baseAgentRules.violations] },
    supervisorInstructions: [...baseSupervisorInstructions],
    contextManagementStrategy: config.contextManagementStrategy,
    reviewTimeoutMs: config.reviewTimeoutMs,
    toolOutput: config.toolOutput ? { ...config.toolOutput } : undefined,
    outputSchema,
    supervisorTriggers: supervisorTriggers as RenderedRunConfigSupervisorTriggers | undefined,
  };
}
