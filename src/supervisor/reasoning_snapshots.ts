import { parseChatMarkdown } from "../markdown/parse.js";
import { renderToolCall, renderToolResult } from "../markdown/render.js";

function isReasoningBlock(block: any): boolean {
  if (!block || typeof block !== "object") return false;
  return block.kind === "chat" && block.role === "assistant" && String(block.attrs?.reasoning ?? "") === "1";
}

export function replaceReasoningWithSnapshots(docText: string): { text: string; snapshots: number } {
  const parsed = parseChatMarkdown(docText);
  const lines = docText.split(/\r?\n/);
  const groups: { start: number; end: number; content: string; count: number }[] = [];

  let current: { start: number; end: number; parts: string[] } | null = null;
  let lastIndex = -1;

  for (let idx = 0; idx < parsed.blocks.length; idx += 1) {
    const block: any = parsed.blocks[idx];
    if (isReasoningBlock(block)) {
      const startLine = Number.isFinite(block.startLine) ? block.startLine : -1;
      const endLine = Number.isFinite(block.endLine) ? block.endLine : startLine;
      if (!current || idx !== lastIndex + 1) {
        if (current) {
          groups.push({
            start: current.start,
            end: current.end,
            content: current.parts.join("\n\n"),
            count: current.parts.length,
          });
        }
        current = {
          start: startLine,
          end: endLine,
          parts: [String(block.content ?? "")],
        };
      } else {
        current.end = endLine;
        current.parts.push(String(block.content ?? ""));
      }
      lastIndex = idx;
    } else {
      if (current) {
        groups.push({
          start: current.start,
          end: current.end,
          content: current.parts.join("\n\n"),
          count: current.parts.length,
        });
        current = null;
      }
      lastIndex = idx;
    }
  }

  const trailing = current;
  if (trailing) {
    groups.push({
      start: trailing.start,
      end: trailing.end,
      content: trailing.parts.join("\n\n"),
      count: trailing.parts.length,
    });
  }

  if (groups.length === 0) {
    return { text: docText, snapshots: 0 };
  }

  // Apply replacements from bottom to top so line indices remain valid.
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    if (group.start < 0 || group.end < group.start) continue;
    const callBody = JSON.stringify({ blocks: group.count }, null, 2);
    const toolCall = renderToolCall("reasoning_snapshot", callBody);
    const toolResult = renderToolResult([`(ok=true)`, group.content].join("\n"));
    const replacementLines = [toolCall, toolResult].join("\n\n").split(/\r?\n/);
    const count = group.end - group.start + 1;
    lines.splice(group.start, count, ...replacementLines);
  }

  return { text: lines.join("\n"), snapshots: groups.length };
}
