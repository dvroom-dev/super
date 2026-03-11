import { describe, expect, it } from "bun:test";
import { firstOutsideWorkspacePath } from "./claude_permissions.js";

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
});
