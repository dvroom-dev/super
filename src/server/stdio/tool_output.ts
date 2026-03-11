import type { NormalizedProviderItem } from "../../providers/types.js";
import {
  normalizeToolOutputConfig,
  storeToolOutput,
  shouldTruncateOutput,
} from "../../tools/tool_output.js";

export type CompactedItemResult = {
  item: NormalizedProviderItem;
  truncated: boolean;
  outputRefs: Array<{
    path: string;
    responseId: string;
    page: number;
    totalPages: number;
    totalLines: number;
    totalBytes: number;
    filePath: string;
  }>;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function hintForPage(responseId: string, page: number, totalPages: number): string {
  const next = page + 1;
  if (next > totalPages) return `<page ${page} of ${totalPages}>`;
  return `<page ${page} of ${totalPages}, run \`paginate_tool_response ${responseId} ${next}\` to see the next page>`;
}

export function renderOffloadedToolOutputReference(args: {
  filePath: string;
  responseId: string;
  page: number;
  totalPages: number;
}): string {
  return [`<full results at ${args.filePath}>`, hintForPage(args.responseId, args.page, args.totalPages)].join("\n");
}

function pathToString(pathParts: Array<string | number>): string {
  const out: string[] = [];
  for (const part of pathParts) {
    if (typeof part === "number") out.push(`[${part}]`);
    else out.push(out.length === 0 ? part : `.${part}`);
  }
  return out.join("");
}

function readAtPath(root: JsonValue, pathParts: Array<string | number>): JsonValue {
  let node: any = root;
  for (const part of pathParts) {
    if (node == null) return undefined as any;
    node = node[part as any];
  }
  return node as JsonValue;
}

function writeAtPath(root: JsonValue, pathParts: Array<string | number>, value: JsonValue): void {
  if (pathParts.length === 0) return;
  let node: any = root;
  for (let i = 0; i < pathParts.length - 1; i += 1) {
    node = node[pathParts[i] as any];
    if (node == null) return;
  }
  node[pathParts[pathParts.length - 1] as any] = value;
}

function collectLargeTextPaths(value: JsonValue, maxDepth = 8): Array<Array<string | number>> {
  const out: Array<Array<string | number>> = [];
  const stack: Array<{ node: JsonValue; path: Array<string | number>; depth: number }> = [
    { node: value, path: [], depth: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > maxDepth) continue;
    const node = current.node;
    if (typeof node === "string") {
      out.push(current.path);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node[i] as JsonValue, path: current.path.concat(i), depth: current.depth + 1 });
      }
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      stack.push({ node: child as JsonValue, path: current.path.concat(key), depth: current.depth + 1 });
    }
  }
  return out;
}

export async function maybeCompactProviderItem(args: {
  item: NormalizedProviderItem;
  workspaceRoot: string;
  conversationId: string;
  toolOutput?: any;
}): Promise<CompactedItemResult> {
  const config = normalizeToolOutputConfig(args.toolOutput);
  const original = args.item as unknown as JsonValue;
  let root: JsonValue;
  try {
    root = JSON.parse(JSON.stringify(original)) as JsonValue;
  } catch {
    return { item: args.item, truncated: false, outputRefs: [] };
  }

  const refs: CompactedItemResult["outputRefs"] = [];
  const candidatePaths = collectLargeTextPaths(root).sort((a, b) => b.length - a.length);
  for (const candidatePath of candidatePaths) {
    const value = readAtPath(root, candidatePath);
    if (typeof value !== "string") continue;
    if (!shouldTruncateOutput(value, config)) continue;
    const stored = await storeToolOutput({
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      output: value,
      config,
    });
    writeAtPath(root, candidatePath, "");
    refs.push({
      path: pathToString(candidatePath),
      responseId: stored.responseId,
      page: stored.page,
      totalPages: stored.totalPages,
      totalLines: stored.totalLines,
      totalBytes: stored.totalBytes,
      filePath: stored.filePath,
    });
  }

  const next = root as unknown as NormalizedProviderItem;
  if (refs.length > 0) {
    next.outputRefs = [...(Array.isArray(next.outputRefs) ? next.outputRefs : []), ...refs];
  }

  return {
    item: next,
    truncated: refs.length > 0,
    outputRefs: refs,
  };
}
