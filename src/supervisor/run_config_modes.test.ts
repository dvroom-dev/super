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

describe("run_config mode schema", () => {
  it("parses mode definitions, state machine, and stop condition", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "supervisor:",
        "  stop_condition: task complete",
        "modes:",
        "  explore:",
        "    description: Explore mechanics and collect evidence.",
        "    start_when:",
        "      - We need more observations before planning.",
        "    stop_when:",
        "      - Evidence is sufficient for a concrete plan.",
        "    system_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore-system",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore-user",
        "    agent_rules:",
        "      operation: append",
        "      requirements:",
        "        - explore-rule",
        "    supervisor_instructions:",
        "      operation: append",
        "      values:",
        "        - explore-supervisor-note",
        "  plan:",
        "    description: Convert evidence into a concrete action plan.",
        "    start_when: Evidence is strong enough for planning.",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: plan-user",
        "mode_state_machine:",
        "  initial_mode: explore",
        "  transitions:",
        "    explore: [explore, plan]",
        "    plan: [plan]",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.stopCondition).toBe("task complete");
    expect(rendered?.modeStateMachine).toEqual({
      initialMode: "explore",
      transitions: {
        explore: ["explore", "plan"],
        plan: ["plan"],
      },
    });
    expect(rendered?.modes?.explore?.systemMessage?.text).toContain("explore-system");
    expect(rendered?.modes?.explore?.userMessage?.text).toContain("explore-user");
    expect(rendered?.modes?.explore?.agentRules).toEqual({
      requirements: ["explore-rule"],
      violations: [],
    });
    expect(rendered?.modes?.explore?.supervisorInstructions).toEqual(["explore-supervisor-note"]);
    expect(rendered?.modes?.explore?.description).toBe("Explore mechanics and collect evidence.");
    expect(rendered?.modes?.explore?.startWhen).toEqual(["We need more observations before planning."]);
    expect(rendered?.modes?.explore?.stopWhen).toEqual(["Evidence is sufficient for a concrete plan."]);
    expect(rendered?.modes?.plan?.userMessage?.text).toContain("plan-user");
    expect(rendered?.modes?.plan?.description).toBe("Convert evidence into a concrete action plan.");
    expect(rendered?.modes?.plan?.startWhen).toEqual(["Evidence is strong enough for planning."]);
    expect(rendered?.modes?.plan?.stopWhen).toBeUndefined();
  });

  it("parses mode-specific tools and renders mode-scoped tool definitions", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "tools:",
        "  allow_builtin:",
        "    - read_file",
        "    - write_file",
        "modes:",
        "  explore:",
        "    system_message:",
        "      operation: append",
        "      parts:",
        "        - template: \"{{tools}}\"",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore-user",
        "    tools:",
        "      allow_builtin:",
        "        - read_file",
        "mode_state_machine:",
        "  initial_mode: explore",
        "  transitions:",
        "    explore: [explore]",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.tools?.builtinPolicy).toEqual({
      mode: "allow",
      names: ["read_file", "write_file"],
    });
    expect(rendered?.modes?.explore?.tools?.builtinPolicy).toEqual({
      mode: "allow",
      names: ["read_file"],
    });
    expect(rendered?.modes?.explore?.systemMessage?.text).toContain("- read_file:");
    expect(rendered?.modes?.explore?.systemMessage?.text).not.toContain("- write_file:");
  });

  it("rejects legacy switch_when mode criteria keys", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "modes:",
        "  explore:",
        "    switch_when: legacy criteria",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore",
      ].join("\n"),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "modes.explore.switch_when is no longer supported; use start_when (and optionally stop_when)",
    );
  });

  it("rejects mode_state_machine references to unknown modes", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "modes:",
        "  explore:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore",
        "mode_state_machine:",
        "  initial_mode: missing",
      ].join("\n"),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "mode_state_machine.initial_mode references unknown mode",
    );
  });
});
