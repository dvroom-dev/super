import fs from "node:fs/promises";
import path from "node:path";
import type { NormalizedProviderItem, ProviderName } from "../../providers/types.js";

export async function appendRawProviderEvent(args: {
  workspaceRoot: string;
  conversationId: string;
  provider: ProviderName | "unknown";
  item: NormalizedProviderItem;
  raw?: unknown;
}): Promise<string | undefined> {
  if (args.raw == null) return undefined;
  const dir = path.join(args.workspaceRoot, ".ai-supervisor", "conversations", args.conversationId, "raw_events");
  await fs.mkdir(dir, { recursive: true });
  const relPath = path.join(".ai-supervisor", "conversations", args.conversationId, "raw_events", "events.ndjson");
  const absPath = path.join(args.workspaceRoot, relPath);
  const record = {
    ts: new Date().toISOString(),
    provider: args.provider,
    item_id: args.item.id ?? null,
    item_kind: args.item.kind,
    item_type: args.item.type ?? null,
    item_summary: args.item.summary,
    raw: args.raw,
  };
  await fs.appendFile(absPath, JSON.stringify(record) + "\n", "utf8");
  return relPath.replace(/\\/g, "/");
}
