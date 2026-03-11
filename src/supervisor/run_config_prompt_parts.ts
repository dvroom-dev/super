import type { RunConfigPart, RunConfigPromptMessage } from "./run_config.js";

function clonePromptPart(part: RunConfigPart): RunConfigPart {
  if (part.kind !== "files") return { ...part };
  return {
    kind: "files",
    value: [...part.value],
    scope: part.scope,
    ...(part.maxBytesPerFile != null ? { maxBytesPerFile: part.maxBytesPerFile } : {}),
    ...(part.strictFileExistence != null ? { strictFileExistence: part.strictFileExistence } : {}),
    baseDir: part.baseDir,
  };
}

export function clonePromptPartsMap(
  promptParts?: Record<string, RunConfigPart[]>,
): Record<string, RunConfigPart[]> | undefined {
  if (!promptParts) return undefined;
  return Object.fromEntries(
    Object.entries(promptParts).map(([name, parts]) => [name, parts.map((part) => clonePromptPart(part))]),
  );
}

export function normalizePromptPartsMap(args: {
  raw: unknown;
  sourcePath: string;
  normalizePromptMessage: (raw: unknown, label: string, sourcePath: string) => RunConfigPromptMessage | undefined;
}): Record<string, RunConfigPart[]> | undefined {
  const obj = (args.raw && typeof args.raw === "object" && !Array.isArray(args.raw))
    ? (args.raw as Record<string, unknown>)
    : null;
  if (!obj) return undefined;
  const out: Record<string, RunConfigPart[]> = {};
  for (const [name, value] of Object.entries(obj)) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) {
      throw new Error(`${args.sourcePath}: prompt_parts keys must be non-empty`);
    }
    const normalized = args.normalizePromptMessage(
      { operation: "append", parts: value },
      `prompt_parts.${trimmed}`,
      args.sourcePath,
    );
    out[trimmed] = normalized?.parts.map((part) => clonePromptPart(part)) ?? [];
  }
  return Object.keys(out).length ? out : undefined;
}
