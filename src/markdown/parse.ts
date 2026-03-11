import { AnyBlock, ChatBlock, ChatRole, FenceAttrs, ParsedDocument, ParseError, ToolCallBlock, ToolResultBlock, CandidatesBlock } from "./ast.js";

function extractFrontmatterIds(
  lines: string[]
): { conversationId?: string; forkId?: string; endLine?: number } {
  if (lines[0] !== "---") return {};
  let conversationId: string | undefined;
  let forkId: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") {
      return { conversationId, forkId, endLine: i };
    }
    const convMatch = line.match(/^\s*conversation_id\s*:\s*(.+)\s*$/);
    if (convMatch) {
      conversationId = convMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const forkMatch = line.match(/^\s*fork_id\s*:\s*(.+)\s*$/);
    if (forkMatch) {
      forkId = forkMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return { conversationId, forkId };
}

function parseInfo(info: string): { kind: string; attrs: FenceAttrs } {
  // info example: "chat role=user id=msg_1"
  const parts = info.trim().split(/\s+/).filter(Boolean);
  const kind = parts[0] ?? "";
  const attrs: FenceAttrs = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (!k) continue;
    attrs[k] = v;
  }
  return { kind, attrs };
}

function asRole(v: string | undefined): ChatRole | undefined {
  if (!v) return undefined;
  if (v === "user" || v === "assistant" || v === "system" || v === "developer" || v === "supervisor") return v;
  return undefined;
}

function closingFenceRegex(fenceMarker: string): RegExp {
  const len = Math.max(3, fenceMarker.length);
  return new RegExp("^`{" + len + ",}\\s*$");
}

export function parseChatMarkdown(text: string): ParsedDocument {
  const lines = text.split(/\r?\n/);
  const blocks: AnyBlock[] = [];
  const errors: ParseError[] = [];

  const fm = extractFrontmatterIds(lines);
  const hasConversationId = Boolean(fm.conversationId);
  const hasForkId = Boolean(fm.forkId);
  let requiresConversationId = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^(`{3,})\s*(.*)\s*$/);
    if (!fenceMatch) {
      i++;
      continue;
    }
    const openingFence = fenceMatch[1] ?? "```";
    const info = fenceMatch[2] ?? "";
    const { kind, attrs } = parseInfo(info);
    const closeFence = closingFenceRegex(openingFence);

    const startLine = i;
    i++;
    const contentLines: string[] = [];
    while (i < lines.length && !closeFence.test(lines[i])) {
      contentLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      errors.push({ message: `Unclosed code fence for kind='${kind || "(unknown)"}'`, line: startLine + 1 });
      break;
    }
    const endLine = i;
    i++; // consume closing fence

    const content = contentLines.join("\n");
    const base = { kind: kind as any, attrs, content, startLine, endLine } as any;

    if (kind === "chat") {
      requiresConversationId = true;
      const role = asRole(attrs["role"]);
      if (!role) {
        errors.push({ message: "chat block missing valid role=...", line: startLine + 1 });
        blocks.push(base as AnyBlock);
        continue;
      }
      const b: ChatBlock = { ...base, kind: "chat", role };
      blocks.push(b);
      continue;
    }

    if (kind === "tool_call") {
      requiresConversationId = true;
      const name = attrs["name"];
      if (!name) errors.push({ message: "tool_call block missing name=...", line: startLine + 1 });
      const b: ToolCallBlock = { ...base, kind: "tool_call", name: name ?? "unknown" };
      blocks.push(b);
      continue;
    }

    if (kind === "tool_result") {
      requiresConversationId = true;
      const b: ToolResultBlock = { ...base, kind: "tool_result" };
      blocks.push(b);
      continue;
    }

    if (kind === "assistant_candidates") {
      requiresConversationId = true;
      const modelsRaw = attrs["models"] ?? "";
      const models = modelsRaw ? modelsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const b: CandidatesBlock = { ...base, kind: "assistant_candidates", models };
      blocks.push(b);
      continue;
    }

    if (kind === "supervisor_context") {
      requiresConversationId = true;
      blocks.push(base as AnyBlock);
      continue;
    }

    // Unknown block kind: keep as generic block
    blocks.push(base as AnyBlock);
  }

  if (requiresConversationId && !hasConversationId) {
    errors.push({ message: "frontmatter missing conversation_id", line: 1 });
  }
  if (requiresConversationId && !hasForkId) {
    errors.push({ message: "frontmatter missing fork_id", line: 1 });
  }

  return { blocks, errors };
}

export function extractChatBlocks(doc: ParsedDocument): ChatBlock[] {
  return doc.blocks.filter((b) => b.kind === "chat") as ChatBlock[];
}

export function lastUserMessage(doc: ParsedDocument): ChatBlock | undefined {
  const chats = extractChatBlocks(doc);
  for (let i = chats.length - 1; i >= 0; i--) {
    if (chats[i].role === "user") return chats[i];
  }
  return undefined;
}
