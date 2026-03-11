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

describe("run_config hooks + cycle_limit", () => {
  it("parses hooks and cycle_limit", async () => {
    const root = await makeTempRoot("run-config-hooks-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
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
        "cycle_limit: 7",
        "hooks:",
        "  - trigger: agent_turn_complete",
        "    action: printf 'agent-ok'",
        "  - trigger: supervisor turn complete without error",
        "    action: printf 'supervisor-ok'",
        "    append_stdout_as_user_message: false",
      ].join("\n"),
      "utf8",
    );
    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.cycleLimit).toBe(7);
    expect(rendered?.hooks).toEqual([
      {
        trigger: "agent_turn_complete",
        action: "printf 'agent-ok'",
        appendStdoutAsUserMessage: true,
      },
      {
        trigger: "supervisor_turn_complete",
        action: "printf 'supervisor-ok'",
        appendStdoutAsUserMessage: false,
      },
    ]);
  });

  it("throws on invalid hook trigger", async () => {
    const root = await makeTempRoot("run-config-hooks-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      ["hooks:", "  - trigger: not_real", "    action: echo hi"].join("\n"),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "hook.trigger 'not_real' is invalid",
    );
  });

  it("throws on invalid cycle_limit", async () => {
    const root = await makeTempRoot("run-config-hooks-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      ["cycle_limit: nope"].join("\n"),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "cycle_limit must be a positive number",
    );
  });
});
