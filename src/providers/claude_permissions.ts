import path from "node:path";

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
  // Ignore operator-like slash runs (e.g. Python floor-division `//` in heredocs).
  if (/^\/+$/.test(trimmed)) return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) return trimmed;
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

function isPathInsideWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(candidatePath);
  const rel = path.relative(root, candidate);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function firstOutsideWorkspacePath(args: {
  workspaceRoot: string;
  toolName: string;
  input: Record<string, unknown>;
  blockedPath?: string;
}): string | undefined {
  const candidates = new Set<string>();
  const blockedPath = typeof args.blockedPath === "string" ? args.blockedPath.trim() : "";
  if (blockedPath) candidates.add(blockedPath);
  collectPathLikeFields(args.input, candidates);
  collectShellCommandPaths(args.toolName, args.input, candidates);
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(args.workspaceRoot, candidate);
    if (!isPathInsideWorkspace(args.workspaceRoot, resolved)) return resolved;
  }
  return undefined;
}
