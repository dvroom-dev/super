import fs from "node:fs";
import path from "node:path";
import type { ProviderName } from "./types.js";

export type ProviderFilesystemPathPolicy = {
  allow?: string[];
  deny?: string[];
};

export type ProviderFilesystemPolicy = {
  read?: ProviderFilesystemPathPolicy;
  write?: ProviderFilesystemPathPolicy;
  create?: ProviderFilesystemPathPolicy;
  allowNewFiles?: boolean;
};

export type RunConfigProviderFilesystemPolicies = Partial<Record<ProviderName, ProviderFilesystemPolicy>>;

const PATH_LIKE_KEYS = new Set([
  "path",
  "file",
  "file_path",
  "filepath",
  "filename",
  "target",
  "target_file",
  "source",
  "source_file",
  "cwd",
  "directory",
  "dir",
  "old_path",
  "new_path",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePathToken(value: string): string | undefined {
  const trimmed = value.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!trimmed) return undefined;
  if (/^\/+$/.test(trimmed)) return undefined;
  if (trimmed.startsWith("-")) return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) return trimmed;
  if (!trimmed.includes("\n")) return trimmed;
  return undefined;
}

function collectPathLikeFields(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectPathLikeFields(entry, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim().toLowerCase();
    if (typeof rawValue === "string" && PATH_LIKE_KEYS.has(key)) {
      const candidate = normalizePathToken(rawValue);
      if (candidate) out.add(candidate);
      continue;
    }
    if (isRecord(rawValue) || Array.isArray(rawValue)) {
      collectPathLikeFields(rawValue, out);
    }
  }
}

function collectShellCommandPaths(toolName: string, input: Record<string, unknown>, out: Set<string>): void {
  const isShellTool = toolName.trim().toLowerCase().includes("bash");
  if (!isShellTool) return;
  const commandText = typeof input.command === "string"
    ? input.command
    : Array.isArray(input.command)
      ? input.command.map((part) => String(part)).join(" ")
      : Array.isArray(input.cmd)
        ? input.cmd.map((part) => String(part)).join(" ")
        : typeof input.cmd === "string"
          ? input.cmd
          : "";
  if (!commandText) return;
  const regex = /(^|[\s"'`])((?:\/|\.{1,2}\/)[^\s"'`|&;]+)/g;
  for (const match of commandText.matchAll(regex)) {
    const candidate = normalizePathToken(match[2] ?? "");
    if (candidate) out.add(candidate);
  }
}

function extractShellCommandText(toolName: string, input: Record<string, unknown>): string {
  if (!toolName.trim().toLowerCase().includes("bash")) return "";
  if (typeof input.command === "string") return input.command;
  if (Array.isArray(input.command)) return input.command.map((part) => String(part)).join(" ");
  if (typeof input.cmd === "string") return input.cmd;
  if (Array.isArray(input.cmd)) return input.cmd.map((part) => String(part)).join(" ");
  return "";
}

function detectShellMutation(commandText: string): "read" | "write" | "create" {
  const normalized = commandText.toLowerCase();
  if (
    /\b(mkdir|touch|install)\b/.test(normalized)
    || />{1,2}/.test(commandText)
    || /\btee\b/.test(normalized)
  ) {
    return "create";
  }
  if (
    /\b(cp|mv|rm|truncate|sed\s+-i|perl\s+-i|python3?\s+.*open\(|node\s+.*writefile)\b/.test(normalized)
  ) {
    return "write";
  }
  return "read";
}

function normalizeResolvedPath(workspaceRoot: string, candidatePath: string): string {
  return path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(workspaceRoot, candidatePath);
}

function isPathInsideWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(candidatePath);
  const rel = path.relative(root, candidate);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function pathMatchesRule(workspaceRoot: string, candidatePath: string, rawRule: string): boolean {
  const resolvedRule = normalizeResolvedPath(workspaceRoot, rawRule);
  const rel = path.relative(resolvedRule, candidatePath);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function denyMessage(args: { provider: ProviderName; operation: "read" | "write" | "create"; reason: string; path: string }): string {
  return `filesystem ${args.operation} access blocked by tools.provider_filesystem.${args.provider} (${args.reason}): ${args.path}`;
}

function evaluateFilesystemPath(args: {
  provider: ProviderName;
  workspaceRoot: string;
  candidatePath: string;
  operation: "read" | "write" | "create";
  policy?: ProviderFilesystemPolicy;
}): string | undefined {
  const operationPolicy = args.policy?.[args.operation];
  if (args.operation === "create" && args.policy?.allowNewFiles === false) {
    return denyMessage({
      provider: args.provider,
      operation: args.operation,
      reason: "allow_new_files=false",
      path: args.candidatePath,
    });
  }
  if (!operationPolicy) return undefined;
  for (const denied of operationPolicy.deny ?? []) {
    if (pathMatchesRule(args.workspaceRoot, args.candidatePath, denied)) {
      return denyMessage({
        provider: args.provider,
        operation: args.operation,
        reason: `${args.operation}.deny`,
        path: args.candidatePath,
      });
    }
  }
  const allow = operationPolicy.allow ?? [];
  if (allow.length === 0) return undefined;
  for (const allowed of allow) {
    if (pathMatchesRule(args.workspaceRoot, args.candidatePath, allowed)) return undefined;
  }
  return denyMessage({
    provider: args.provider,
    operation: args.operation,
    reason: `${args.operation}.allow`,
    path: args.candidatePath,
  });
}

function classifyToolOperation(args: {
  toolName: string;
  input: Record<string, unknown>;
  workspaceRoot: string;
  candidatePath: string;
}): "read" | "write" | "create" | undefined {
  const lowerName = args.toolName.trim().toLowerCase();
  if (lowerName === "read" || lowerName === "grep" || lowerName === "glob" || lowerName === "ls") return "read";
  if (lowerName === "edit" || lowerName === "multiedit" || lowerName === "fileedit" || lowerName === "notebookedit") {
    return fs.existsSync(args.candidatePath) ? "write" : "create";
  }
  if (lowerName === "write" || lowerName === "filewrite") {
    return fs.existsSync(args.candidatePath) ? "write" : "create";
  }
  if (lowerName === "bash") {
    const commandText = extractShellCommandText(args.toolName, args.input);
    return detectShellMutation(commandText);
  }
  return undefined;
}

function collectCandidatePaths(args: {
  workspaceRoot: string;
  toolName: string;
  input: Record<string, unknown>;
  blockedPath?: string;
}): string[] {
  const candidates = new Set<string>();
  const blockedPath = typeof args.blockedPath === "string" ? args.blockedPath.trim() : "";
  if (blockedPath) candidates.add(blockedPath);
  collectPathLikeFields(args.input, candidates);
  collectShellCommandPaths(args.toolName, args.input, candidates);
  return [...candidates].map((candidate) => normalizeResolvedPath(args.workspaceRoot, candidate));
}

export function firstOutsideWorkspacePath(args: {
  workspaceRoot: string;
  toolName: string;
  input: Record<string, unknown>;
  blockedPath?: string;
}): string | undefined {
  const candidates = collectCandidatePaths(args);
  for (const candidate of candidates) {
    if (!isPathInsideWorkspace(args.workspaceRoot, candidate)) return candidate;
  }
  return undefined;
}

export function firstFilesystemPolicyViolation(args: {
  provider: ProviderName;
  workspaceRoot: string;
  toolName: string;
  input: Record<string, unknown>;
  blockedPath?: string;
  policy?: ProviderFilesystemPolicy;
}): string | undefined {
  if (!args.policy) return undefined;
  const candidates = collectCandidatePaths(args).filter((candidate) =>
    isPathInsideWorkspace(args.workspaceRoot, candidate),
  );
  for (const candidate of candidates) {
    const operation = classifyToolOperation({
      toolName: args.toolName,
      input: args.input,
      workspaceRoot: args.workspaceRoot,
      candidatePath: candidate,
    });
    if (!operation) continue;
    const violation = evaluateFilesystemPath({
      provider: args.provider,
      workspaceRoot: args.workspaceRoot,
      candidatePath: candidate,
      operation,
      policy: args.policy,
    });
    if (violation) return violation;
  }
  return undefined;
}

export function resolveProviderFilesystemPolicy(args: {
  provider: ProviderName;
  policies?: RunConfigProviderFilesystemPolicies;
  label?: string;
}): ProviderFilesystemPolicy | undefined {
  if (!args.policies) return undefined;
  const providers = Object.keys(args.policies).filter((key) => Boolean(args.policies?.[key as ProviderName]));
  if (providers.length === 0) return undefined;
  const policy = args.policies[args.provider];
  if (policy) return policy;
  const label = args.label ?? "tools.provider_filesystem";
  throw new Error(`${label} is configured for ${providers.join("|")} but missing active provider '${args.provider}'`);
}
