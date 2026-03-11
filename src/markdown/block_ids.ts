import { parseChatMarkdown } from "./parse.js";
import type { AnyBlock } from "./ast.js";
import { sha256Hex } from "../utils/hash.js";

export type BlockIdInfo = {
  id: string;
  block: AnyBlock;
};

export type BlockIdOptions = {
  include?: (block: AnyBlock) => boolean;
};

function blockBase(block: AnyBlock): string {
  const kind = block.kind ?? "";
  let meta = kind;
  if (kind === "chat") {
    meta += `|${(block as any).role ?? ""}`;
  } else if (kind === "tool_call") {
    meta += `|${(block as any).name ?? ""}`;
  } else if (kind === "assistant_candidates") {
    const models = Array.isArray((block as any).models) ? (block as any).models.join(",") : "";
    meta += `|${models}`;
  }
  return `${meta}\n${block.content ?? ""}`;
}

export function deriveBlockIdsFromBlocks(blocks: AnyBlock[], options: BlockIdOptions = {}): BlockIdInfo[] {
  const include = typeof options.include === "function" ? options.include : () => true;
  const counts = new Map<string, number>();
  const out: BlockIdInfo[] = [];
  for (const block of blocks) {
    if (!include(block)) continue;
    const base = blockBase(block);
    const hash = sha256Hex(base);
    const next = (counts.get(hash) ?? 0) + 1;
    counts.set(hash, next);
    const id = `blk_${hash}_${next}`;
    out.push({ id, block });
  }
  return out;
}

export function deriveBlockIds(documentText: string, options: BlockIdOptions = {}): BlockIdInfo[] {
  const parsed = parseChatMarkdown(documentText);
  return deriveBlockIdsFromBlocks(parsed.blocks, options);
}
