import fs from "node:fs/promises";
import path from "node:path";

export async function loadFluxPromptTemplate(workspaceRoot: string, promptPath: string): Promise<string> {
  return await fs.readFile(path.resolve(workspaceRoot, promptPath), "utf8");
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}
