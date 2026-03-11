import { normalizeReasoningEffort, type ReasoningEffort } from "./run_config_runtime_defaults.js";

export type RunConfigModeStateMachine = {
  initialMode?: string;
  transitions?: Record<string, string[]>;
};

export type RunConfigMode<
  TSystemMessage,
  TUserMessage,
  TAgentRuleList = string[],
  TSupervisorInstructionList = string[],
  TTools = undefined,
> = {
  systemMessage?: TSystemMessage;
  userMessage?: TUserMessage;
  agentRules?: TAgentRuleList;
  supervisorInstructions?: TSupervisorInstructionList;
  tools?: TTools;
  agentModelReasoningEffort?: ReasoningEffort;
  supervisorModelReasoningEffort?: ReasoningEffort;
  description?: string;
  startWhen?: string[];
  stopWhen?: string[];
};

type ConfigRecord = Record<string, unknown>;

type ModeNormalizeHelpers<
  TSystemMessage,
  TUserMessage,
  TAgentRuleList,
  TSupervisorInstructionList,
  TTools,
> = {
  normalizeSystemMessage: (raw: unknown, sourcePath: string) => TSystemMessage | undefined;
  normalizeUserMessage: (raw: unknown, sourcePath: string) => TUserMessage | undefined;
  normalizeAgentRules: (raw: unknown, label: string, sourcePath: string) => TAgentRuleList | undefined;
  normalizeSupervisorInstructions: (
    raw: unknown,
    label: string,
    sourcePath: string,
  ) => TSupervisorInstructionList | undefined;
  normalizeTools?: (raw: unknown, label: string, sourcePath: string) => TTools | undefined;
};

function asRecord(value: unknown): ConfigRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ConfigRecord;
}

function normalizeModeName(raw: unknown, sourcePath: string, label: string): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw new Error(`${sourcePath}: ${label} must be a non-empty string`);
  }
  return value;
}

function normalizeTransitionList(raw: unknown, sourcePath: string, label: string): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const mode = normalizeModeName(value, sourcePath, label);
    if (seen.has(mode)) continue;
    seen.add(mode);
    out.push(mode);
  }
  return out;
}

function normalizeOptionalString(raw: unknown, sourcePath: string, label: string): string | undefined {
  if (raw == null) return undefined;
  const value = String(raw ?? "").trim();
  if (!value) {
    throw new Error(`${sourcePath}: ${label} must be a non-empty string`);
  }
  return value;
}

export function normalizeModeStateMachine(
  raw: unknown,
  sourcePath: string,
  modeNames?: Set<string>,
): RunConfigModeStateMachine | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${sourcePath}: mode_state_machine must be a mapping`);
  }

  const initialModeRaw = obj.initial_mode ?? obj.initialMode;
  const transitionsRaw = obj.transitions;

  const initialMode = initialModeRaw == null ? undefined : normalizeModeName(initialModeRaw, sourcePath, "mode_state_machine.initial_mode");
  if (initialMode && modeNames && !modeNames.has(initialMode)) {
    throw new Error(`${sourcePath}: mode_state_machine.initial_mode references unknown mode '${initialMode}'`);
  }

  let transitions: Record<string, string[]> | undefined;
  if (transitionsRaw != null) {
    const transitionsObj = asRecord(transitionsRaw);
    if (!transitionsObj) {
      throw new Error(`${sourcePath}: mode_state_machine.transitions must be a mapping`);
    }
    transitions = {};
    for (const [fromRaw, toRaw] of Object.entries(transitionsObj)) {
      const from = normalizeModeName(fromRaw, sourcePath, "mode_state_machine.transitions key");
      if (modeNames && !modeNames.has(from)) {
        throw new Error(`${sourcePath}: mode_state_machine.transitions references unknown mode '${from}'`);
      }
      const allowed = normalizeTransitionList(toRaw, sourcePath, `mode_state_machine.transitions.${from}`);
      if (modeNames) {
        for (const to of allowed) {
          if (!modeNames.has(to)) {
            throw new Error(`${sourcePath}: mode_state_machine.transitions.${from} references unknown mode '${to}'`);
          }
        }
      }
      transitions[from] = allowed;
    }
  }

  if (!initialMode && !transitions) return undefined;
  return { initialMode, transitions };
}

export function normalizeModes<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>(
  raw: unknown,
  sourcePath: string,
  helpers: ModeNormalizeHelpers<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>,
): Record<string, RunConfigMode<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>> | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${sourcePath}: modes must be a mapping`);
  }

  const out: Record<
    string,
    RunConfigMode<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>
  > = {};
  for (const [modeNameRaw, modeConfigRaw] of Object.entries(obj)) {
    const modeName = normalizeModeName(modeNameRaw, sourcePath, "modes key");
    const modeConfig = asRecord(modeConfigRaw);
    if (!modeConfig) {
      throw new Error(`${sourcePath}: modes.${modeName} must be a mapping`);
    }
    const systemRaw = modeConfig.system_message;
    const userRaw = modeConfig.user_message;
    if (userRaw == null) {
      throw new Error(`${sourcePath}: modes.${modeName}.user_message is required`);
    }
    const agentRulesRaw = modeConfig.agent_rules;
    const supervisorInstructionsRaw = modeConfig.supervisor_instructions;
    const toolsRaw = modeConfig.tools;
    const agentModelReasoningEffortRaw =
      modeConfig.agent_model_reasoning_effort ?? modeConfig.agentModelReasoningEffort;
    const supervisorModelReasoningEffortRaw =
      modeConfig.supervisor_model_reasoning_effort ?? modeConfig.supervisorModelReasoningEffort;
    const descriptionRaw = modeConfig.description;
    for (const legacyKey of ["switch_when", "switch_to_this_mode_when"] as const) {
      if (legacyKey in modeConfig) {
        throw new Error(
          `${sourcePath}: modes.${modeName}.${legacyKey} is no longer supported; use start_when (and optionally stop_when)`,
        );
      }
    }
    const startWhenRaw = modeConfig.start_when;
    const stopWhenRaw = modeConfig.stop_when;
    out[modeName] = {
      systemMessage: helpers.normalizeSystemMessage(systemRaw, sourcePath),
      userMessage: helpers.normalizeUserMessage(userRaw, sourcePath),
      agentRules: helpers.normalizeAgentRules(agentRulesRaw, `modes.${modeName}.agent_rules`, sourcePath),
      supervisorInstructions: helpers.normalizeSupervisorInstructions(
        supervisorInstructionsRaw,
        `modes.${modeName}.supervisor_instructions`,
        sourcePath,
      ),
      tools: helpers.normalizeTools?.(toolsRaw, `modes.${modeName}.tools`, sourcePath),
      agentModelReasoningEffort: normalizeReasoningEffort(
        agentModelReasoningEffortRaw,
        `${sourcePath}: modes.${modeName}.agent_model_reasoning_effort`,
      ),
      supervisorModelReasoningEffort: normalizeReasoningEffort(
        supervisorModelReasoningEffortRaw,
        `${sourcePath}: modes.${modeName}.supervisor_model_reasoning_effort`,
      ),
      description: normalizeOptionalString(descriptionRaw, sourcePath, `modes.${modeName}.description`),
      startWhen: startWhenRaw == null
        ? undefined
        : normalizeTransitionList(startWhenRaw, sourcePath, `modes.${modeName}.start_when`),
      stopWhen: stopWhenRaw == null
        ? undefined
        : normalizeTransitionList(stopWhenRaw, sourcePath, `modes.${modeName}.stop_when`),
    };
  }

  return Object.keys(out).length ? out : undefined;
}

export function mergeModes<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>(
  left: Record<string, RunConfigMode<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>> | undefined,
  right: Record<string, RunConfigMode<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>> | undefined,
  cloneAgentRules?: (raw: TAgentRuleList | undefined) => TAgentRuleList | undefined,
  cloneSupervisorInstructions?: (
    raw: TSupervisorInstructionList | undefined,
  ) => TSupervisorInstructionList | undefined,
  cloneTools?: (raw: TTools | undefined) => TTools | undefined,
): Record<string, RunConfigMode<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>> | undefined {
  if (!left && !right) return undefined;
  const out: Record<
    string,
    RunConfigMode<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>
  > = {};
  for (const [modeName, mode] of Object.entries(left ?? {})) {
    out[modeName] = {
      systemMessage: mode.systemMessage,
      userMessage: mode.userMessage,
      agentRules: cloneAgentRules ? cloneAgentRules(mode.agentRules) : mode.agentRules,
      supervisorInstructions: cloneSupervisorInstructions
        ? cloneSupervisorInstructions(mode.supervisorInstructions)
        : mode.supervisorInstructions,
      tools: cloneTools ? cloneTools(mode.tools) : mode.tools,
      agentModelReasoningEffort: mode.agentModelReasoningEffort,
      supervisorModelReasoningEffort: mode.supervisorModelReasoningEffort,
      description: mode.description,
      startWhen: mode.startWhen ? [...mode.startWhen] : undefined,
      stopWhen: mode.stopWhen ? [...mode.stopWhen] : undefined,
    };
  }
  for (const [modeName, mode] of Object.entries(right ?? {})) {
    out[modeName] = {
      systemMessage: mode.systemMessage,
      userMessage: mode.userMessage,
      agentRules: cloneAgentRules ? cloneAgentRules(mode.agentRules) : mode.agentRules,
      supervisorInstructions: cloneSupervisorInstructions
        ? cloneSupervisorInstructions(mode.supervisorInstructions)
        : mode.supervisorInstructions,
      tools: cloneTools ? cloneTools(mode.tools) : mode.tools,
      agentModelReasoningEffort: mode.agentModelReasoningEffort,
      supervisorModelReasoningEffort: mode.supervisorModelReasoningEffort,
      description: mode.description,
      startWhen: mode.startWhen ? [...mode.startWhen] : undefined,
      stopWhen: mode.stopWhen ? [...mode.stopWhen] : undefined,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export function cloneModes<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>(
  modes: Record<string, RunConfigMode<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>> | undefined,
  cloneAgentRules?: (raw: TAgentRuleList | undefined) => TAgentRuleList | undefined,
  cloneSupervisorInstructions?: (
    raw: TSupervisorInstructionList | undefined,
  ) => TSupervisorInstructionList | undefined,
  cloneTools?: (raw: TTools | undefined) => TTools | undefined,
): Record<string, RunConfigMode<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>> | undefined {
  if (!modes) return undefined;
  const out: Record<
    string,
    RunConfigMode<TSystemMessage, TUserMessage, TAgentRuleList, TSupervisorInstructionList, TTools>
  > = {};
  for (const [modeName, mode] of Object.entries(modes)) {
    out[modeName] = {
      systemMessage: mode.systemMessage,
      userMessage: mode.userMessage,
      agentRules: cloneAgentRules ? cloneAgentRules(mode.agentRules) : mode.agentRules,
      supervisorInstructions: cloneSupervisorInstructions
        ? cloneSupervisorInstructions(mode.supervisorInstructions)
        : mode.supervisorInstructions,
      tools: cloneTools ? cloneTools(mode.tools) : mode.tools,
      agentModelReasoningEffort: mode.agentModelReasoningEffort,
      supervisorModelReasoningEffort: mode.supervisorModelReasoningEffort,
      description: mode.description,
      startWhen: mode.startWhen ? [...mode.startWhen] : undefined,
      stopWhen: mode.stopWhen ? [...mode.stopWhen] : undefined,
    };
  }
  return out;
}
