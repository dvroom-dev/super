import fs from "node:fs/promises";
import path from "node:path";
import { parseChatMarkdown } from "../markdown/parse.js";
import { sha256Hex } from "../utils/hash.js";
import { deriveBlockIdsFromBlocks } from "../markdown/block_ids.js";

export type BlobRef = {
  id: string;
  path: string;
  bytes: number;
  kind: string;
  summary: string;
};

export type SkeletonResult = {
  skeleton: string;
  blobs: BlobRef[];
};

export type SkeletonOptions = {
  documentText: string;
  workspaceRoot: string;
  conversationId: string;
  maxInlineBytes?: number;
  kindsToOffload?: string[];
  blobDir?: string;
  blobPathBase?: string;
};

const DEFAULT_MAX_INLINE_BYTES = 2000;
const DEFAULT_KINDS = ["tool_result"];
const PREVIEW_MAX_CHARS = 240;

function stripSupervisorBlocks(text: string): string {
  return text.replace(/```supervisor_[\s\S]*?```\n?/g, "").trim();
}

function extractMetadata(content: string): {
  summary?: string;
  command?: string;
  status?: string;
  exitCode?: number;
  hasBlobRef: boolean;
  hasExplicitError: boolean;
  body: string;
  lineCount: number;
} {
  const lines = content.split(/\r?\n/);
  const meta: {
    summary?: string;
    command?: string;
    status?: string;
    exitCode?: number;
    hasBlobRef: boolean;
    hasExplicitError: boolean;
    body: string;
    lineCount: number;
  } = {
    hasBlobRef: false,
    hasExplicitError: false,
    body: content,
    lineCount: lines.length,
  };
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      bodyStart = i + 1;
      continue;
    }
    if (line.startsWith("summary:")) {
      meta.summary = line.replace(/^summary:\s*/i, "").trim();
      bodyStart = i + 1;
      continue;
    }
    if (line.startsWith("command:")) {
      meta.command = line.replace(/^command:\s*/i, "").trim();
      bodyStart = i + 1;
      continue;
    }
    if (line.startsWith("status:")) {
      meta.status = line.replace(/^status:\s*/i, "").trim();
      bodyStart = i + 1;
      continue;
    }
    if (line.startsWith("exit_code:")) {
      const n = Number(line.replace(/^exit_code:\s*/i, "").trim());
      if (Number.isFinite(n)) meta.exitCode = n;
      bodyStart = i + 1;
      continue;
    }
    if (line.startsWith("blob_ref:")) {
      meta.hasBlobRef = true;
      bodyStart = i + 1;
      continue;
    }
    break;
  }
  meta.body = lines.slice(bodyStart).join("\n").trim();
  meta.hasExplicitError =
    content.includes("(ok=false)")
    || /\[error\]/i.test(content)
    || /^error:/im.test(content)
    || String(meta.status ?? "").trim().toLowerCase() === "error";
  return meta;
}

function firstMeaningfulLine(text: string): string | undefined {
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    return line;
  }
  return undefined;
}

function truncatePreview(text: string | undefined, maxChars = PREVIEW_MAX_CHARS): string | undefined {
  const value = String(text ?? "").trim();
  if (!value) return undefined;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export async function buildContextSkeleton(opts: SkeletonOptions): Promise<SkeletonResult> {
  const maxInlineBytes = opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const kinds = new Set(opts.kindsToOffload ?? DEFAULT_KINDS);
  const cleaned = stripSupervisorBlocks(opts.documentText || "");
  const lines = cleaned.split(/\r?\n/);
  const parsed = parseChatMarkdown(cleaned);
  const blobDir = opts.blobDir ?? path.join(opts.workspaceRoot, ".ai-supervisor", "conversations", opts.conversationId, "blobs");
  const blobPathBase = opts.blobPathBase
    ? opts.blobPathBase.replace(/\\/g, "/").replace(/\/+$/g, "")
    : undefined;
  await fs.mkdir(blobDir, { recursive: true });

  const idEntries = deriveBlockIdsFromBlocks(parsed.blocks);
  for (const entry of idEntries) {
    const start = (entry.block as any).startLine;
    if (!Number.isFinite(start)) continue;
    if (start < 0 || start >= lines.length) continue;
    const line = lines[start];
    if (!line.startsWith("```")) continue;
    if (line.includes(" id=")) continue;
    lines[start] = `${line} id=${entry.id}`;
  }

  const replacements: { start: number; end: number; lines: string[] }[] = [];
  const blobs: BlobRef[] = [];

  for (const block of parsed.blocks) {
    if (!kinds.has(block.kind)) continue;
    const content = String((block as any).content ?? "");
    const metadata = extractMetadata(content);
    const bytes = Buffer.byteLength(content, "utf8");
    const blockIndex = parsed.blocks.indexOf(block);
    const previousBlock = blockIndex > 0 ? (parsed.blocks[blockIndex - 1] as any) : undefined;
    const isReasoningSnapshotResult =
      block.kind === "tool_result"
      && previousBlock?.kind === "tool_call"
      && String(previousBlock?.name ?? "") === "reasoning_snapshot";
    const keepInlineErrorDiagnostics =
      block.kind === "tool_result"
      && metadata.hasExplicitError
      && bytes <= maxInlineBytes
      && !metadata.hasBlobRef;
    const shouldThinInline =
      (block.kind === "tool_call" || block.kind === "tool_result")
      && !isReasoningSnapshotResult
      && !keepInlineErrorDiagnostics;
    const previewSource = block.kind === "tool_call"
      ? (metadata.command || firstMeaningfulLine(metadata.body) || metadata.summary)
      : (metadata.summary || firstMeaningfulLine(metadata.body) || metadata.status);
    const preview = truncatePreview(previewSource);
    const hasAdditionalContent = preview
      ? cleanForCompare(content) !== cleanForCompare(preview)
      : Boolean(content.trim());
    const shouldOffload = isReasoningSnapshotResult
      ? (bytes > maxInlineBytes || metadata.hasBlobRef)
      : shouldThinInline
      ? hasAdditionalContent || bytes > maxInlineBytes || metadata.hasBlobRef
      : bytes > maxInlineBytes;
    if (!shouldThinInline && !shouldOffload) continue;
    let relPath: string | undefined;
    if (shouldOffload) {
      const id = sha256Hex(content);
      const filename = `${id}.txt`;
      const absPath = path.join(blobDir, filename);
      relPath = blobPathBase ? `${blobPathBase}/${filename}` : path.relative(opts.workspaceRoot, absPath).replace(/\\/g, "/");
      try {
        await fs.access(absPath);
      } catch {
        await fs.writeFile(absPath, content, "utf8");
      }
      blobs.push({
        id,
        path: relPath,
        bytes,
        kind: block.kind,
        summary: preview ?? metadata.summary ?? "(see blob)",
      });
    }

    const start = (block as any).startLine;
    const end = (block as any).endLine;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const contentStart = start + 1;
    const contentEnd = end - 1;
    const inlineLines: string[] = [];
    if (shouldThinInline) {
      if (block.kind === "tool_call" && metadata.command) {
        inlineLines.push(`command: ${truncatePreview(metadata.command)}`);
        if (preview && preview !== truncatePreview(metadata.command)) {
          inlineLines.push(`first_line: ${preview}`);
        }
      } else {
        if (block.kind === "tool_result" && metadata.summary) {
          inlineLines.push(`summary: ${truncatePreview(metadata.summary)}`);
        }
        if (preview && (!metadata.summary || preview !== truncatePreview(metadata.summary))) {
          inlineLines.push(`first_line: ${preview}`);
        }
      }
      if (inlineLines.length === 0 && preview) {
        inlineLines.push(`first_line: ${preview}`);
      } else if (inlineLines.length === 0) {
        inlineLines.push("first_line: (empty)");
      }
      if (metadata.status) inlineLines.push(`status: ${metadata.status}`);
      if (metadata.exitCode != null) inlineLines.push(`exit_code: ${metadata.exitCode}`);
    } else {
      inlineLines.push(metadata.summary ? `summary: ${metadata.summary}` : "summary: (see blob)");
    }
    if (shouldOffload) {
      inlineLines.push(`blob_ref: ${relPath}`, `blob_bytes: ${bytes}`);
    }
    replacements.push({
      start: contentStart,
      end: Math.max(contentStart - 1, contentEnd),
      lines: inlineLines,
    });
  }

  replacements.sort((a, b) => b.start - a.start);
  for (const rep of replacements) {
    const count = rep.end >= rep.start ? rep.end - rep.start + 1 : 0;
    lines.splice(rep.start, count, ...rep.lines);
  }

  return { skeleton: lines.join("\n"), blobs };
}

function cleanForCompare(text: string): string {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}
