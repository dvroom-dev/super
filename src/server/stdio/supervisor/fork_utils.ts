import { parseChatMarkdown } from "../../../markdown/parse.js";
import { deriveBlockIds } from "../../../markdown/block_ids.js";
import { replaceReasoningWithSnapshots } from "../../../supervisor/reasoning_snapshots.js";

function includeBlockForIds(block: any): boolean {
  const kind = String(block?.kind ?? "");
  if (kind.startsWith("supervisor_")) return false;
  return true;
}

export { replaceReasoningWithSnapshots };

export function updateFrontmatterForkId(docText: string, conversationId: string, forkId: string): string {
  const lines = docText.split(/\r?\n/);
  if (lines[0] !== "---") {
    return ["---", `conversation_id: ${conversationId}`, `fork_id: ${forkId}`, "---", "", docText.trim()].join("\n");
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return ["---", `conversation_id: ${conversationId}`, `fork_id: ${forkId}`, "---", "", docText.trim()].join("\n");
  }
  const out: string[] = [];
  let hasConv = false;
  let hasFork = false;
  out.push("---");
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (line.match(/^\s*conversation_id\s*:/)) {
      out.push(`conversation_id: ${conversationId}`);
      hasConv = true;
      continue;
    }
    if (line.match(/^\s*fork_id\s*:/)) {
      out.push(`fork_id: ${forkId}`);
      hasFork = true;
      continue;
    }
    out.push(line);
  }
  if (!hasConv) out.push(`conversation_id: ${conversationId}`);
  if (!hasFork) out.push(`fork_id: ${forkId}`);
  out.push("---");
  const rest = lines.slice(end + 1);
  return [...out, ...rest].join("\n");
}

export function splitAfterLastUser(docText: string): {
  found: boolean;
  beforeLines: string[];
  tailLines: string[];
} {
  const parsed = parseChatMarkdown(docText);
  const lines = docText.split(/\r?\n/);
  let lastUserIndex = -1;
  for (let i = parsed.blocks.length - 1; i >= 0; i--) {
    const block: any = parsed.blocks[i];
    if (block.kind === "chat" && block.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) {
    return { found: false, beforeLines: lines, tailLines: [] };
  }
  const nextBlock: any = parsed.blocks[lastUserIndex + 1];
  if (!nextBlock) {
    return { found: true, beforeLines: lines, tailLines: [] };
  }
  const startLine = Number.isFinite(nextBlock.startLine) ? nextBlock.startLine : lines.length;
  const endBlock: any = parsed.blocks[parsed.blocks.length - 1];
  const endLine = Number.isFinite(endBlock?.endLine) ? endBlock.endLine : startLine;
  const before = lines.slice(0, startLine);
  const tail = lines.slice(endLine + 1);
  return { found: true, beforeLines: before, tailLines: tail };
}

export function replaceAfterLastUser(docText: string, replacement: string): string {
  const cleanedReplacement = replacement.trim();
  const split = splitAfterLastUser(docText);
  if (!split.found) {
    return [docText.trim(), cleanedReplacement].filter(Boolean).join("\n\n");
  }
  const replacementLines = cleanedReplacement ? cleanedReplacement.split(/\r?\n/) : [];
  return [...split.beforeLines, ...replacementLines, ...split.tailLines].join("\n");
}

export function replaceLastBlocks(docText: string, count: number, replacement: string, kinds?: string[]): string {
  const cleanedReplacement = replacement.trim();
  if (!count || count <= 0) return docText;
  const parsed = parseChatMarkdown(docText);
  const lines = docText.split(/\r?\n/);
  const eligibleKinds = new Set(
    (kinds && kinds.length
      ? kinds
      : ["chat", "tool_call", "tool_result", "assistant_candidates"]).map((k) => String(k))
  );
  const eligible = parsed.blocks.filter((b: any) => eligibleKinds.has(b.kind));
  if (eligible.length === 0) {
    return [docText.trim(), cleanedReplacement].filter(Boolean).join("\n\n");
  }
  const remove = eligible.slice(-count);
  const startLine = Number.isFinite(remove[0]?.startLine) ? remove[0].startLine : lines.length;
  const endLine = Number.isFinite(remove[remove.length - 1]?.endLine) ? remove[remove.length - 1].endLine : startLine;
  const before = lines.slice(0, startLine);
  const after = lines.slice(endLine + 1);
  const replacementLines = cleanedReplacement ? cleanedReplacement.split(/\r?\n/) : [];
  return [...before, ...replacementLines, ...after].join("\n");
}

export function replaceLastAssistantChat(
  docText: string,
  replacement: string,
): { text: string; replaced: boolean } {
  const cleanedReplacement = replacement.trim();
  const parsed = parseChatMarkdown(docText);
  const lines = docText.split(/\r?\n/);
  let target: any | undefined;
  for (let i = parsed.blocks.length - 1; i >= 0; i -= 1) {
    const block: any = parsed.blocks[i];
    if (block?.kind !== "chat" || block?.role !== "assistant") continue;
    target = block;
    break;
  }
  if (!target || !Number.isFinite(target.startLine) || !Number.isFinite(target.endLine)) {
    return {
      text: [docText.trim(), cleanedReplacement].filter(Boolean).join("\n\n"),
      replaced: false,
    };
  }
  const before = lines.slice(0, target.startLine);
  const after = lines.slice(target.endLine + 1);
  const replacementLines = cleanedReplacement ? cleanedReplacement.split(/\r?\n/) : [];
  return {
    text: [...before, ...replacementLines, ...after].join("\n"),
    replaced: true,
  };
}

export function replaceBlocksByIds(docText: string, ids: string[], replacement: string): string {
  const cleanedIds = (ids || []).map((id) => String(id)).filter(Boolean);
  if (cleanedIds.length === 0) return docText;
  const parsed = parseChatMarkdown(docText);
  const lines = docText.split(/\r?\n/);
  const idEntries = deriveBlockIds(docText, { include: includeBlockForIds });
  const blockById = new Map<string, any>();
  for (const entry of idEntries) {
    blockById.set(entry.id, entry.block);
  }

  const targets = cleanedIds
    .map((id) => blockById.get(id))
    .filter(Boolean)
    .sort((a: any, b: any) => (a.startLine ?? 0) - (b.startLine ?? 0));

  if (targets.length === 0) return docText;

  const insertAt = Number.isFinite(targets[0].startLine) ? targets[0].startLine : lines.length;
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const block: any = targets[i];
    const startLine = Number.isFinite(block.startLine) ? block.startLine : -1;
    const endLine = Number.isFinite(block.endLine) ? block.endLine : startLine;
    if (startLine < 0 || endLine < startLine) continue;
    const count = endLine - startLine + 1;
    lines.splice(startLine, count);
  }

  const cleanedReplacement = replacement.trim();
  if (cleanedReplacement) {
    const replacementLines = cleanedReplacement.split(/\r?\n/);
    lines.splice(insertAt, 0, ...replacementLines);
  }

  return lines.join("\n");
}
