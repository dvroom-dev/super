import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_LINES = 1000;
const ROOT = process.cwd();
const SKIP_DIRS = new Set([".git", "node_modules"]);

type Violation = {
  file: string;
  lines: number;
};

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        files.push(...(await collectTypeScriptFiles(path.join(dir, entry.name))));
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith(".ts")) {
      continue;
    }

    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) {
      continue;
    }

    files.push(path.join(dir, entry.name));
  }

  return files;
}

function countLines(contents: string): number {
  if (contents.length === 0) {
    return 0;
  }
  return contents.split("\n").length;
}

async function main(): Promise<void> {
  const files = await collectTypeScriptFiles(ROOT);
  const violations: Violation[] = [];

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    const lines = countLines(contents);
    if (lines > MAX_LINES) {
      violations.push({
        file: path.relative(ROOT, file),
        lines,
      });
    }
  }

  if (violations.length === 0) {
    console.log(`Checked ${files.length} non-test TypeScript files; all are <= ${MAX_LINES} lines.`);
    return;
  }

  violations.sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file));

  console.error(`Non-test TypeScript files must stay at or below ${MAX_LINES} lines.`);
  for (const violation of violations) {
    console.error(`${violation.file}: ${violation.lines} lines`);
  }
  process.exitCode = 1;
}

await main();
