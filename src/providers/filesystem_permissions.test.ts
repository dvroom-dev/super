import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { firstOutsideWorkspacePath } from "./filesystem_permissions.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("firstOutsideWorkspacePath", () => {
  it("detects explicit file path fields outside workspace", () => {
    const outside = firstOutsideWorkspacePath({
      workspaceRoot: "/tmp/work",
      toolName: "Read",
      input: { file_path: "/etc/passwd" },
    });
    expect(outside).toBe("/etc/passwd");
  });

  it("detects bash command path usage outside workspace", () => {
    const outside = firstOutsideWorkspacePath({
      workspaceRoot: "/tmp/work",
      toolName: "Bash",
      input: { command: "cat /tmp/outside.txt" },
    });
    expect(outside).toBe("/tmp/outside.txt");
  });

  it("allows path usage inside workspace", () => {
    const outside = firstOutsideWorkspacePath({
      workspaceRoot: "/tmp/work",
      toolName: "Read",
      input: { file_path: "/tmp/work/notes.txt" },
    });
    expect(outside).toBeUndefined();
  });

  it("does not treat floor-division // as a path", () => {
    const outside = firstOutsideWorkspacePath({
      workspaceRoot: "/tmp/work",
      toolName: "Bash",
      input: {
        command: "arc_repl exec <<'PY'\\nprint(10 // 2)\\nPY",
      },
    });
    expect(outside).toBeUndefined();
  });

  it("detects symlinked paths that resolve outside the workspace", async () => {
    const workspaceRoot = await makeTempDir("super-fs-workspace-");
    const outsideDir = await makeTempDir("super-fs-outside-");
    await fs.symlink(outsideDir, path.join(workspaceRoot, "linked"));

    const outside = firstOutsideWorkspacePath({
      workspaceRoot,
      toolName: "Read",
      input: { file_path: "linked/secret.txt" },
    });

    expect(outside).toBe(path.join(outsideDir, "secret.txt"));
  });
});
