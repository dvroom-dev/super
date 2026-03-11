import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const DEFAULT_PROJECT_DOC_FILENAME = "AGENTS.md";
const LOCAL_PROJECT_DOC_FILENAME = "AGENTS.override.md";
const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024;
const PROJECT_DOC_SEPARATOR = "\n\n--- project-doc ---\n\n";
const CODEX_CONFIG_FILENAME = "config.toml";

export const HIERARCHICAL_AGENTS_MESSAGE = `Files called AGENTS.md commonly appear in many places inside a container - at "/", in "~", deep within git repositories, or in any other directory; their location is not limited to version-controlled folders.

Their purpose is to pass along human guidance to you, the agent. Such guidance can include coding standards, explanations of the project layout, steps for building or testing, and even wording that must accompany a GitHub pull-request description produced by the agent; all of it is to be followed.

Each AGENTS.md governs the entire directory that contains it and every child directory beneath that point. Whenever you change a file, you have to comply with every AGENTS.md whose scope covers that file. Naming conventions, stylistic rules and similar directives are restricted to the code that falls inside that scope unless the document explicitly states otherwise.

When two AGENTS.md files disagree, the one located deeper in the directory structure overrides the higher-level file, while instructions given directly in the prompt by the system, developer, or user outrank any AGENTS.md content.`;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

type ProjectDocConfig = {
  cwd: string;
  codexHome: string;
  maxBytes: number;
  fallbackFilenames: string[];
};

function candidateFilenames(fallbacks: string[]): string[] {
  const out: string[] = [LOCAL_PROJECT_DOC_FILENAME, DEFAULT_PROJECT_DOC_FILENAME];
  for (const name of fallbacks) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function isGitRoot(dir: string): boolean {
  try {
    const stat = fsSync.statSync(path.join(dir, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function discoverProjectDocPaths(cwd: string, fallbacks: string[]): string[] {
  let current = cwd;
  const chain: string[] = [current];
  let gitRoot: string | null = null;
  while (true) {
    if (isGitRoot(current)) {
      gitRoot = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    chain.push(parent);
    current = parent;
  }

  const searchDirs: string[] = [];
  if (gitRoot) {
    for (const dir of chain.reverse()) {
      if (dir === gitRoot || searchDirs.length > 0) {
        searchDirs.push(dir);
      }
    }
  } else {
    searchDirs.push(cwd);
  }

  const found: string[] = [];
  const filenames = candidateFilenames(fallbacks);
  for (const dir of searchDirs) {
    for (const name of filenames) {
      const candidate = path.join(dir, name);
      try {
        const stat = fsSync.lstatSync(candidate);
        if (stat.isFile() || stat.isSymbolicLink()) {
          found.push(candidate);
          break;
        }
      } catch {
        continue;
      }
    }
  }
  return found;
}

function defaultCodexHome(): string {
  const env = process.env.CODEX_HOME;
  if (env && env.trim()) return env.trim();
  return path.join(homedir(), ".codex");
}

function stripComment(line: string): string {
  const out: string[] = [];
  let inQuote = false;
  let quoteChar: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === "\"" || ch === "'") && (!inQuote || ch === quoteChar)) {
      if (inQuote && ch === quoteChar) {
        inQuote = false;
        quoteChar = null;
      } else {
        inQuote = true;
        quoteChar = ch;
      }
      out.push(ch);
      continue;
    }
    if (ch === "#" && !inQuote) break;
    out.push(ch);
  }
  return out.join("");
}

function parseArrayValue(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1);
  const items: string[] = [];
  let cur = "";
  let inQuote = false;
  let quoteChar: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if ((ch === "\"" || ch === "'") && (!inQuote || ch === quoteChar)) {
      if (inQuote && ch === quoteChar) {
        inQuote = false;
        quoteChar = null;
      } else {
        inQuote = true;
        quoteChar = ch;
      }
      cur += ch;
      continue;
    }
    if (ch === "," && !inQuote) {
      items.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  const out: string[] = [];
  for (const raw of items) {
    let value = raw.trim();
    if (!value) continue;
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.trim()) out.push(value.trim());
  }
  return out;
}

function parseCodexConfig(text: string): { maxBytes?: number; fallbacks?: string[] } {
  let maxBytes: number | undefined = undefined;
  let fallbacks: string[] | undefined = undefined;
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim() || null;
      continue;
    }
    if (section) continue;
    const match = line.match(/^([^=]+)=(.+)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key === "project_doc_max_bytes") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        maxBytes = parsed;
      }
    } else if (key === "project_doc_fallback_filenames") {
      const parsed = parseArrayValue(value);
      fallbacks = parsed;
    }
  }
  return { maxBytes, fallbacks };
}

async function loadCodexConfig(codexHome: string): Promise<{ maxBytes?: number; fallbacks?: string[] }> {
  const cfgPath = path.join(codexHome, CODEX_CONFIG_FILENAME);
  try {
    const raw = await fs.readFile(cfgPath, "utf-8");
    return parseCodexConfig(raw);
  } catch {
    return {};
  }
}

async function readGlobalInstructions(codexHome: string): Promise<string | null> {
  for (const candidate of [LOCAL_PROJECT_DOC_FILENAME, DEFAULT_PROJECT_DOC_FILENAME]) {
    const p = path.join(codexHome, candidate);
    try {
      const raw = await fs.readFile(p, "utf-8");
      const trimmed = raw.trim();
      if (trimmed) return trimmed;
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveProjectDocConfig(cwd: string): Promise<ProjectDocConfig> {
  const codexHome = defaultCodexHome();
  const cfg = await loadCodexConfig(codexHome);
  const maxBytes =
    cfg.maxBytes != null && Number.isFinite(cfg.maxBytes) ? Math.max(0, cfg.maxBytes) : DEFAULT_PROJECT_DOC_MAX_BYTES;
  const fallbacks = Array.isArray(cfg.fallbacks) ? cfg.fallbacks : [];
  return {
    cwd,
    codexHome,
    maxBytes,
    fallbackFilenames: fallbacks,
  };
}

export async function readProjectDocs(
  cwd: string,
  options?: { maxBytes?: number; fallbackFilenames?: string[] }
): Promise<string | null> {
  const maxBytes =
    options?.maxBytes != null && Number.isFinite(options.maxBytes) ? Math.max(0, options.maxBytes) : DEFAULT_PROJECT_DOC_MAX_BYTES;
  if (maxBytes === 0) return null;
  const fallbacks = Array.isArray(options?.fallbackFilenames) ? options?.fallbackFilenames ?? [] : [];
  const paths = discoverProjectDocPaths(cwd, fallbacks);
  if (paths.length === 0) return null;

  let remaining = maxBytes;
  const parts: string[] = [];
  for (const p of paths) {
    if (remaining <= 0) break;
    let data = "";
    try {
      const buf = await fs.readFile(p);
      if (buf.length > remaining) {
        data = buf.slice(0, remaining).toString("utf-8");
      } else {
        data = buf.toString("utf-8");
      }
    } catch {
      continue;
    }
    const trimmed = data.trim();
    if (trimmed) {
      parts.push(trimmed);
      remaining -= Buffer.byteLength(data, "utf-8");
    }
  }

  if (!parts.length) return null;
  return parts.join("\n\n");
}

export async function readAgentsInstructions(cwd: string): Promise<string | null> {
  const cfg = await resolveProjectDocConfig(cwd);
  const globalDoc = await readGlobalInstructions(cfg.codexHome);
  const projectDocs = await readProjectDocs(cwd, {
    maxBytes: cfg.maxBytes,
    fallbackFilenames: cfg.fallbackFilenames,
  });
  if (!globalDoc && !projectDocs) return null;
  if (globalDoc && projectDocs) {
    return globalDoc + PROJECT_DOC_SEPARATOR + projectDocs;
  }
  return globalDoc ?? projectDocs ?? null;
}

export function formatAgentsInstructions(directory: string, contents: string): string {
  const dir = normalizePath(directory);
  return `# AGENTS.md instructions for ${dir}\n\n<INSTRUCTIONS>\n${contents}\n</INSTRUCTIONS>`;
}

export function appendSkillInstructions(agentsText: string, skillText: string): string {
  const closeTag = "\n</INSTRUCTIONS>";
  const idx = agentsText.lastIndexOf(closeTag);
  if (idx === -1) {
    return `${agentsText}\n\n${skillText}`;
  }
  return `${agentsText.slice(0, idx)}\n\n${skillText}${agentsText.slice(idx)}`;
}
