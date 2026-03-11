import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { SkillInstruction, SkillLoadOutcome, SkillMetadata, SkillScope } from "./types.js";

const SKILL_FILENAME = "SKILL.md";
const SKILL_JSON_FILENAME = "SKILL.json";
const SKILLS_DIR_NAME = "skills";
const MAX_SCAN_DEPTH = 6;
const MAX_SKILLS_DIRS_PER_ROOT = 2000;
const MAX_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;

const SKILL_OPEN = /^---\s*$/;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function isHiddenDir(name: string): boolean {
  return name.startsWith(".");
}

function validName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_NAME_LEN;
}

function validDescription(value: string): boolean {
  return value.length > 0 && value.length <= MAX_DESCRIPTION_LEN;
}

async function parseSkillFrontmatter(filePath: string): Promise<{ name: string; description: string } | null> {
  const raw = await fs.readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || !SKILL_OPEN.test(lines[0] ?? "")) {
    throw new Error("missing YAML frontmatter");
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (SKILL_OPEN.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new Error("missing YAML frontmatter");
  }
  let name = "";
  let description = "";
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? "";
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2] ?? "";
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "name") name = value;
    if (key === "description") description = value;
  }
  if (!name) throw new Error("missing field `name`");
  if (!description) throw new Error("missing field `description`");
  if (!validName(name)) throw new Error("invalid name: length");
  if (!validDescription(description)) throw new Error("invalid description: length");
  return { name, description };
}

async function parseSkillJson(filePath: string): Promise<{ name: string; description: string } | null> {
  const raw = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  const name = typeof data?.name === "string" ? data.name : "";
  const description = typeof data?.description === "string" ? data.description : "";
  if (!name || !description) return null;
  if (!validName(name)) throw new Error("invalid name: length");
  if (!validDescription(description)) throw new Error("invalid description: length");
  return { name, description };
}

async function tryLoadSkill(dir: string, scope: SkillScope, outcome: SkillLoadOutcome) {
  const mdPath = path.join(dir, SKILL_FILENAME);
  const jsonPath = path.join(dir, SKILL_JSON_FILENAME);
  let existsMd = false;
  let existsJson = false;
  try {
    const stat = await fs.stat(mdPath);
    existsMd = stat.isFile();
  } catch {
    existsMd = false;
  }
  try {
    const stat = await fs.stat(jsonPath);
    existsJson = stat.isFile();
  } catch {
    existsJson = false;
  }
  if (!existsMd && !existsJson) return;

  try {
    const meta = existsMd ? await parseSkillFrontmatter(mdPath) : await parseSkillJson(jsonPath);
    if (!meta) return;
    const skill: SkillMetadata = {
      name: meta.name,
      description: meta.description,
      path: normalizePath(existsMd ? mdPath : jsonPath),
      scope,
    };
    outcome.skills.push(skill);
  } catch (err: any) {
    outcome.errors.push({ path: normalizePath(existsMd ? mdPath : jsonPath), message: err?.message ?? String(err) });
  }
}

async function discoverSkillsUnderRoot(root: string, scope: SkillScope, outcome: SkillLoadOutcome) {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let seenDirs = 0;

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth > MAX_SCAN_DEPTH) continue;
    if (seenDirs >= MAX_SKILLS_DIRS_PER_ROOT) break;
    seenDirs += 1;

    let entries: fsSync.Dirent[] = [];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    await tryLoadSkill(current.dir, scope, outcome);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (isHiddenDir(entry.name)) continue;
      const next = path.join(current.dir, entry.name);
      queue.push({ dir: next, depth: current.depth + 1 });
    }
  }
}

function defaultCodexHome(): string {
  const env = process.env.CODEX_HOME;
  if (env && env.trim()) return env.trim();
  return path.join(homedir(), ".codex");
}

async function existsDir(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function loadSkills(workspaceRoot: string): Promise<SkillLoadOutcome> {
  const outcome: SkillLoadOutcome = { skills: [], errors: [] };
  const roots: Array<{ path: string; scope: SkillScope }> = [];

  const repoSkills = path.join(workspaceRoot, ".codex", SKILLS_DIR_NAME);
  if (await existsDir(repoSkills)) {
    roots.push({ path: repoSkills, scope: "repo" });
  }

  const codexHome = defaultCodexHome();
  const userSkills = path.join(codexHome, SKILLS_DIR_NAME);
  if (await existsDir(userSkills)) {
    roots.push({ path: userSkills, scope: "user" });
    const systemSkills = path.join(userSkills, ".system");
    if (await existsDir(systemSkills)) {
      roots.push({ path: systemSkills, scope: "system" });
    }
  }

  const adminSkills = path.join("/etc/codex", SKILLS_DIR_NAME);
  if (await existsDir(adminSkills)) {
    roots.push({ path: adminSkills, scope: "admin" });
  }

  for (const root of roots) {
    await discoverSkillsUnderRoot(root.path, root.scope, outcome);
  }

  const seen = new Set<string>();
  outcome.skills = outcome.skills.filter((s) => {
    if (seen.has(s.path)) return false;
    seen.add(s.path);
    return true;
  });

  const scopeRank: Record<SkillScope, number> = { repo: 0, user: 1, system: 2, admin: 3 };
  outcome.skills.sort((a, b) => {
    const rank = scopeRank[a.scope] - scopeRank[b.scope];
    if (rank !== 0) return rank;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.path.localeCompare(b.path);
  });

  return outcome;
}

export function renderSkillsSection(skills: SkillMetadata[]): string | null {
  if (!skills.length) return null;
  const lines: string[] = [];
  lines.push("## Skills");
  lines.push(
    "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill."
  );
  lines.push("### Available skills");
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description} (file: ${normalizePath(skill.path)})`);
  }
  lines.push("### How to use skills");
  lines.push(
    "- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.\n- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.\n- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.\n- How to use a skill (progressive disclosure):\n  1) After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.\n  2) If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything.\n  3) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.\n  4) If `assets/` or templates exist, reuse them instead of recreating from scratch.\n- Coordination and sequencing:\n  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.\n  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.\n- Context hygiene:\n  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.\n  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.\n  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.\n- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue."
  );
  return lines.join("\n");
}

export function skillsMentioned(text: string, skills: SkillMetadata[]): SkillMetadata[] {
  if (!text.trim() || skills.length === 0) return [];
  const lower = text.toLowerCase();
  const matched: SkillMetadata[] = [];
  const seen = new Set<string>();
  for (const skill of skills) {
    const name = skill.name;
    const token = name.toLowerCase();
    const direct = lower.includes(`$${token}`);
    const word = new RegExp(`\\b${token.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(text);
    if ((direct || word) && !seen.has(skill.path)) {
      seen.add(skill.path);
      matched.push(skill);
    }
  }
  return matched;
}

export async function loadSkillInstructions(skills: SkillMetadata[]): Promise<{ instructions: SkillInstruction[]; warnings: string[] }> {
  const instructions: SkillInstruction[] = [];
  const warnings: string[] = [];
  for (const skill of skills) {
    try {
      const contents = await fs.readFile(skill.path, "utf-8");
      instructions.push({ name: skill.name, path: skill.path, contents });
    } catch (err: any) {
      warnings.push(`Failed to load skill ${skill.name} at ${skill.path}: ${err?.message ?? String(err)}`);
    }
  }
  return { instructions, warnings };
}
