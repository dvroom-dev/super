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

function baseConfig(args?: {
  systemMessage?: string;
  systemOperation?: "append" | "replace";
  systemParts?: string[];
  userMessage?: string;
  userOperation?: "append" | "replace";
  userParts?: string[];
  agentRules?: string[];
  agentRuleViolations?: string[];
  agentRulesOperation?: "append" | "replace";
  supervisorInstructions?: string[];
  supervisorInstructionsOperation?: "append" | "replace";
  extra?: string[];
}): string {
  const {
    systemMessage = "default-system",
    systemOperation = "append",
    systemParts,
    userMessage = "default-user",
    userOperation = "append",
    userParts,
    agentRules = [],
    agentRuleViolations = [],
    agentRulesOperation = "append",
    supervisorInstructions = [],
    supervisorInstructionsOperation = "append",
    extra = [],
  } = args ?? {};
  const resolvedSystemParts = systemParts ?? [`      - literal: ${systemMessage}`];
  const resolvedUserParts = userParts ?? [`      - literal: ${userMessage}`];
  return [
    "modes_enabled: false",
    "agent:",
    "  system_message:",
    `    operation: ${systemOperation}`,
    "    parts:",
    ...resolvedSystemParts,
    "  user_message:",
    `    operation: ${userOperation}`,
    "    parts:",
    ...resolvedUserParts,
    "  rules:",
    `    operation: ${agentRulesOperation}`,
    ...(agentRules.length ? ["    requirements:", ...agentRules.map((rule) => `      - ${rule}`)] : ["    requirements: []"]),
    ...(agentRuleViolations.length
      ? ["    violations:", ...agentRuleViolations.map((rule) => `      - ${rule}`)]
      : ["    violations: []"]),
    "supervisor:",
    "  instructions:",
    `    operation: ${supervisorInstructionsOperation}`,
    ...(supervisorInstructions.length
      ? ["    values:", ...supervisorInstructions.map((rule) => `      - ${rule}`)]
      : ["    values: []"]),
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

describe("run_config validation", () => {
  it("throws on invalid runtime_defaults.provider", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["runtime_defaults:", "  provider: openrouter"] }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "runtime_defaults.provider must be codex|claude|gemini|mock",
    );
  });

  it("throws on invalid runtime_defaults.model_reasoning_effort", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["runtime_defaults:", "  model_reasoning_effort: turbo"] }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "runtime_defaults.model_reasoning_effort must be minimal|low|medium|high|xhigh",
    );
  });

  it("throws on invalid runtime_defaults.supervisor_model_reasoning_effort", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["runtime_defaults:", "  supervisor_model_reasoning_effort: turbo"] }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "runtime_defaults.supervisor_model_reasoning_effort must be minimal|low|medium|high|xhigh",
    );
  });

  it("parses runtime_defaults agent/supervisor model split fields", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "runtime_defaults:",
          "  agent_provider: claude",
          "  agent_model: claude-opus-4-6",
          "  agent_model_reasoning_effort: low",
          "  supervisor_provider: codex",
          "  supervisor_model: gpt-5.3-codex",
          "  supervisor_model_reasoning_effort: high",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.runtimeDefaults).toEqual({
      agentProvider: "claude",
      agentModel: "claude-opus-4-6",
      agentModelReasoningEffort: "low",
      supervisorProvider: "codex",
      supervisorModel: "gpt-5.3-codex",
      supervisorModelReasoningEffort: "high",
    });
  });

  it("throws on invalid modes.*.agent_model_reasoning_effort", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "modes_enabled: true",
        "modes:",
        "  explore:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore-user",
        "    agent_model_reasoning_effort: turbo",
      ].join("\n"),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "modes.explore.agent_model_reasoning_effort must be minimal|low|medium|high|xhigh",
    );
  });

  it("throws on invalid supervisor config field types", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["  cadence_tokens_adjusted: nope"] }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "supervisor.cadence_tokens_adjusted must be a positive number",
    );
  });

  it("throws on invalid supervisor.cadence_interrupt_policy value", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["  cadence_interrupt_policy: preempt"] }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "supervisor.cadence_interrupt_policy must be boundary|interrupt",
    );
  });

  it("parses supervisor.cadence_interrupt_policy override", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["  cadence_interrupt_policy: interrupt"] }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.supervisor?.cadenceInterruptPolicy).toBe("interrupt");
  });

  it("parses supervisor.tool_interception rules", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "  tool_interception:",
          "    rules:",
          "      - name: block-rm-rf",
          "        when: invocation",
          "        tool: bash",
          "        match_type: contains",
          "        pattern: rm -rf",
          "      - when: response",
          "        tool: mcp",
          "        match:",
          "          type: regex",
          "          pattern: ERROR_[0-9]+",
          "          case_sensitive: false",
          "        action:",
          "          type: supervisor_switch_mode",
          "          target_mode: code_model",
          "          reason: compare mismatch",
        ],
      }),
      "utf8",
    );
    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.supervisor?.toolInterception?.rules).toEqual([
      {
        name: "block-rm-rf",
        when: "invocation",
        tool: "bash",
        matchType: "contains",
        pattern: "rm -rf",
        caseSensitive: true,
      },
      {
        when: "response",
        tool: "mcp",
        matchType: "regex",
        pattern: "ERROR_[0-9]+",
        caseSensitive: false,
        action: {
          type: "supervisor_switch_mode",
          targetMode: "code_model",
          reason: "compare mismatch",
        },
      },
    ]);
  });

  it("rejects provider-specific tool policies that omit runtime_defaults.agent_provider", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "runtime_defaults:",
          "  agent_provider: codex",
          "tools:",
          "  provider_builtin_tools:",
          "    claude:",
          "      allow: [Bash, Read]",
        ],
      }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "tools.provider_builtin_tools is configured for claude but missing runtime_defaults.agent_provider 'codex'",
    );
  });

  it("throws on invalid supervisor.tool_interception regex", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "  tool_interception:",
          "    rules:",
          "      - when: response",
          "        tool: bash",
          "        match_type: regex",
          "        pattern: \"([unterminated\"",
        ],
      }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "supervisor.tool_interception.rules[0].pattern is not a valid regex",
    );
  });

  it("throws on unresolved vars references", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: ["      - literal: ${vars.missing_value}"],
      }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "unresolved variable '${vars.missing_value}' at agent.system_message.parts[0].literal",
    );
  });

  it("throws on cyclic vars references", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "vars:",
          "  a: ${vars.b}",
          "  b: ${vars.a}",
        ],
      }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "cyclic vars reference detected",
    );
  });

  it("throws on invalid files part byte cap", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - files:",
          "          paths:",
          "            - ../one.txt",
          "          max_bytes_per_file: -1",
        ],
      }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "part 'files.max_bytes_per_file' must be a non-negative integer",
    );
  });

  it("throws on invalid files part strict_file_existence", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - files:",
          "          paths:",
          "            - ../one.txt",
          "          strict_file_existence: nope",
        ],
      }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "part 'files.strict_file_existence' must be true or false",
    );
  });

  it("throws when files part uses unsupported scope", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - files:",
          "          scope: workspace",
          "          paths:",
          "            - ../one.txt",
        ],
      }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "part 'files.scope' must be config|agent|supervisor",
    );
  });

  it("throws on invalid tools.shell_invocation_policy match_type", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "tools:",
          "  shell_invocation_policy:",
          "    disallow:",
          "      - match_type: wildcard",
          "        pattern: rm -rf",
        ],
      }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "tools.shell_invocation_policy.disallow[0].match_type must be exact_match|contains|regex",
    );
  });

  it("throws on invalid tools.shell_invocation_policy regex pattern", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "tools:",
          "  shell_invocation_policy:",
          "    disallow:",
          "      - match_type: regex",
          "        pattern: \"[unterminated\"",
        ],
      }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "tools.shell_invocation_policy.disallow[0].pattern is not a valid regex",
    );
  });

  it("throws on invalid supervisor.prompt_by_trigger type", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["  prompt_by_trigger: true"] }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "supervisor.prompt_by_trigger has been renamed to supervisor.supervisor_triggers.<trigger>.supervisor_prompt",
    );
  });

  it("throws on invalid supervisor.supervisor_triggers message_templates[].message_type", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "  supervisor_triggers:",
          "    cadence:",
          "      message_templates:",
          "        - name: cadence_bad",
          "          description: invalid role",
          "          message_type: robot",
          "          text: '{{message}}'",
        ],
      }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "supervisor.supervisor_triggers.cadence.message_templates[0].message_type must be user|assistant|system|developer|supervisor",
    );
  });

  it("throws when message_templates text uses unsupported placeholders", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "  supervisor_triggers:",
          "    cadence:",
          "      message_templates:",
          "        - name: bad_template",
          "          description: invalid placeholder",
          "          message_type: user",
          "          text: '{{decision}} {{message}}'",
        ],
      }),
      "utf8",
    );
    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "supervisor.supervisor_triggers.cadence.message_templates[0].text supports only {{message}} placeholder",
    );
  });

  it("rejects legacy supervisor.agent_message_templates key", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "  agent_message_templates:",
          "    cadence:",
          "      message_type: user",
          "      text: ping",
        ],
      }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "supervisor.agent_message_templates has been renamed to supervisor.supervisor_triggers.<trigger>.message_templates",
    );
  });

  it("rejects agent.user_message.mode; operation is required", async () => {
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
        "    mode: replace",
        "    parts:",
        "      - literal: keep-this-user-message",
        "  rules:",
        "    operation: append",
        "    requirements: []",
        "    violations: []",
        "supervisor:",
        "  instructions:",
        "    operation: append",
        "    values: []",
      ].join("\n"),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "agent.user_message.mode is not supported; use agent.user_message.operation",
    );
  });

  it("throws when output schema file is not valid JSON", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(path.join(root, "bad.json"), "{", "utf8");
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["output_schema_file: ../bad.json"] }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    await expect(renderRunConfig(loaded)).rejects.toThrow("failed to parse output_schema_file");
  });

  it("throws on invalid context management strategy", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["context_management_strategy: turbo"] }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "invalid context_management_strategy",
    );
  });

  it("throws on invalid review_timeout_ms", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["  review_timeout_ms: nope"] }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "review_timeout_ms must be a positive number",
    );
  });

  it("throws when tool_output is not a mapping", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["tool_output: 10"] }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "tool_output must be a mapping",
    );
  });

  it("supports tool_output.max_kb as a byte cap", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["tool_output:", "  max_lines: 50", "  max_kb: 12"] }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.toolOutput).toEqual({ maxLines: 50, maxBytes: 12 * 1024 });
  });

  it("prefers tool_output.max_bytes over max_kb when both are set", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["tool_output:", "  max_lines: 20", "  max_kb: 64", "  max_bytes: 2048"] }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.toolOutput).toEqual({ maxLines: 20, maxBytes: 2048 });
  });

  it("applies benchmark_strict preset rules and keeps custom rules appended", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        agentRules: ["custom-agent-rule"],
        supervisorInstructions: ["custom-supervisor-note"],
        extra: ["presets:", "  - benchmark_strict"],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.presets).toEqual(["benchmark_strict"]);
    expect(rendered?.agentRules.requirements.length).toBeGreaterThan(1);
    expect(rendered?.agentRules.requirements).toContain("custom-agent-rule");
    expect(rendered?.agentRules.requirements).toContain("The task is only complete if measured cycles are strictly below 1000.");
    expect(rendered?.supervisorInstructions).toContain("custom-supervisor-note");
    expect(rendered?.supervisorInstructions).toContain("If cycles are >= 1000, do not allow completion claims; force continuation.");
  });

  it("supports benchmark_strict boolean shortcut", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["benchmark_strict: true"] }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.presets).toEqual(["benchmark_strict"]);
    expect(rendered?.agentRules.requirements).toContain(
      "Do not monkeypatch, clamp, spoof, or otherwise alter cycle accounting or benchmark reporting.",
    );
  });

  it("throws on unsupported preset names", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({ extra: ["presets:", "  - not_a_real_preset"] }),
      "utf8",
    );

    await expect(loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") })).rejects.toThrow(
      "unsupported preset",
    );
  });
});
