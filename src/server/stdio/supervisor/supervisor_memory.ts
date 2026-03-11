import fs from "node:fs/promises";
import path from "node:path";

type SupervisorMemoryEntry = {
  at: string;
  mode: string;
  action: string;
  decision?: string;
  stopReasons: string[];
  failedRules: string[];
  advice?: string | null;
  nextMode?: string | null;
  nextUserMessage?: string | null;
  reasoning?: string | null;
};

export type SupervisorCarryover = {
  text: string;
  bytes: number;
  entries: number;
  compacted: boolean;
};

const DEFAULT_LIMIT_BYTES = 288 * 1024;

function memoryPath(workspaceRoot: string, conversationId: string): string {
  return path.join(
    workspaceRoot,
    ".ai-supervisor",
    "conversations",
    conversationId,
    "supervisor-memory.jsonl",
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function parseLine(line: string): SupervisorMemoryEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
      mode: typeof parsed.mode === "string" ? parsed.mode : "default",
      action: typeof parsed.action === "string" ? parsed.action : "continue",
      decision: typeof parsed.decision === "string" ? parsed.decision : undefined,
      stopReasons: toStringArray(parsed.stopReasons),
      failedRules: toStringArray(parsed.failedRules),
      advice: typeof parsed.advice === "string" ? parsed.advice : null,
      nextMode: typeof parsed.nextMode === "string" ? parsed.nextMode : null,
      nextUserMessage: typeof parsed.nextUserMessage === "string" ? parsed.nextUserMessage : null,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : null,
    };
  } catch {
    return null;
  }
}

function renderEntry(entry: SupervisorMemoryEntry, compact = false): string {
  const lines: string[] = [
    `- at: ${entry.at}`,
    `  mode: ${entry.mode}`,
    `  action: ${entry.action}`,
    `  decision: ${entry.decision || "(none)"}`,
    `  stop_reasons: ${entry.stopReasons.join(", ") || "(none)"}`,
    `  failed_rules: ${entry.failedRules.join("; ") || "(none)"}`,
    `  advice: ${entry.advice?.trim() || "(none)"}`,
  ];
  if (entry.nextMode) {
    lines.push(`  next_mode: ${entry.nextMode}`);
  }
  if (!compact && entry.nextUserMessage?.trim()) {
    lines.push(`  next_user_message: ${entry.nextUserMessage.trim().slice(0, 2000)}`);
  }
  if (!compact && entry.reasoning?.trim()) {
    lines.push(`  reasoning: ${entry.reasoning.trim().slice(0, 4000)}`);
  }
  return lines.join("\n");
}

export async function loadSupervisorCarryover(args: {
  workspaceRoot: string;
  conversationId: string;
  limitBytes?: number;
}): Promise<SupervisorCarryover> {
  const limitBytes = args.limitBytes && args.limitBytes > 0 ? args.limitBytes : DEFAULT_LIMIT_BYTES;
  const filePath = memoryPath(args.workspaceRoot, args.conversationId);
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { text: "", bytes: 0, entries: 0, compacted: false };
    }
    throw err;
  }
  const entries = raw
    .split(/\r?\n/)
    .map((line) => parseLine(line))
    .filter((entry): entry is SupervisorMemoryEntry => Boolean(entry));
  if (entries.length === 0) return { text: "", bytes: 0, entries: 0, compacted: false };

  const selected: string[] = [];
  let compacted = false;
  let usedBytes = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const full = renderEntry(entries[i], false);
    const fullBytes = Buffer.byteLength(full, "utf8") + (selected.length ? 2 : 0);
    if (usedBytes + fullBytes <= limitBytes) {
      selected.push(full);
      usedBytes += fullBytes;
      continue;
    }
    const compact = renderEntry(entries[i], true);
    const compactBytes = Buffer.byteLength(compact, "utf8") + (selected.length ? 2 : 0);
    if (usedBytes + compactBytes <= limitBytes) {
      selected.push(compact);
      usedBytes += compactBytes;
      compacted = true;
    }
    compacted = true;
    if (usedBytes >= limitBytes) break;
  }

  selected.reverse();
  const text = selected.join("\n\n").trim();
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    entries: selected.length,
    compacted,
  };
}

export async function appendSupervisorMemoryEntry(args: {
  workspaceRoot: string;
  conversationId: string;
  entry: SupervisorMemoryEntry;
}): Promise<void> {
  const filePath = memoryPath(args.workspaceRoot, args.conversationId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(args.entry)}\n`, "utf8");
}
