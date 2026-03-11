import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string>();

function templateDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "prompts");
}

export function loadPromptTemplate(name: string): string {
  const cached = cache.get(name);
  if (cached != null) return cached;
  const filePath = path.join(templateDir(), name);
  try {
    const text = fs.readFileSync(filePath, "utf8");
    cache.set(name, text);
    return text;
  } catch {
    cache.set(name, "");
    return "";
  }
}

export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
    return vars[key] ?? "";
  });
}

