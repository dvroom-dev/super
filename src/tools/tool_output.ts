import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ToolOutputConfig = {
  maxLines: number;
  maxBytes: number;
};

export type ToolOutputPage = {
  responseId: string;
  filePath: string;
  page: number;
  totalPages: number;
  totalLines: number;
  totalBytes: number;
  content: string;
};

const DEFAULT_MAX_LINES = 1000;
const DEFAULT_MAX_BYTES = 40 * 1024;

export function normalizeToolOutputConfig(raw?: any): ToolOutputConfig {
  const maxLines = Number(raw?.maxLines ?? raw?.max_lines ?? DEFAULT_MAX_LINES);
  const explicitMaxBytes = raw?.maxBytes ?? raw?.max_bytes;
  const maxKb = Number(raw?.maxKb ?? raw?.max_kb);
  const maxBytesFromKb = Number.isFinite(maxKb) && maxKb > 0 ? Math.floor(maxKb * 1024) : undefined;
  const maxBytes = Number(explicitMaxBytes ?? maxBytesFromKb ?? DEFAULT_MAX_BYTES);
  return {
    maxLines: Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : DEFAULT_MAX_LINES,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES,
  };
}

export function shouldTruncateOutput(output: string, config: ToolOutputConfig): boolean {
  const totalBytes = Buffer.byteLength(output, "utf8");
  if (totalBytes > config.maxBytes) return true;
  const totalLines = output.split(/\r?\n/).length;
  return totalLines > config.maxLines;
}

function responseIdForConversation(conversationId: string): string {
  return `toolresp_${conversationId}_${randomUUID()}`;
}

export function parseConversationIdFromResponseId(responseId: string): string | null {
  const modern = responseId.match(/^toolresp_(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (modern) return modern[1];
  const legacy = responseId.match(/^toolresp_([0-9a-f]{64})_/i);
  return legacy ? legacy[1] : null;
}

function toolOutputDir(workspaceRoot: string, conversationId: string): string {
  return path.join(workspaceRoot, ".ai-supervisor", "conversations", conversationId, "tool_outputs");
}

export function toolOutputRelativePath(conversationId: string, responseId: string): string {
  return path.join(".ai-supervisor", "conversations", conversationId, "tool_outputs", `${responseId}.txt`).replace(/\\/g, "/");
}

function computePagination(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text, "utf8");
  let pageCount = 0;
  let currentLines: string[] = [];
  let currentBytes = 0;
  let firstPage: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf8") + (i < lines.length - 1 ? 1 : 0);
    const nextLines = currentLines.length + 1;
    const nextBytes = currentBytes + lineBytes;
    if ((currentLines.length > 0 && (nextLines > maxLines || nextBytes > maxBytes))) {
      pageCount += 1;
      if (pageCount === 1) {
        firstPage = currentLines.join("\n");
      }
      currentLines = [];
      currentBytes = 0;
    }
    currentLines.push(line);
    currentBytes += lineBytes;
  }

  if (currentLines.length > 0) {
    pageCount += 1;
    if (pageCount === 1) {
      firstPage = currentLines.join("\n");
    }
  }

  if (!firstPage) {
    firstPage = "";
  }

  return { totalLines, totalBytes, totalPages: pageCount, firstPage };
}

export async function storeToolOutput(args: {
  workspaceRoot: string;
  conversationId: string;
  output: string;
  config: ToolOutputConfig;
}): Promise<ToolOutputPage> {
  const responseId = responseIdForConversation(args.conversationId);
  const dir = toolOutputDir(args.workspaceRoot, args.conversationId);
  await fs.mkdir(dir, { recursive: true });
  const textPath = path.join(dir, `${responseId}.txt`);
  const metaPath = path.join(dir, `${responseId}.json`);
  await fs.writeFile(textPath, args.output, "utf8");

  const pagination = computePagination(args.output, args.config.maxLines, args.config.maxBytes);
  const meta = {
    responseId,
    conversationId: args.conversationId,
    totalLines: pagination.totalLines,
    totalBytes: pagination.totalBytes,
    totalPages: pagination.totalPages,
    maxLines: args.config.maxLines,
    maxBytes: args.config.maxBytes,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

  return {
    responseId,
    filePath: toolOutputRelativePath(args.conversationId, responseId),
    page: 1,
    totalPages: pagination.totalPages,
    totalLines: pagination.totalLines,
    totalBytes: pagination.totalBytes,
    content: pagination.firstPage,
  };
}

export async function paginateToolOutput(args: {
  workspaceRoot: string;
  responseId: string;
  page: number;
  config?: ToolOutputConfig;
}): Promise<ToolOutputPage> {
  const conversationId = parseConversationIdFromResponseId(args.responseId);
  if (!conversationId) {
    throw new Error(`Invalid tool response id: ${args.responseId}`);
  }
  const dir = toolOutputDir(args.workspaceRoot, conversationId);
  const textPath = path.join(dir, `${args.responseId}.txt`);
  const metaPath = path.join(dir, `${args.responseId}.json`);
  const raw = await fs.readFile(textPath, "utf8");
  const metaRaw = await fs.readFile(metaPath, "utf8");
  const meta = JSON.parse(metaRaw);
  const config = args.config ?? normalizeToolOutputConfig({ maxLines: meta.maxLines, maxBytes: meta.maxBytes });
  const page = Math.max(1, Math.floor(args.page || 1));

  const lines = raw.split(/\r?\n/);
  let currentPage = 1;
  let currentLines: string[] = [];
  let currentBytes = 0;
  let captured: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf8") + (i < lines.length - 1 ? 1 : 0);
    const nextLines = currentLines.length + 1;
    const nextBytes = currentBytes + lineBytes;
    if (currentLines.length > 0 && (nextLines > config.maxLines || nextBytes > config.maxBytes)) {
      if (currentPage == page) captured = currentLines.slice();
      currentPage += 1;
      currentLines = [];
      currentBytes = 0;
    }
    currentLines.push(line);
    currentBytes += lineBytes;
  }

  if (currentLines.length > 0) {
    if (currentPage == page) captured = currentLines.slice();
  }

  const totalPages = currentLines.length > 0 ? currentPage : Math.max(0, currentPage - 1);
  if (page > totalPages) {
    throw new Error(`page out of range: ${page} (max ${totalPages})`);
  }

  return {
    responseId: args.responseId,
    filePath: toolOutputRelativePath(conversationId, args.responseId),
    page,
    totalPages,
    totalLines: meta.totalLines,
    totalBytes: meta.totalBytes,
    content: captured.join("\n"),
  };
}
