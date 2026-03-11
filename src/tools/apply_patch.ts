import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../utils/workspace_paths.js";

type PatchOp =
  | { type: "add"; path: string; lines: string[] }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; hunks: Hunk[]; moveTo?: string };

type Hunk = {
  lines: Array<{ kind: "context" | "add" | "remove"; text: string }>;
};

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0 || lines[0] !== BEGIN) {
    throw new Error("apply_patch requires patch to start with '*** Begin Patch'");
  }
  if (lines[lines.length - 1] !== END) {
    throw new Error("apply_patch requires patch to end with '*** End Patch'");
  }

  const ops: PatchOp[] = [];
  let i = 1;
  while (i < lines.length - 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      i += 1;
      const content: string[] = [];
      while (i < lines.length - 1 && !lines[i].startsWith("*** ")) {
        const l = lines[i] ?? "";
        if (!l.startsWith("+")) {
          throw new Error("Add File lines must start with '+'");
        }
        content.push(l.slice(1));
        i += 1;
      }
      ops.push({ type: "add", path: filePath, lines: content });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const filePath = line.slice("*** Delete File: ".length).trim();
      i += 1;
      while (i < lines.length - 1 && !lines[i].startsWith("*** ")) {
        i += 1;
      }
      ops.push({ type: "delete", path: filePath });
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      i += 1;
      const hunks: Hunk[] = [];
      let moveTo: string | undefined;

      while (i < lines.length - 1) {
        const current = lines[i] ?? "";
        if (current.startsWith("*** Move to: ")) {
          moveTo = current.slice("*** Move to: ".length).trim();
          i += 1;
          continue;
        }
        if (current.startsWith("*** ")) break;
        if (current.startsWith("@@")) {
          i += 1;
          const hunkLines: Hunk["lines"] = [];
          while (i < lines.length - 1) {
            const hunkLine = lines[i] ?? "";
            if (hunkLine.startsWith("@@") || hunkLine.startsWith("*** ")) break;
            if (hunkLine.startsWith("+")) {
              hunkLines.push({ kind: "add", text: hunkLine.slice(1) });
            } else if (hunkLine.startsWith("-")) {
              hunkLines.push({ kind: "remove", text: hunkLine.slice(1) });
            } else if (hunkLine.startsWith(" ")) {
              hunkLines.push({ kind: "context", text: hunkLine.slice(1) });
            } else {
              throw new Error("Update File hunks must start with '+', '-', or ' '");
            }
            i += 1;
          }
          if (hunkLines.length === 0) {
            throw new Error("Update File hunks cannot be empty");
          }
          hunks.push({ lines: hunkLines });
          continue;
        }
        i += 1;
      }

      ops.push({ type: "update", path: filePath, hunks, moveTo });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    throw new Error(`Unknown patch directive: ${line}`);
  }

  if (ops.length === 0) {
    throw new Error("apply_patch requires at least one operation");
  }
  return ops;
}

function applyHunks(lines: string[], hunks: Hunk[]): string[] {
  let cursor = 0;
  const output = [...lines];

  for (const hunk of hunks) {
    const match = hunk.lines.filter((l) => l.kind !== "add").map((l) => l.text);
    const replacement = hunk.lines.filter((l) => l.kind !== "remove").map((l) => l.text);
    let found = -1;

    for (let idx = cursor; idx <= output.length - match.length; idx += 1) {
      const slice = output.slice(idx, idx + match.length);
      if (slice.join("\n") === match.join("\n")) {
        found = idx;
        break;
      }
    }

    if (found === -1) {
      throw new Error("Patch hunk failed to apply (context not found)");
    }

    output.splice(found, match.length, ...replacement);
    cursor = found + replacement.length;
  }

  return output;
}

export async function applyPatch(workspaceRoot: string, patchText: string): Promise<string> {
  const ops = parsePatch(patchText);

  for (const op of ops) {
    if (op.type === "add") {
      const abs = await resolveWorkspacePath(workspaceRoot, op.path, { allowMissing: true });
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const content = op.lines.join("\n") + "\n";
      await fs.writeFile(abs, content, "utf-8");
      continue;
    }

    if (op.type === "delete") {
      const abs = await resolveWorkspacePath(workspaceRoot, op.path);
      await fs.rm(abs, { force: true });
      continue;
    }

    const abs = await resolveWorkspacePath(workspaceRoot, op.path);
    const raw = await fs.readFile(abs, "utf-8");
    const hadTrailingNewline = raw.endsWith("\n");
    const currentLines = raw.replace(/\r\n/g, "\n").split("\n");
    if (currentLines.length && currentLines[currentLines.length - 1] === "") {
      currentLines.pop();
    }
    const nextLines = applyHunks(currentLines, op.hunks);
    const nextContent = nextLines.join("\n") + (hadTrailingNewline ? "\n" : "");
    await fs.writeFile(abs, nextContent, "utf-8");

    if (op.moveTo) {
      const dest = await resolveWorkspacePath(workspaceRoot, op.moveTo, { allowMissing: true });
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rm(dest, { force: true });
      await fs.rename(abs, dest);
    }
  }

  return "ok";
}
