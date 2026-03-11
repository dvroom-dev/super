import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { TaggedFileContext } from "../../supervisor/compile.js";
import { formatAgentsInstructions, readAgentsInstructions } from "../../supervisor/project_docs.js";

const DEFAULT_EXCLUDE = new Set([".git", "node_modules", ".ai-supervisor", ".venv", "__pycache__", ".DS_Store"]);

export async function loadAgentsInstructions(workspaceRoot: string): Promise<string | undefined> {
  const doc = await readAgentsInstructions(workspaceRoot);
  if (!doc) return undefined;
  return formatAgentsInstructions(workspaceRoot, doc);
}

export function extractTaggedPaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s([{"'])@([A-Za-z0-9_./-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let token = m[1] ?? "";
    token = token.replace(/[),.;:!?\]]+$/g, "");
    if (!token) continue;
    if (token.includes("@")) continue;
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

export function resolveInside(workspaceRoot: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
  const rel = path.relative(workspaceRoot, abs);
  if (rel.startsWith("..") || (path.isAbsolute(rel) && rel.includes(".."))) {
    throw new Error(`Path escapes workspace root: ${p}`);
  }
  return abs;
}

export async function resolveInsideCaseInsensitive(workspaceRoot: string, p: string): Promise<string> {
  const abs = resolveInside(workspaceRoot, p);
  const rel = path.relative(workspaceRoot, abs);
  const parts = rel.split(path.sep).filter(Boolean);
  let current = workspaceRoot;
  for (const part of parts) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    if (entries.length > 500) {
      throw new Error(`Directory too large for case-insensitive match: ${current}`);
    }
    let match = entries.find((e) => e.name === part);
    if (!match) {
      const lower = part.toLowerCase();
      match = entries.find((e) => e.name.toLowerCase() === lower);
    }
    if (!match) {
      throw new Error(`Path not found: ${p}`);
    }
    current = path.join(current, match.name);
  }
  return current;
}

export async function readFileHead(abs: string, maxBytes: number): Promise<{ content: string; truncated: boolean }> {
  const stat = await fs.stat(abs);
  const size = stat.size ?? 0;
  const truncated = size > maxBytes;
  if (!truncated) {
    const raw = await fs.readFile(abs, "utf-8");
    return { content: raw, truncated: false };
  }
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, maxBytes, 0);
    return { content: buf.toString("utf-8"), truncated: true };
  } finally {
    await fh.close();
  }
}

export async function listDirectory(abs: string, maxEntries: number, exclude = DEFAULT_EXCLUDE): Promise<string> {
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const visible = entries.filter((e) => !exclude.has(e.name)).map((e) => (e.isDirectory() ? e.name + "/" : e.name));
  visible.sort();
  const sliced = visible.slice(0, maxEntries);
  const extra = visible.length - sliced.length;
  const lines = [...sliced];
  if (extra > 0) lines.push(`... (${extra} more)`);
  return lines.join("\n");
}

export async function workspaceListing(workspaceRoot: string): Promise<string> {
  return listDirectory(workspaceRoot, 50);
}

export async function taggedFileContexts(workspaceRoot: string, documentText: string): Promise<TaggedFileContext[]> {
  const tags = extractTaggedPaths(documentText);
  if (tags.length === 0) return [];
  const results: TaggedFileContext[] = [];
  for (const tag of tags.slice(0, 10)) {
    try {
      let abs = resolveInside(workspaceRoot, tag);
      let stat: any;
      try {
        stat = await fs.stat(abs);
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          abs = await resolveInsideCaseInsensitive(workspaceRoot, tag);
          stat = await fs.stat(abs);
        } else {
          throw err;
        }
      }
      if (stat.isDirectory()) {
        const listing = await listDirectory(abs, 50);
        results.push({ path: tag, kind: "dir", content: listing });
      } else {
        const { content, truncated } = await readFileHead(abs, 12_000);
        if (content.includes("\u0000")) {
          results.push({ path: tag, kind: "error", content: "", error: "binary file (skipped)" });
        } else {
          const body = truncated ? content + "\n... (truncated)" : content;
          results.push({ path: tag, kind: "file", content: body, truncated });
        }
      }
    } catch (err: any) {
      results.push({ path: tag, kind: "missing", content: "", error: err?.message ?? "not found" });
    }
  }
  return results;
}

export async function findCommand(cmd: string): Promise<string | undefined> {
  if (!cmd) return undefined;
  if (cmd.includes("/") || cmd.includes("\\")) {
    try {
      await fs.access(cmd, fsSync.constants.X_OK);
      return cmd;
    } catch {
      return undefined;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    try {
      await fs.access(full, fsSync.constants.X_OK);
      return full;
    } catch {
      // continue
    }
  }
  return undefined;
}
