import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_DIR = ".ai-supervisor";
const CONFIG_FILENAMES = ["config.yaml", "config.yml"];

type DiscoverOptions = { globalHomeDir?: string };

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const st = await fs.stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function ancestorDirs(cwd: string): string[] {
  const out: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out.reverse();
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const p of paths) {
    if (await fileExists(p)) return p;
  }
  return undefined;
}

export async function discoverRunConfigPaths(cwd: string, options?: DiscoverOptions): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();

  const home = path.resolve(options?.globalHomeDir ?? homedir());
  const globalPath = await firstExisting(CONFIG_FILENAMES.map((name) => path.join(home, CONFIG_DIR, name)));
  if (globalPath) {
    const normalized = path.resolve(globalPath);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      found.push(normalized);
    }
  }

  for (const dir of ancestorDirs(cwd)) {
    const localPath = await firstExisting(CONFIG_FILENAMES.map((name) => path.join(dir, CONFIG_DIR, name)));
    if (!localPath) continue;
    const normalized = path.resolve(localPath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    found.push(normalized);
  }
  return found;
}
