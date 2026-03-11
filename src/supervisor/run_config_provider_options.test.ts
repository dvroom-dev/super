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

describe("run_config provider options", () => {
  it("parses runtime_defaults provider options for codex, claude, and mock", async () => {
    const root = await makeTempRoot("run-config-");
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
        "runtime_defaults:",
        "  provider_options:",
        "    codex:",
        "      show_raw_agent_reasoning: true",
        "      model_reasoning_summary: auto",
        "    claude:",
        "      settingSources:",
        "        - user",
        "        - project",
        "    mock:",
        "      scripted_events: []",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.runtimeDefaults?.providerOptions).toEqual({
      codex: {
        show_raw_agent_reasoning: true,
        model_reasoning_summary: "auto",
      },
      claude: {
        settingSources: ["user", "project"],
      },
      mock: {
        scripted_events: [],
      },
    });
  });

  it("throws when runtime_defaults provider_options values are not mappings", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "runtime_defaults:",
        "  provider_options:",
        "    codex: true",
      ].join("\n"),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "runtime_defaults.provider_options.codex must be a mapping",
    );
  });
});
