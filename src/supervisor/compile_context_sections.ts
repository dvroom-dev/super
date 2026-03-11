import type { SkillInstruction, SkillMetadata } from "../skills/types.js";

type TaggedFileContextShape = {
  path: string;
  kind: string;
  content: string;
  truncated?: boolean;
  error?: string;
};

type UtilityStatusShape = {
  name: string;
  command: string;
  available: boolean;
  path?: string;
};

export type SharedPromptContextInputs = {
  workspaceListing?: string;
  utilities?: UtilityStatusShape[];
  taggedFiles?: TaggedFileContextShape[];
  openFiles?: TaggedFileContextShape[];
  skillsToInvoke?: SkillMetadata[];
  skillInstructions?: SkillInstruction[];
};

export function formatFileContexts(title: string, items?: TaggedFileContextShape[], prefix = ""): string[] {
  if (!items || items.length === 0) return [];
  const out: string[] = [];
  out.push(title + ":");
  out.push("");
  for (const t of items) {
    const meta = [t.kind, t.truncated ? "truncated" : "", t.error ? "error" : ""]
      .filter(Boolean)
      .join(", ");
    const label = `${prefix}${t.path}${meta ? ` (${meta})` : ""}`;
    out.push(label);
    if (t.error) out.push(`error: ${t.error}`);
    else out.push(t.content);
    out.push("");
  }
  return out;
}

export function formatUtilities(items?: UtilityStatusShape[]): string[] {
  if (!items || items.length === 0) return [];
  const out: string[] = [];
  out.push("Utilities (preflight):");
  out.push("");
  for (const util of items) {
    const detail = util.available
      ? `available (${util.command}${util.path ? ` @ ${util.path}` : ""})`
      : `missing (${util.command})`;
    out.push(`- ${util.name}: ${detail}`);
  }
  out.push("");
  return out;
}

export function formatSkillsToInvoke(skills?: SkillMetadata[]): string[] {
  if (!skills || skills.length === 0) return [];
  const out: string[] = [];
  out.push("Skills to invoke:");
  out.push("");
  for (const skill of skills) out.push(`- ${skill.name}`);
  out.push("");
  return out;
}

export function formatSkillInstructions(items?: SkillInstruction[]): string[] {
  if (!items || items.length === 0) return [];
  const out: string[] = [];
  out.push("Skill instructions:");
  out.push("");
  for (const item of items) {
    out.push("<skill>");
    out.push(`<name>${item.name}</name>`);
    out.push(`<path>${item.path}</path>`);
    out.push(item.contents);
    out.push("</skill>");
    out.push("");
  }
  return out;
}

export function appendSharedPromptContext(promptParts: string[], input: SharedPromptContextInputs): void {
  if (input.workspaceListing?.trim()) {
    promptParts.push("Workspace listing (top-level):", input.workspaceListing.trim(), "");
  }
  const sections = [
    formatUtilities(input.utilities),
    formatFileContexts("Tagged files (from @path mentions)", input.taggedFiles, "@"),
    formatFileContexts("Open buffers", input.openFiles),
    formatSkillsToInvoke(input.skillsToInvoke),
    formatSkillInstructions(input.skillInstructions),
  ];
  for (const section of sections) {
    if (section.length) promptParts.push(...section);
  }
}
