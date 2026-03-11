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

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("run_config sdk_builtin_tools", () => {
  it("merges sdk builtin deny policies across global and local config", async () => {
    const root = await makeTempRoot("run-config-sdk-tools-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".ai-supervisor"), { recursive: true });

    await fs.writeFile(
      path.join(home, ".ai-supervisor", "config.yaml"),
      [
        "sdk_builtin_tools:",
        "  claude:",
        "    deny:",
        "      - Task",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, ".ai-supervisor", "config.yaml"),
      [
        "modes_enabled: false",
        "agent:",
    "  system_message:",
        "    operation: append",
        "    parts:",
        "      - literal: system",
        "  user_message:",
        "    operation: append",
        "    parts:",
        "      - literal: user",
        "  rules:",
        "    operation: append",
        "    requirements: []",
        "    violations: []",
        "supervisor:",
    "  instructions:",
        "    operation: append",
        "    values: []",
        "sdk_builtin_tools:",
        "  claude:",
        "    deny:",
        "      - TodoWrite",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(workspace, { globalHomeDir: home });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.sdkBuiltinTools?.claude).toEqual({
      mode: "deny",
      names: ["Task", "TodoWrite"],
    });
  });

  it("rejects provider sdk tool config with both allow and deny", async () => {
    const root = await makeTempRoot("run-config-sdk-tools-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "sdk_builtin_tools:",
        "  claude:",
        "    allow: [Read]",
        "    deny: [Task]",
      ].join("\n"),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "sdk_builtin_tools.claude cannot specify both allow and deny",
    );
  });

  it("rejects unsupported sdk builtin tool providers", async () => {
    const root = await makeTempRoot("run-config-sdk-tools-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "sdk_builtin_tools:",
        "  unknown_provider:",
        "    deny: [task]",
      ].join("\n"),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "sdk_builtin_tools.unknown_provider must target codex|claude|mock",
    );
  });
});
