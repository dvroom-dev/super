import { normalizeReasoningEffort, type ReasoningEffort } from "./run_config_runtime_defaults.js";

type ConfigRecord = Record<string, unknown>;

function asRecord(value: unknown): ConfigRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ConfigRecord;
}

function normalizeString(raw: unknown, sourcePath: string, label: string): string {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error(`${sourcePath}: ${label} must be a non-empty string`);
  return value;
}

function normalizeStringList(raw: unknown, sourcePath: string, label: string): string[] | undefined {
  if (raw == null) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const value = String(entry ?? "").trim();
    if (!value) throw new Error(`${sourcePath}: ${label} must contain only non-empty strings`);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length ? out : undefined;
}

export type RunConfigModelCatalogEntry = {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  providerOptions?: Record<string, unknown>;
};

export type RunConfigValidatorSuccess =
  | { type: "exit_code"; equals?: number }
  | { type: "json_field_truthy"; field: string }
  | { type: "json_field_equals"; field: string; equals: string | number | boolean }
  | { type: "text_contains"; contains: string }
  | { type: "text_not_contains"; contains: string };

export type RunConfigValidator = {
  description?: string;
  command: string;
  cwdScope?: "workspace" | "agent" | "supervisor";
  parseAs?: "text" | "json";
  success?: RunConfigValidatorSuccess;
};

export type RunConfigTaskProfile = {
  mode: string;
  description?: string;
  preferredModels?: string[];
  validators?: string[];
  contextRules?: string[];
  resumeStrategy?: "same_conversation" | "fork_fresh";
};

export type RunConfigProcessStage = {
  description?: string;
  objective?: string;
  profile: string;
  validators?: string[];
  allowedNextProfiles?: string[];
};

export type RunConfigProcess = {
  initialStage?: string;
  globalRules?: string[];
  ledgerPath?: string;
  stages?: Record<string, RunConfigProcessStage>;
};

export function normalizeSchemaVersion(raw: unknown, sourcePath: string): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${sourcePath}: schema_version must be a positive number`);
  return Math.floor(value);
}

export function normalizeModelCatalog(raw: unknown, sourcePath: string): Record<string, RunConfigModelCatalogEntry> | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: models must be a mapping`);
  const out: Record<string, RunConfigModelCatalogEntry> = {};
  for (const [key, value] of Object.entries(obj)) {
    const entry = asRecord(value);
    if (!entry) throw new Error(`${sourcePath}: models.${key} must be a mapping`);
    const providerOptions = entry.provider_options == null
      ? undefined
      : asRecord(entry.provider_options) ?? (() => { throw new Error(`${sourcePath}: models.${key}.provider_options must be a mapping`); })();
    const sandboxMode = entry.sandbox_mode == null ? undefined : normalizeString(entry.sandbox_mode, sourcePath, `models.${key}.sandbox_mode`);
    if (sandboxMode && !["read-only", "workspace-write", "danger-full-access"].includes(sandboxMode)) {
      throw new Error(`${sourcePath}: models.${key}.sandbox_mode must be read-only|workspace-write|danger-full-access`);
    }
    out[key] = {
      provider: normalizeString(entry.provider, sourcePath, `models.${key}.provider`),
      model: normalizeString(entry.model, sourcePath, `models.${key}.model`),
      reasoningEffort: normalizeReasoningEffort(entry.reasoning_effort, `${sourcePath}: models.${key}.reasoning_effort`),
      sandboxMode: sandboxMode as RunConfigModelCatalogEntry["sandboxMode"],
      providerOptions: providerOptions ? { ...providerOptions } : undefined,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeValidators(raw: unknown, sourcePath: string): Record<string, RunConfigValidator> | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: validators must be a mapping`);
  const out: Record<string, RunConfigValidator> = {};
  for (const [key, value] of Object.entries(obj)) {
    const entry = asRecord(value);
    if (!entry) throw new Error(`${sourcePath}: validators.${key} must be a mapping`);
    const successRaw = entry.success;
    let success: RunConfigValidatorSuccess | undefined;
    if (successRaw != null) {
      const successObj = asRecord(successRaw);
      if (!successObj) throw new Error(`${sourcePath}: validators.${key}.success must be a mapping`);
      const type = normalizeString(successObj.type, sourcePath, `validators.${key}.success.type`) as RunConfigValidatorSuccess["type"];
      if (type === "exit_code") success = { type, equals: successObj.equals == null ? 0 : Number(successObj.equals) };
      else if (type === "json_field_truthy") success = { type, field: normalizeString(successObj.field, sourcePath, `validators.${key}.success.field`) };
      else if (type === "json_field_equals") success = {
        type,
        field: normalizeString(successObj.field, sourcePath, `validators.${key}.success.field`),
        equals: successObj.equals as string | number | boolean,
      };
      else if (type === "text_contains" || type === "text_not_contains") {
        success = { type, contains: normalizeString(successObj.contains, sourcePath, `validators.${key}.success.contains`) };
      } else {
        throw new Error(`${sourcePath}: validators.${key}.success.type is unsupported`);
      }
    }
    const cwdScope = entry.cwd_scope == null ? undefined : normalizeString(entry.cwd_scope, sourcePath, `validators.${key}.cwd_scope`);
    if (cwdScope && !["workspace", "agent", "supervisor"].includes(cwdScope)) {
      throw new Error(`${sourcePath}: validators.${key}.cwd_scope must be workspace|agent|supervisor`);
    }
    const parseAs = entry.parse_as == null ? undefined : normalizeString(entry.parse_as, sourcePath, `validators.${key}.parse_as`);
    if (parseAs && !["text", "json"].includes(parseAs)) {
      throw new Error(`${sourcePath}: validators.${key}.parse_as must be text|json`);
    }
    out[key] = {
      description: entry.description == null ? undefined : normalizeString(entry.description, sourcePath, `validators.${key}.description`),
      command: normalizeString(entry.command, sourcePath, `validators.${key}.command`),
      cwdScope: cwdScope as RunConfigValidator["cwdScope"],
      parseAs: parseAs as RunConfigValidator["parseAs"],
      success,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeTaskProfiles(raw: unknown, sourcePath: string): Record<string, RunConfigTaskProfile> | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: task_profiles must be a mapping`);
  const out: Record<string, RunConfigTaskProfile> = {};
  for (const [key, value] of Object.entries(obj)) {
    const entry = asRecord(value);
    if (!entry) throw new Error(`${sourcePath}: task_profiles.${key} must be a mapping`);
    const resumeStrategy = entry.resume_strategy == null ? undefined : normalizeString(entry.resume_strategy, sourcePath, `task_profiles.${key}.resume_strategy`);
    if (resumeStrategy && !["same_conversation", "fork_fresh"].includes(resumeStrategy)) {
      throw new Error(`${sourcePath}: task_profiles.${key}.resume_strategy must be same_conversation|fork_fresh`);
    }
    out[key] = {
      mode: normalizeString(entry.mode, sourcePath, `task_profiles.${key}.mode`),
      description: entry.description == null ? undefined : normalizeString(entry.description, sourcePath, `task_profiles.${key}.description`),
      preferredModels: normalizeStringList(entry.preferred_models, sourcePath, `task_profiles.${key}.preferred_models`),
      validators: normalizeStringList(entry.validators, sourcePath, `task_profiles.${key}.validators`),
      contextRules: normalizeStringList(entry.context_rules, sourcePath, `task_profiles.${key}.context_rules`),
      resumeStrategy: resumeStrategy as RunConfigTaskProfile["resumeStrategy"],
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeProcess(raw: unknown, sourcePath: string): RunConfigProcess | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) throw new Error(`${sourcePath}: process must be a mapping`);
  const stagesRaw = asRecord(obj.stages);
  if (obj.stages != null && !stagesRaw) throw new Error(`${sourcePath}: process.stages must be a mapping`);
  const stages: Record<string, RunConfigProcessStage> = {};
  for (const [key, value] of Object.entries(stagesRaw ?? {})) {
    const entry = asRecord(value);
    if (!entry) throw new Error(`${sourcePath}: process.stages.${key} must be a mapping`);
    stages[key] = {
      description: entry.description == null ? undefined : normalizeString(entry.description, sourcePath, `process.stages.${key}.description`),
      objective: entry.objective == null ? undefined : normalizeString(entry.objective, sourcePath, `process.stages.${key}.objective`),
      profile: normalizeString(entry.profile, sourcePath, `process.stages.${key}.profile`),
      validators: normalizeStringList(entry.validators, sourcePath, `process.stages.${key}.validators`),
      allowedNextProfiles: normalizeStringList(entry.allowed_next_profiles, sourcePath, `process.stages.${key}.allowed_next_profiles`),
    };
  }
  return {
    initialStage: obj.initial_stage == null ? undefined : normalizeString(obj.initial_stage, sourcePath, "process.initial_stage"),
    globalRules: normalizeStringList(obj.global_rules, sourcePath, "process.global_rules"),
    ledgerPath: obj.ledger_path == null ? undefined : normalizeString(obj.ledger_path, sourcePath, "process.ledger_path"),
    stages: Object.keys(stages).length ? stages : undefined,
  };
}
