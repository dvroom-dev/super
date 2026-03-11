import { parseChatMarkdown } from "../../../markdown/parse.js";
import { buildContextSkeleton } from "../../../supervisor/context_skeleton.js";

const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024;
const DEFAULT_MAX_INLINE_BYTES = 256;
const DEFAULT_OFFLOAD_KINDS = ["tool_result", "tool_call", "chat"];
const DEFAULT_MAX_TAIL_BLOCKS = 24;

function extractFrontmatter(text: string): string {
  if (!text.startsWith("---")) return "";
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return "";
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") return lines.slice(0, i + 1).join("\n");
  }
  return "";
}

function sliceAfterLastSupervisorAction(text: string): string | undefined {
  const blockPattern = /```supervisor_action[^\n]*\n[\s\S]*?\n```\n?/g;
  let lastEnd = -1;
  for (const match of text.matchAll(blockPattern)) {
    if (typeof match.index !== "number") continue;
    const end = match.index + match[0].length;
    if (end > lastEnd) lastEnd = end;
  }
  if (lastEnd < 0) return undefined;
  return text.slice(lastEnd).trim();
}

export function buildSupervisorReviewDocument(documentText: string): string {
  const source = String(documentText ?? "");
  const tail = sliceAfterLastSupervisorAction(source);
  if (tail == null) return source;
  const frontmatter = extractFrontmatter(source).trim();
  if (!tail) return frontmatter ? `${frontmatter}\n` : source;
  if (!frontmatter) return tail;
  return `${frontmatter}\n\n${tail}`;
}

function trimReviewDocumentTailByBytes(documentText: string, maxBytes: number): {
  text: string;
  droppedBlocks: number;
} {
  if (maxBytes <= 0 || Buffer.byteLength(documentText, "utf8") <= maxBytes) {
    return { text: documentText, droppedBlocks: 0 };
  }
  const parsed = parseChatMarkdown(documentText);
  if (parsed.blocks.length === 0) return { text: documentText, droppedBlocks: 0 };
  const frontmatter = extractFrontmatter(documentText).trim();
  const lines = documentText.split(/\r?\n/);
  const selected: string[] = [];
  let usedBytes = frontmatter ? Buffer.byteLength(frontmatter, "utf8") + 2 : 0;
  let droppedBlocks = 0;
  for (let i = parsed.blocks.length - 1; i >= 0; i -= 1) {
    const block = parsed.blocks[i] as any;
    if (!Number.isFinite(block.startLine) || !Number.isFinite(block.endLine)) continue;
    const blockText = lines.slice(block.startLine, block.endLine + 1).join("\n");
    const blockBytes = Buffer.byteLength(blockText, "utf8") + (selected.length > 0 ? 2 : 0);
    if (selected.length > 0 && usedBytes + blockBytes > maxBytes) {
      droppedBlocks = i + 1;
      break;
    }
    selected.push(blockText);
    usedBytes += blockBytes;
  }
  selected.reverse();
  if (selected.length === 0) return { text: documentText, droppedBlocks: 0 };
  const text = frontmatter ? `${frontmatter}\n\n${selected.join("\n\n")}` : selected.join("\n\n");
  return { text, droppedBlocks };
}

function trimReviewDocumentTailByBlocks(documentText: string, maxBlocks: number): {
  text: string;
  droppedBlocks: number;
} {
  if (maxBlocks <= 0) {
    return { text: documentText, droppedBlocks: 0 };
  }
  const parsed = parseChatMarkdown(documentText);
  if (parsed.blocks.length <= maxBlocks) {
    return { text: documentText, droppedBlocks: 0 };
  }
  const frontmatter = extractFrontmatter(documentText).trim();
  const lines = documentText.split(/\r?\n/);
  const selected = parsed.blocks.slice(-maxBlocks);
  const blockTexts = selected
    .filter((block: any) => Number.isFinite(block.startLine) && Number.isFinite(block.endLine))
    .map((block: any) => lines.slice(block.startLine, block.endLine + 1).join("\n"));
  const text = frontmatter ? `${frontmatter}\n\n${blockTexts.join("\n\n")}` : blockTexts.join("\n\n");
  return { text, droppedBlocks: Math.max(0, parsed.blocks.length - selected.length) };
}

export type ManagedSupervisorReviewContext = {
  reviewDocumentText: string;
  skeletonText: string;
  originalBytes: number;
  managedBytes: number;
  skeletonBytes: number;
  droppedBlocks: number;
  offloadedBlocks: number;
  offloadedBytes: number;
};

export async function buildManagedSupervisorReviewContext(args: {
  documentText: string;
  workspaceRoot: string;
  conversationId: string;
  maxSourceBytes?: number;
  maxTailBlocks?: number;
  maxInlineBytes?: number;
  kindsToOffload?: string[];
  blobDir?: string;
  blobPathBase?: string;
}): Promise<ManagedSupervisorReviewContext> {
  const reviewDocumentText = buildSupervisorReviewDocument(args.documentText);
  const originalBytes = Buffer.byteLength(reviewDocumentText, "utf8");
  const trimmedBlocks = trimReviewDocumentTailByBlocks(
    reviewDocumentText,
    args.maxTailBlocks ?? DEFAULT_MAX_TAIL_BLOCKS,
  );
  const trimmed = trimReviewDocumentTailByBytes(
    trimmedBlocks.text,
    args.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
  );
  const managedBytes = Buffer.byteLength(trimmed.text, "utf8");
  const skeleton = await buildContextSkeleton({
    documentText: trimmed.text,
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    maxInlineBytes: args.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES,
    kindsToOffload: args.kindsToOffload ?? DEFAULT_OFFLOAD_KINDS,
    blobDir: args.blobDir,
    blobPathBase: args.blobPathBase,
  });
  const offloadedBytes = skeleton.blobs.reduce((sum, blob) => sum + blob.bytes, 0);
  return {
    reviewDocumentText: trimmed.text,
    skeletonText: skeleton.skeleton,
    originalBytes,
    managedBytes,
    skeletonBytes: Buffer.byteLength(skeleton.skeleton, "utf8"),
    droppedBlocks: trimmedBlocks.droppedBlocks + trimmed.droppedBlocks,
    offloadedBlocks: skeleton.blobs.length,
    offloadedBytes,
  };
}
