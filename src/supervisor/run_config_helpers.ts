import path from "node:path";
import { normalizeToolOutputConfig, type ToolOutputConfig } from "../tools/tool_output.js";
import {
  concatPromptContent,
  dedupePromptImages,
  promptContentToMarkdown,
  promptContentToPlainText,
} from "../utils/prompt_content.js";
import { normalizePresetName, type RunConfigPresetName } from "./presets.js";
import type {
  RenderedRunConfigAgentRules,
  RenderedRunConfigMessage,
  RenderedRunConfigUserMessage,
  RunConfigAgentRules,
  RunConfigFileListScope,
  RunConfigOperation,
  RunConfigPart,
  RunConfigPromptMessage,
  RunConfigStringList,
} from "./run_config.js";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeOperation(raw: unknown, label: string, sourcePath: string): RunConfigOperation {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "append" || value === "replace") return value;
  throw new Error(`${sourcePath}: ${label}.operation is required and must be append|replace`);
}

export function normalizeBoolean(raw: unknown, label: string, sourcePath: string): boolean | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "boolean") throw new Error(`${sourcePath}: ${label} must be true or false`);
  return raw;
}

function normalizeBuiltin(raw: string, sourcePath: string): "tools" | "message_templates" {
  const key = raw.trim().toLowerCase();
  if (key === "tools" || key === "tool_definitions" || key === "tool-definitions") {
    return "tools";
  }
  if (key === "message_templates" || key === "message-templates") {
    return "message_templates";
  }
  throw new Error(`${sourcePath}: unsupported builtin '${raw}'`);
}

function normalizeNonNegativeInteger(raw: unknown, label: string, sourcePath: string): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`${sourcePath}: ${label} must be a non-negative integer`);
  }
  return raw;
}

function normalizeFileListScope(raw: unknown, sourcePath: string): RunConfigFileListScope {
  if (raw == null) return "config_file";
  const value = String(raw).trim().toLowerCase();
  if (value === "config" || value === "config_file") return "config_file";
  if (value === "agent" || value === "agent_file") return "agent_file";
  if (value === "supervisor" || value === "supervisor_file") return "supervisor_file";
  throw new Error(`${sourcePath}: part 'files.scope' must be config|agent|supervisor`);
}

function normalizeFileListPaths(raw: unknown, sourcePath: string): string[] {
  if (raw == null) {
    throw new Error(`${sourcePath}: part 'files' must include at least one file path`);
  }
  const items = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new Error(`${sourcePath}: part 'files' entries must be strings`);
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw new Error(`${sourcePath}: part 'files' entries must be non-empty strings`);
    }
    out.push(trimmed);
  }
  if (out.length === 0) {
    throw new Error(`${sourcePath}: part 'files' must include at least one file path`);
  }
  return out;
}

function normalizeFilesPart(raw: unknown, baseDir: string, sourcePath: string): RunConfigPart {
  const obj = asRecord(raw);
  if (!obj) {
    return { kind: "files", value: normalizeFileListPaths(raw, sourcePath), scope: "config_file", baseDir };
  }
  const hasPaths = obj.paths != null;
  const hasFiles = obj.files != null;
  if (hasPaths && hasFiles) {
    throw new Error(`${sourcePath}: part 'files' object must define only one of paths|files`);
  }
  const filePathsRaw = hasPaths ? obj.paths : hasFiles ? obj.files : undefined;
  const maxBytesRaw = obj.max_bytes_per_file ?? obj.max_bytes;
  if (obj.max_bytes_per_file != null && obj.max_bytes != null) {
    throw new Error(`${sourcePath}: part 'files' object must define only one of max_bytes_per_file|max_bytes`);
  }
  const strictFileExistence = normalizeBoolean(
    obj.strict_file_existence,
    "part 'files.strict_file_existence'",
    sourcePath,
  );
  return {
    kind: "files",
    value: normalizeFileListPaths(filePathsRaw, sourcePath),
    scope: normalizeFileListScope(obj.scope, sourcePath),
    ...(maxBytesRaw != null
      ? { maxBytesPerFile: normalizeNonNegativeInteger(maxBytesRaw, "part 'files.max_bytes_per_file'", sourcePath) }
      : {}),
    ...(strictFileExistence != null ? { strictFileExistence } : {}),
    baseDir,
  };
}

function normalizePart(raw: unknown, baseDir: string, sourcePath: string): RunConfigPart {
  if (typeof raw === "string") {
    return { kind: "literal", value: raw, baseDir };
  }
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${sourcePath}: each part must be a string or object`);
  }
  const imageRaw = obj.image;
  const imagePresent = imageRaw != null;
  const filesRaw = obj.files;
  const configFileRaw = obj.config_file;
  const agentFileRaw = obj.agent_file;
  const supervisorFileRaw = obj.supervisor_file;
  const promptPartRaw = obj.prompt_part ?? obj.promptPart;
  const keys = ["literal", "file", "builtin", "template"].filter((k) => obj[k] != null);
  if (filesRaw != null) keys.push("files");
  if (configFileRaw != null) keys.push("config_file");
  if (agentFileRaw != null) keys.push("agent_file");
  if (supervisorFileRaw != null) keys.push("supervisor_file");
  if (promptPartRaw != null) keys.push("prompt_part");
  if (imagePresent) keys.push("image");
  if (keys.length !== 1) {
    throw new Error(
      `${sourcePath}: each part must define exactly one of literal|file|files|config_file|agent_file|supervisor_file|prompt_part|builtin|template|image`,
    );
  }
  const key = keys[0];
  if (key === "files") {
    return normalizeFilesPart(filesRaw, baseDir, sourcePath);
  }
  const value = key === "image"
    ? imageRaw
    : key === "config_file"
      ? configFileRaw
      : key === "agent_file"
        ? agentFileRaw
          : key === "supervisor_file"
            ? supervisorFileRaw
            : key === "prompt_part"
              ? promptPartRaw
          : obj[key];
  if (typeof value !== "string") {
    throw new Error(`${sourcePath}: part '${key}' must be a string`);
  }
  if (key === "literal") {
    return { kind: "literal", value, baseDir };
  }
  if (key === "file") {
    return { kind: "file", value, baseDir };
  }
  if (key === "config_file") {
    return { kind: "config_file", value, baseDir };
  }
  if (key === "agent_file") {
    return { kind: "agent_file", value, baseDir };
  }
  if (key === "supervisor_file") {
    return { kind: "supervisor_file", value, baseDir };
  }
  if (key === "prompt_part") {
    return { kind: "prompt_part", value, baseDir };
  }
  if (key === "builtin") {
    return { kind: "builtin", value: normalizeBuiltin(value, sourcePath), baseDir };
  }
  if (key === "image") {
    return { kind: "image", value, baseDir };
  }
  return { kind: "template", value, baseDir };
}

function normalizeParts(raw: unknown, baseDir: string, sourcePath: string): RunConfigPart[] {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item) => normalizePart(item, baseDir, sourcePath));
}

export function normalizePromptMessage(raw: unknown, label: string, sourcePath: string): RunConfigPromptMessage | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${sourcePath}: ${label} must be an object with operation + optional parts`);
  }
  if (obj.mode != null) {
    throw new Error(`${sourcePath}: ${label}.mode is not supported; use ${label}.operation`);
  }
  const operation = normalizeOperation(obj.operation, label, sourcePath);
  const parts = normalizeParts(obj.parts, path.dirname(sourcePath), sourcePath);
  return { operation, parts, sourcePath };
}

function normalizeStringValues(raw: unknown, label: string, sourcePath: string): string[] {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new Error(`${sourcePath}: ${label} entries must be strings`);
    }
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

export function normalizeRuleList(raw: unknown, label: string, sourcePath: string): RunConfigStringList | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${sourcePath}: ${label} must be an object with operation + optional values`);
  }
  if (Array.isArray(raw)) {
    throw new Error(`${sourcePath}: ${label} must use object form with operation + values`);
  }
  const operation = normalizeOperation(obj.operation, label, sourcePath);
  const values = normalizeStringValues(obj.values, `${label}.values`, sourcePath);
  return { operation, values, sourcePath };
}

export function normalizeAgentRuleList(raw: unknown, label: string, sourcePath: string): RunConfigAgentRules | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${sourcePath}: ${label} must be an object with operation + optional requirements/violations`);
  }
  if (Array.isArray(raw)) {
    throw new Error(`${sourcePath}: ${label} must use object form with operation + requirements/violations`);
  }
  if (obj.values != null) {
    throw new Error(`${sourcePath}: ${label}.values has been renamed to ${label}.requirements`);
  }
  const operation = normalizeOperation(obj.operation, label, sourcePath);
  const requirements = normalizeStringValues(obj.requirements, `${label}.requirements`, sourcePath);
  const violations = normalizeStringValues(obj.violations, `${label}.violations`, sourcePath);
  return { operation, requirements, violations, sourcePath };
}

export function cloneRuleList(raw: RunConfigStringList | undefined): RunConfigStringList | undefined {
  if (!raw) return undefined;
  return {
    operation: raw.operation,
    values: [...raw.values],
    sourcePath: raw.sourcePath,
  };
}

export function cloneAgentRuleList(raw: RunConfigAgentRules | undefined): RunConfigAgentRules | undefined {
  if (!raw) return undefined;
  return {
    operation: raw.operation,
    requirements: [...raw.requirements],
    violations: [...raw.violations],
    sourcePath: raw.sourcePath,
  };
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function applyRuleList(base: string[], next?: RunConfigStringList): string[] {
  if (!next) return dedupe(base);
  if (next.operation === "replace") return dedupe(next.values);
  return dedupe([...base, ...next.values]);
}

export function applyAgentRuleList(
  base: RenderedRunConfigAgentRules,
  next?: RunConfigAgentRules,
): RenderedRunConfigAgentRules {
  const baseRequirements = dedupe(base.requirements);
  const baseViolations = dedupe(base.violations);
  if (!next) {
    return { requirements: baseRequirements, violations: baseViolations };
  }
  if (next.operation === "replace") {
    return {
      requirements: dedupe(next.requirements),
      violations: dedupe(next.violations),
    };
  }
  return {
    requirements: dedupe([...baseRequirements, ...next.requirements]),
    violations: dedupe([...baseViolations, ...next.violations]),
  };
}

export function combineSystemMessages(
  base: RenderedRunConfigMessage | undefined,
  next: RenderedRunConfigMessage | undefined,
): RenderedRunConfigMessage | undefined {
  if (!base) return next;
  if (!next) return base;
  if (next.operation === "replace") return next;
  const content = concatPromptContent([base.content, next.content], "\n\n");
  const images = dedupePromptImages([
    ...base.images.map((path) => ({ type: "image" as const, path })),
    ...next.images.map((path) => ({ type: "image" as const, path })),
  ]).map((entry) => entry.path);
  return {
    operation: base.operation === "replace" ? "replace" : "append",
    text: promptContentToPlainText(content),
    images,
    content,
  };
}

export function combineUserMessages(
  base: RenderedRunConfigUserMessage | undefined,
  next: RenderedRunConfigUserMessage | undefined,
): RenderedRunConfigUserMessage | undefined {
  if (!base) return next;
  if (!next) return base;
  if (next.operation === "replace") return next;
  const content = concatPromptContent([base.content, next.content], "\n\n");
  return {
    operation: base.operation === "replace" ? "replace" : "append",
    text: promptContentToMarkdown(content),
    content,
  };
}

export function normalizePresets(raw: unknown, sourcePath: string): RunConfigPresetName[] | undefined {
  if (raw == null) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  const out: RunConfigPresetName[] = [];
  const seen = new Set<RunConfigPresetName>();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new Error(`${sourcePath}: presets entries must be strings`);
    }
    const normalized = normalizePresetName(value, sourcePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length ? out : undefined;
}

export function mergePresetLists(
  left: RunConfigPresetName[] | undefined,
  right: RunConfigPresetName[] | undefined,
): RunConfigPresetName[] | undefined {
  const out: RunConfigPresetName[] = [];
  const seen = new Set<RunConfigPresetName>();
  for (const preset of [...(left ?? []), ...(right ?? [])]) {
    if (seen.has(preset)) continue;
    seen.add(preset);
    out.push(preset);
  }
  return out.length ? out : undefined;
}

export function normalizeOutputSchemaFile(
  raw: unknown,
  sourcePath: string,
): { value: string; baseDir: string; sourcePath: string } | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${sourcePath}: output_schema_file must be a non-empty string path`);
  }
  return {
    value: raw.trim(),
    baseDir: path.dirname(sourcePath),
    sourcePath,
  };
}

export function normalizeToolOutput(raw: unknown, sourcePath: string): ToolOutputConfig | undefined {
  if (raw == null) return undefined;
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error(`${sourcePath}: tool_output must be a mapping`);
  }
  return normalizeToolOutputConfig(obj);
}

export function normalizeReviewTimeoutMs(raw: unknown, sourcePath: string): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${sourcePath}: review_timeout_ms must be a positive number`);
  }
  return Math.floor(value);
}

export function normalizeStopCondition(raw: unknown, sourcePath: string): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string") throw new Error(`${sourcePath}: stop_condition must be a string`);
  const value = raw.trim();
  return value || undefined;
}

export function assertNoLegacyPromptKeys(obj: Record<string, unknown>, sourcePath: string): void {
  const legacyRoot = [
    "system_message",
    "user_message",
    "agent_rules",
    "supervisor_instructions",
    "base_system_message",
    "base_user_message",
    "base_agent_rules",
    "base_supervisor_instructions",
  ].filter((key) => obj[key] != null);
  if (legacyRoot.length > 0) {
    throw new Error(
      `${sourcePath}: legacy root keys ${legacyRoot.join(", ")} are not supported; use agent.system_message, agent.user_message, agent.rules, supervisor.instructions`,
    );
  }
  const legacySupervisorRoot = ["stop_condition", "review_timeout_ms"].filter((key) => obj[key] != null);
  if (legacySupervisorRoot.length > 0) {
    throw new Error(
      `${sourcePath}: root keys ${legacySupervisorRoot.join(", ")} are not supported; move them under supervisor.stop_condition and supervisor.review_timeout_ms`,
    );
  }
}
