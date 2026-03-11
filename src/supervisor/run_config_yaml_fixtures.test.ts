import { describe, expect, it } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRunConfigForDirectory, renderRunConfig } from "./run_config.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "testdata", "run_config");
const MISSING_HOME = path.join(FIXTURE_DIR, "missing-home");

async function loadFixtureConfig(name: string) {
  return loadRunConfigForDirectory(FIXTURE_DIR, {
    explicitConfigPath: name,
    globalHomeDir: MISSING_HOME,
  });
}

describe("run_config yaml fixtures", () => {
  it("supports modes.<name>.system_message with append semantics", async () => {
    const loaded = await loadFixtureConfig("mode_system_message_append.yaml");
    const rendered = await renderRunConfig(loaded);

    expect(rendered?.modes?.explore?.systemMessage?.text).toContain("base-system");
    expect(rendered?.modes?.explore?.systemMessage?.text).toContain("explore-system");
    expect(rendered?.modes?.explore?.userMessage?.text).toContain("base-user");
    expect(rendered?.modes?.explore?.userMessage?.text).toContain("explore-user");
    expect(rendered?.modes?.explore?.agentRules).toEqual({
      requirements: ["base-requirement", "explore-requirement"],
      violations: ["base-violation", "explore-violation"],
    });
    expect(rendered?.modes?.explore?.supervisorInstructions).toEqual([
      "base-supervisor-instruction",
      "explore-supervisor-instruction",
    ]);
    expect(rendered?.modes?.explore?.startWhen).toEqual(["We need more observations."]);
    expect(rendered?.modes?.explore?.stopWhen).toEqual(["Observations are sufficient."]);
  });

  it("applies mode replace operations from yaml fixtures", async () => {
    const loaded = await loadFixtureConfig("mode_system_message_replace.yaml");
    const rendered = await renderRunConfig(loaded);

    expect(rendered?.modes?.plan?.systemMessage?.text).toContain("plan-system-only");
    expect(rendered?.modes?.plan?.systemMessage?.text).not.toContain("base-system");
    expect(rendered?.modes?.plan?.userMessage?.text).toContain("base-user");
    expect(rendered?.modes?.plan?.userMessage?.text).toContain("plan-user");
    expect(rendered?.modes?.plan?.agentRules).toEqual({
      requirements: ["plan-requirement-only"],
      violations: ["plan-violation-only"],
    });
    expect(rendered?.modes?.plan?.supervisorInstructions).toEqual([
      "plan-supervisor-instruction-only",
    ]);
  });

  it("fails schema validation when a mode fixture omits user_message", async () => {
    await expect(loadFixtureConfig("mode_missing_user_message.yaml")).rejects.toThrow(
      "modes.broken_mode.user_message is required",
    );
  });
});
