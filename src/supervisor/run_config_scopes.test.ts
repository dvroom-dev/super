import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRunConfigForDirectory, renderRunConfig } from "./run_config.js";
import { renderPromptFile } from "./run_config_prompt_file.js";

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

describe("run_config scoped file references", () => {
  it("supports config_file, agent_file, and supervisor_file in config and prompt files", async () => {
    const root = await makeTempRoot("run-config-scopes-");
    const workspace = path.join(root, "workspace");
    const supervisorRoot = path.join(workspace, ".ai-supervisor", "supervisor", "conversation_test");
    await fs.mkdir(path.join(workspace, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(supervisorRoot, { recursive: true });
    await fs.writeFile(path.join(workspace, ".ai-supervisor", "cfg.txt"), "config-scope", "utf8");
    await fs.writeFile(path.join(workspace, "agent.txt"), "agent-scope", "utf8");
    await fs.writeFile(path.join(supervisorRoot, "supervisor.txt"), "supervisor-scope", "utf8");
    await fs.writeFile(
      path.join(workspace, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - config_file: ./cfg.txt",
          "      - agent_file: ./agent.txt",
          "      - supervisor_file: ./supervisor.txt",
          "      - files:",
          "          scope: agent",
          "          paths:",
          "            - ./agent.txt",
          "      - files:",
          "          scope: supervisor",
          "          files:",
          "            - ./supervisor.txt",
          "          max_bytes_per_file: 6",
          "      - template: '{{config_file:./cfg.txt}}|{{agent_file:./agent.txt}}|{{supervisor_file:./supervisor.txt}}'",
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, "prompt.yaml"),
      [
        "operation: append",
        "parts:",
        "  - template: '{{agent_file:./agent.txt}} {{supervisor_file:./supervisor.txt}}'",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(workspace, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded, {
      agentBaseDir: workspace,
      supervisorBaseDir: supervisorRoot,
    });
    expect(rendered?.systemMessage?.text).toContain("config-scope");
    expect(rendered?.systemMessage?.text).toContain("agent-scope");
    expect(rendered?.systemMessage?.text).toContain("supervisor-scope");
    expect(rendered?.systemMessage?.text).toContain("==> ./agent.txt <==");
    expect(rendered?.systemMessage?.text).toContain("==> ./supervisor.txt <==");
    expect(rendered?.systemMessage?.text).toContain("\n-scope");

    const prompt = await renderPromptFile(path.join(workspace, "prompt.yaml"), {
      agentBaseDir: workspace,
      supervisorBaseDir: supervisorRoot,
    });
    expect(prompt.text).toContain("agent-scope supervisor-scope");
  });

  it("errors when agent_file references are missing render roots", async () => {
    const root = await makeTempRoot("run-config-scopes-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ systemParts: ["      - agent_file: ./agent.txt"] }),
      "utf8",
    );
    await fs.writeFile(path.join(root, "agent.txt"), "agent-scope", "utf8");

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    await expect(renderRunConfig(loaded)).rejects.toThrow("agent_file references require render options with agentBaseDir");
  });

  it("resolves config_file from explicit configBaseDir when provided", async () => {
    const root = await makeTempRoot("run-config-scopes-");
    const workspace = path.join(root, "workspace");
    const configRoot = path.join(root, "config-root");
    await fs.mkdir(path.join(workspace, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(path.join(configRoot, "cfg.txt"), "config-from-override", "utf8");
    await fs.writeFile(
      path.join(workspace, ".ai-supervisor", "config.yaml"),
      baseConfig({ systemParts: ["      - config_file: ./cfg.txt"] }),
      "utf8",
    );
    const loaded = await loadRunConfigForDirectory(workspace, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded, {
      configBaseDir: configRoot,
      agentBaseDir: workspace,
      supervisorBaseDir: path.join(root, "supervisor"),
    });
    expect(rendered?.systemMessage?.text).toContain("config-from-override");
  });
});
