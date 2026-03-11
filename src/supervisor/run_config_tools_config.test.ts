import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRunConfigForDirectory, renderRunConfig } from "./run_config.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function baseConfig(args: { extra?: string[]; systemParts?: string[] } = {}): string {
  const { extra = [], systemParts = ["      - literal: default system"] } = args;
  return [
    "modes_enabled: false",
    "agent:",
    "  system_message:",
    "    operation: append",
    "    parts:",
    ...systemParts,
    "  user_message:",
    "    operation: append",
    "    parts:",
    "      - literal: default user",
    "  rules:",
    "    operation: append",
    "    requirements: []",
    "    violations: []",
    "supervisor:",
    "  instructions:",
    "    operation: append",
    "    values: []",
    ...extra,
  ].join("\n");
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("run_config tools", () => {
  it("renders merged builtin exclusions and custom tools in {{tools}}", async () => {
    const root = await makeTempRoot("run-config-tools-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".ai-supervisor"), { recursive: true });

    await fs.writeFile(
      path.join(home, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "tools:",
          "  deny_builtin:",
          "    - apply_patch",
          "  custom:",
          "    - name: summarize_state",
          "      description: Home summary tool.",
          "      command: [/bin/echo, home]",
          "  shell_invocation_policy:",
          "    disallow:",
          "      - match_type: contains",
          "        pattern: rm -rf",
          "        case_sensitive: false",
        ],
      }),
      "utf8",
    );

    await fs.writeFile(
      path.join(workspace, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - template: \"{{tools}}\"",
        ],
        extra: [
          "tools:",
          "  deny_builtin:",
          "    - shell",
          "  custom:",
          "    - name: summarize_state",
          "      description: Workspace override summary tool.",
          "      command: [/bin/echo, workspace]",
          "    - name: run_probe",
          "      description: Execute a probe command.",
          "      command: [/bin/echo, probe]",
          "  shell_invocation_policy:",
          "    disallow:",
          "      - match_type: regex",
          "        pattern: \"^sudo\\\\s+\"",
          "        case_sensitive: true",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(workspace, { globalHomeDir: home });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.tools?.builtinPolicy).toEqual({ mode: "deny", names: ["apply_patch", "shell"] });
    expect(rendered?.tools?.customTools?.map((tool) => tool.name)).toEqual(["summarize_state", "run_probe"]);
    expect(rendered?.tools?.shellInvocationPolicy?.disallow).toEqual([
      { matchType: "contains", pattern: "rm -rf", caseSensitive: false },
      { matchType: "regex", pattern: "^sudo\\s+", caseSensitive: true },
    ]);
    const summarizeTool = rendered?.tools?.customTools?.find((tool) => tool.name === "summarize_state");
    expect(summarizeTool?.description).toBe("Workspace override summary tool.");
    expect(summarizeTool?.command).toEqual(["/bin/echo", "workspace"]);

    expect(rendered?.systemMessage?.text).not.toContain("- apply_patch:");
    expect(rendered?.systemMessage?.text).not.toContain("- shell:");
    expect(rendered?.systemMessage?.text).toContain("- run_probe: { args: object } // Execute a probe command.");
    expect(rendered?.systemMessage?.text).toContain("- summarize_state: { args: object } // Workspace override summary tool.");
  });

  it("rejects unsupported builtin tool exclusions", async () => {
    const root = await makeTempRoot("run-config-tools-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "tools:",
          "  deny_builtin:",
          "    - fake_tool",
        ],
      }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "tools.deny_builtin 'fake_tool'",
    );
  });

  it("rejects tools config that specifies both allow and deny lists", async () => {
    const root = await makeTempRoot("run-config-tools-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "tools:",
          "  allow_builtin: [read_file]",
          "  deny_builtin: [write_file]",
        ],
      }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "cannot specify both allow and deny",
    );
  });

  it("renders only allow-listed builtin tools", async () => {
    const root = await makeTempRoot("run-config-tools-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - template: \"{{tools}}\"",
        ],
        extra: [
          "tools:",
          "  allow_builtin:",
          "    - read_file",
          "    - write_file",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.tools?.builtinPolicy).toEqual({ mode: "allow", names: ["read_file", "write_file"] });
    expect(rendered?.systemMessage?.text).toContain("- read_file:");
    expect(rendered?.systemMessage?.text).toContain("- write_file:");
    expect(rendered?.systemMessage?.text).not.toContain("- shell:");
    expect(rendered?.systemMessage?.text).not.toContain("- apply_patch:");
  });

  it("rejects custom tool names that collide with builtins", async () => {
    const root = await makeTempRoot("run-config-tools-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "tools:",
          "  custom:",
          "    - name: shell",
          "      description: Invalid override",
          "      command: [/bin/echo, nope]",
        ],
      }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "conflicts with builtin tool name",
    );
  });

  it("parses provider-specific builtin tool and filesystem policies", async () => {
    const root = await makeTempRoot("run-config-tools-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "tools:",
          "  provider_builtin_tools:",
          "    claude:",
          "      allow: [Bash, Read, Edit, Write]",
          "  provider_filesystem:",
          "    claude:",
          "      allow_new_files: false",
          "      write:",
          "        allow: [theory.md, model.py]",
          "      create:",
          "        allow: [tmp/allowed.txt]",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.tools?.providerBuiltinTools?.claude).toEqual({
      mode: "allow",
      names: ["Bash", "Read", "Edit", "Write"],
    });
    expect(rendered?.tools?.providerFilesystem?.claude).toEqual({
      allowNewFiles: false,
      write: { allow: ["theory.md", "model.py"] },
      create: { allow: ["tmp/allowed.txt"] },
    });
  });
});
