import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { executeTool, type ToolCall } from "./tools.js";
import { storeToolOutput } from "./tool_output.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("executeTool", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("shell tool", () => {
    it("executes simple command", async () => {
      const call: ToolCall = {
        name: "shell",
        args: { cmd: ["echo", "hello"] },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    });

    it("captures exit code on failure", async () => {
      const call: ToolCall = {
        name: "shell",
        args: { cmd: ["false"] },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it("captures stderr", async () => {
      const call: ToolCall = {
        name: "shell",
        args: { cmd: ["bash", "-c", "echo error >&2"] },
      };
      const result = await executeTool(tempDir, call);
      expect(result.output).toContain("error");
      expect(result.output).toContain("[stderr]");
    });

    it("throws when cmd is missing", async () => {
      const call: ToolCall = {
        name: "shell",
        args: {},
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow("requires args.cmd");
    });

    it("throws when cmd is empty array", async () => {
      const call: ToolCall = {
        name: "shell",
        args: { cmd: [] },
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow("requires args.cmd");
    });

    it("uses cwd from args", async () => {
      const subdir = path.join(tempDir, "subdir");
      await fs.mkdir(subdir);

      const call: ToolCall = {
        name: "shell",
        args: { cmd: ["pwd"], cwd: "subdir" },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output.trim()).toBe(subdir);
    });

    it("prevents path escape", async () => {
      const call: ToolCall = {
        name: "shell",
        args: { cmd: ["ls"], cwd: "../../../" },
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow("escapes workspace");
    });

    it("blocks command when shell invocation deny rule exact_match matches", async () => {
      const call: ToolCall = {
        name: "shell",
        args: { cmd: ["echo", "blocked"] },
      };
      await expect(
        executeTool(tempDir, call, {
          shellInvocationPolicy: {
            disallow: [{ matchType: "exact_match", pattern: "echo blocked", caseSensitive: true }],
          },
        }),
      ).rejects.toThrow("shell invocation blocked");
    });

    it("blocks command when shell invocation deny rule contains matches", async () => {
      const call: ToolCall = {
        name: "shell",
        args: { cmd: ["bash", "-lc", "sudo ls"] },
      };
      await expect(
        executeTool(tempDir, call, {
          shellInvocationPolicy: {
            disallow: [{ matchType: "contains", pattern: "sudo", caseSensitive: true }],
          },
        }),
      ).rejects.toThrow("shell invocation blocked");
    });

    it("blocks command when shell invocation deny rule regex matches", async () => {
      const call: ToolCall = {
        name: "shell",
        args: { cmd: ["bash", "-lc", "rm -rf /tmp/nope"] },
      };
      await expect(
        executeTool(tempDir, call, {
          shellInvocationPolicy: {
            disallow: [{ matchType: "regex", pattern: "^bash .*rm -rf", caseSensitive: true }],
          },
        }),
      ).rejects.toThrow("shell invocation blocked");
    });

    it("blocks command when shell invocation allow list does not match", async () => {
      const call: ToolCall = {
        name: "shell",
        args: { cmd: ["python3", "-c", "print('nope')"] },
      };
      await expect(
        executeTool(tempDir, call, {
          shellInvocationPolicy: {
            allow: [{ matchType: "regex", pattern: "^(pwd|ls)(\\s|$)", caseSensitive: true }],
          },
        }),
      ).rejects.toThrow("tools.shell_invocation_policy.allow");
    });
  });

  describe("read_file tool", () => {
    it("reads file content", async () => {
      const filePath = path.join(tempDir, "test.txt");
      await fs.writeFile(filePath, "file content here");

      const call: ToolCall = {
        name: "read_file",
        args: { path: "test.txt" },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output).toBe("file content here");
    });

    it("reads file with absolute path inside workspace", async () => {
      const filePath = path.join(tempDir, "abs.txt");
      await fs.writeFile(filePath, "absolute path content");

      const call: ToolCall = {
        name: "read_file",
        args: { path: filePath },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output).toBe("absolute path content");
    });

    it("throws when path is missing", async () => {
      const call: ToolCall = {
        name: "read_file",
        args: {},
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow("requires args.path");
    });

    it("prevents path escape", async () => {
      const call: ToolCall = {
        name: "read_file",
        args: { path: "../../../etc/passwd" },
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow("escapes workspace");
    });

    it("throws on nonexistent file", async () => {
      const call: ToolCall = {
        name: "read_file",
        args: { path: "nonexistent.txt" },
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow();
    });

    it("rejects symlink escapes", async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-outside-"));
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret");
      await fs.symlink(outsideDir, path.join(tempDir, "linked"));

      const call: ToolCall = {
        name: "read_file",
        args: { path: "linked/secret.txt" },
      };
      try {
        await expect(executeTool(tempDir, call)).rejects.toThrow("escapes workspace");
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("write_file tool", () => {
    it("writes file content", async () => {
      const call: ToolCall = {
        name: "write_file",
        args: { path: "output.txt", content: "written content" },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output).toBe("ok");

      const content = await fs.readFile(path.join(tempDir, "output.txt"), "utf-8");
      expect(content).toBe("written content");
    });

    it("creates parent directories", async () => {
      const call: ToolCall = {
        name: "write_file",
        args: { path: "deep/nested/dir/file.txt", content: "nested content" },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);

      const content = await fs.readFile(path.join(tempDir, "deep/nested/dir/file.txt"), "utf-8");
      expect(content).toBe("nested content");
    });

    it("overwrites existing file", async () => {
      const filePath = path.join(tempDir, "existing.txt");
      await fs.writeFile(filePath, "old content");

      const call: ToolCall = {
        name: "write_file",
        args: { path: "existing.txt", content: "new content" },
      };
      await executeTool(tempDir, call);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("new content");
    });

    it("throws when path is missing", async () => {
      const call: ToolCall = {
        name: "write_file",
        args: { content: "some content" },
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow("requires args.path");
    });

    it("writes empty content when not provided", async () => {
      const call: ToolCall = {
        name: "write_file",
        args: { path: "empty.txt" },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);

      const content = await fs.readFile(path.join(tempDir, "empty.txt"), "utf-8");
      expect(content).toBe("");
    });

    it("prevents path escape", async () => {
      const call: ToolCall = {
        name: "write_file",
        args: { path: "../escape.txt", content: "bad" },
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow("escapes workspace");
    });

    it("rejects writes through symlinked parents", async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-outside-"));
      await fs.symlink(outsideDir, path.join(tempDir, "linked"));

      const call: ToolCall = {
        name: "write_file",
        args: { path: "linked/secret.txt", content: "bad" },
      };
      try {
        await expect(executeTool(tempDir, call)).rejects.toThrow("escapes workspace");
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("list_dir tool", () => {
    it("lists directory contents", async () => {
      await fs.writeFile(path.join(tempDir, "file1.txt"), "");
      await fs.writeFile(path.join(tempDir, "file2.txt"), "");
      await fs.mkdir(path.join(tempDir, "subdir"));

      const call: ToolCall = {
        name: "list_dir",
        args: { path: "." },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("file1.txt");
      expect(result.output).toContain("file2.txt");
      expect(result.output).toContain("subdir/");
    });

    it("marks directories with trailing slash", async () => {
      await fs.mkdir(path.join(tempDir, "mydir"));

      const call: ToolCall = {
        name: "list_dir",
        args: { path: "." },
      };
      const result = await executeTool(tempDir, call);
      expect(result.output).toContain("mydir/");
    });

    it("defaults to current directory", async () => {
      await fs.writeFile(path.join(tempDir, "test.txt"), "");

      const call: ToolCall = {
        name: "list_dir",
        args: {},
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("test.txt");
    });

    it("lists subdirectory", async () => {
      const subdir = path.join(tempDir, "sub");
      await fs.mkdir(subdir);
      await fs.writeFile(path.join(subdir, "inner.txt"), "");

      const call: ToolCall = {
        name: "list_dir",
        args: { path: "sub" },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("inner.txt");
    });

    it("prevents path escape", async () => {
      const call: ToolCall = {
        name: "list_dir",
        args: { path: "../.." },
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow("escapes workspace");
    });

    it("throws on nonexistent directory", async () => {
      const call: ToolCall = {
        name: "list_dir",
        args: { path: "nonexistent" },
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow();
    });
  });

  describe("apply_patch tool", () => {
    it("applies add/update/delete", async () => {
      const addPatch = [
        "*** Begin Patch",
        "*** Add File: hello.txt",
        "+hello",
        "+world",
        "*** End Patch",
      ].join("\n");
      const addResult = await executeTool(tempDir, { name: "apply_patch", args: { command: ["apply_patch", addPatch] } });
      expect(addResult.ok).toBe(true);
      const added = await executeTool(tempDir, { name: "read_file", args: { path: "hello.txt" } });
      expect(added.output.trim()).toBe("hello\nworld");

      const updatePatch = [
        "*** Begin Patch",
        "*** Update File: hello.txt",
        "@@",
        " hello",
        "-world",
        "+codex",
        "*** End Patch",
      ].join("\n");
      const updateResult = await executeTool(tempDir, { name: "apply_patch", args: { patch: updatePatch } });
      expect(updateResult.ok).toBe(true);
      const updated = await executeTool(tempDir, { name: "read_file", args: { path: "hello.txt" } });
      expect(updated.output.trim()).toBe("hello\ncodex");

      const deletePatch = [
        "*** Begin Patch",
        "*** Delete File: hello.txt",
        "*** End Patch",
      ].join("\n");
      const deleteResult = await executeTool(tempDir, { name: "apply_patch", args: { command: ["apply_patch", deletePatch] } });
      expect(deleteResult.ok).toBe(true);
      await expect(executeTool(tempDir, { name: "read_file", args: { path: "hello.txt" } })).rejects.toThrow();
    });

    it("rejects add file paths that escape through symlinks", async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-outside-"));
      await fs.symlink(outsideDir, path.join(tempDir, "linked"));
      const addPatch = [
        "*** Begin Patch",
        "*** Add File: linked/secret.txt",
        "+secret",
        "*** End Patch",
      ].join("\n");
      try {
        await expect(
          executeTool(tempDir, { name: "apply_patch", args: { command: ["apply_patch", addPatch] } }),
        ).rejects.toThrow("escapes workspace");
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("paginate_tool_response tool", () => {
    it("returns requested page", async () => {
      const conversationId = "a".repeat(64);
      const output = ["line1", "line2", "line3", "line4", "line5"].join("\n");
      const stored = await storeToolOutput({
        workspaceRoot: tempDir,
        conversationId,
        output,
        config: { maxLines: 2, maxBytes: 1024 },
      });
      const call: ToolCall = {
        name: "paginate_tool_response",
        args: { id: stored.responseId, page: 2 },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("line3");
      expect(result.output).toContain("page 2 of");
    });

    it("supports conversation ids with prefixes (conversation_*)", async () => {
      const conversationId = "conversation_123e4567-e89b-12d3-a456-426614174000";
      const output = ["line1", "line2", "line3", "line4", "line5"].join("\n");
      const stored = await storeToolOutput({
        workspaceRoot: tempDir,
        conversationId,
        output,
        config: { maxLines: 2, maxBytes: 1024 },
      });
      const call: ToolCall = {
        name: "paginate_tool_response",
        args: { id: stored.responseId, page: 2 },
      };
      const result = await executeTool(tempDir, call);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("line3");
      expect(result.output).toContain("page 2 of");
    });
  });

  describe("custom tools and builtin policy", () => {
    it("executes custom tools and passes args as JSON on stdin", async () => {
      const script =
        "let input='';process.stdin.on('data',(d)=>input+=d);" +
        "process.stdin.on('end',()=>{const args=JSON.parse(input||'{}');process.stdout.write(`value=${String(args.value ?? '')}`);});";
      const call: ToolCall = {
        name: "custom_echo",
        args: { value: "hello" },
      };
      const result = await executeTool(tempDir, call, {
        customTools: [
          {
            name: "custom_echo",
            description: "Echo value from JSON args.",
            command: [process.execPath, "-e", script],
          },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.output.trim()).toBe("value=hello");
    });

    it("blocks denied builtin tools", async () => {
      const call: ToolCall = {
        name: "read_file",
        args: { path: "ignored.txt" },
      };
      await expect(
        executeTool(tempDir, call, { builtinToolPolicy: { mode: "deny", names: ["read_file"] } }),
      ).rejects.toThrow("Tool disabled by config: read_file");
    });

    it("blocks builtin tools not listed in allow policy", async () => {
      const call: ToolCall = {
        name: "read_file",
        args: { path: "ignored.txt" },
      };
      await expect(
        executeTool(tempDir, call, { builtinToolPolicy: { mode: "allow", names: ["list_dir"] } }),
      ).rejects.toThrow("Tool disabled by config: read_file");
    });
  });

  describe("unknown tool", () => {
    it("throws for unknown tool name", async () => {
      const call: ToolCall = {
        name: "unknown_tool",
        args: {},
      };
      await expect(executeTool(tempDir, call)).rejects.toThrow("Unknown tool: unknown_tool");
    });
  });
});
