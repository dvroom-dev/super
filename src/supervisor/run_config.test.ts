import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRunConfigForDirectory, renderRunConfig } from "./run_config.js";
import { renderPromptFile } from "./run_config_prompt_file.js";
import { renderSupervisorMessageTemplatesMarkdown } from "./run_config_supervisor.js";

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

describe("run_config", () => {
  it("renders no builtin message template section when no templates are configured", () => {
    expect(renderSupervisorMessageTemplatesMarkdown(undefined)).toBe("");
    expect(renderSupervisorMessageTemplatesMarkdown([])).toBe("");
  });

  it("merges global and local config with nearest override", async () => {
    const root = await makeTempRoot("run-config-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const nested = path.join(workspace, "apps", "tooling");
    await fs.mkdir(path.join(home, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(path.join(workspace, "apps", ".ai-supervisor"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(home, "global-schema.json"), '{"type":"object","required":["global"]}', "utf8");
    await fs.writeFile(path.join(workspace, "workspace-schema.json"), '{"type":"object","required":["workspace"]}', "utf8");

    await fs.writeFile(
      path.join(home, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemMessage: "global-system",
        systemOperation: "append",
        agentRules: ["global-rule"],
        extra: [
          "runtime_defaults:",
          "  provider: codex",
          "  model: gpt-5.3-codex",
          "context_management_strategy: conservative",
          "output_schema_file: ../global-schema.json",
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemMessage: "workspace-system",
        systemOperation: "replace",
        userMessage: "workspace-user",
        agentRules: ["workspace-rule"],
        supervisorInstructions: ["workspace-supervisor-note"],
        extra: [
          "  review_timeout_ms: 180000",
          "  time_budget_ms: 900000",
          "  token_budget_adjusted: 30000",
          "  cadence_time_ms: 600000",
          "  cadence_tokens_adjusted: 20000",
          "  return_control_pattern: ^return_control:%s*user",
          "  append_supervisor_judgements: true",
          "  disable_synthetic_check_supervisor_on_rule_failure: false",
          "runtime_defaults:",
          "  provider: claude",
          "  model: claude-opus-4-6",
          "  model_reasoning_effort: high",
          "context_management_strategy: focused",
          "tool_output:",
          "  max_lines: 77",
          "  max_bytes: 12345",
          "output_schema_file: ../workspace-schema.json",
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, "apps", ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemMessage: "nested-system",
        userMessage: "nested-user",
        agentRules: ["nested-agent-rule"],
        supervisorInstructions: ["nested-supervisor-note"],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(nested, { globalHomeDir: home });
    expect(loaded).toBeTruthy();
    expect(loaded?.sources.length).toBe(3);

    const rendered = await renderRunConfig(loaded);
    expect(rendered?.systemMessage?.text).toContain("nested-system");
    expect(rendered?.systemMessage?.text).not.toContain("global-system");
    expect(rendered?.systemMessage?.text).not.toContain("workspace-system");
    expect(rendered?.userMessage?.text).toContain("nested-user");
    expect(rendered?.agentRules).toEqual({
      requirements: ["nested-agent-rule"],
      violations: [],
    });
    expect(rendered?.supervisorInstructions).toEqual(["nested-supervisor-note"]);
    expect(rendered?.runtimeDefaults).toEqual({
      provider: "claude",
      model: "claude-opus-4-6",
      modelReasoningEffort: "high",
    });
    expect(rendered?.contextManagementStrategy).toBe("focused");
    expect(rendered?.reviewTimeoutMs).toBe(180000);
    expect(rendered?.supervisor).toEqual({
      timeBudgetMs: 900000,
      tokenBudgetAdjusted: 30000,
      cadenceTimeMs: 600000,
      cadenceTokensAdjusted: 20000,
      cadenceInterruptPolicy: "boundary",
      reviewTimeoutMs: 180000,
      returnControlPattern: "^return_control:%s*user",
      appendSupervisorJudgements: true,
      disableSyntheticCheckSupervisorOnRuleFailure: false,
      agentDefaultSystemMessage:
        "Supervisor channel:\n- The harness may inject supervisor guidance messages between turns.\n- Guidance may be wrapped in `<supervisor-command ...>...</supervisor-command>`.\n- Treat `<supervisor-command>` payloads as authoritative supervisor instructions and prioritize executing them before resuming other work.\n- Preserve the XML tag boundaries when referencing or acknowledging these instructions.",
    });
    expect(rendered?.supervisorTriggers?.cadence?.messageTemplates?.[0]?.text).toContain("<supervisor-command");
    expect(rendered?.toolOutput).toEqual({ maxLines: 77, maxBytes: 12345 });
    expect(rendered?.outputSchema).toEqual({ type: "object", required: ["workspace"] });
  });

  it("interpolates vars across discovered config layers", async () => {
    const root = await makeTempRoot("run-config-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const nested = path.join(workspace, "apps", "tooling");
    const envKey = "RUN_CONFIG_TEST_ENV";
    const prevEnv = process.env[envKey];
    process.env[envKey] = "env-value";
    await fs.mkdir(path.join(home, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });

    await fs.writeFile(
      path.join(home, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemMessage: "global-system",
        userMessage: "global-user",
        extra: [
          "vars:",
          "  base: global-base",
          "  shared: global",
          `  from_env: \${env.${envKey}}`,
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemOperation: "replace",
        userOperation: "replace",
        systemParts: ["      - literal: system-${vars.base}-${vars.shared}"],
        userParts: ["      - literal: user-${vars.from_env}"],
        extra: [
          "vars:",
          "  shared: local",
        ],
      }),
      "utf8",
    );
    try {
      const loaded = await loadRunConfigForDirectory(nested, { globalHomeDir: home });
      const rendered = await renderRunConfig(loaded);
      expect(rendered?.systemMessage?.text).toContain("system-global-base-local");
      expect(rendered?.userMessage?.text).toContain("user-env-value");
    } finally {
      if (prevEnv == null) delete process.env[envKey];
      else process.env[envKey] = prevEnv;
    }
  });

  it("renders per-mode reasoning overrides", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "modes_enabled: true",
        "mode_state_machine:",
        "  initial_mode: explore",
        "runtime_defaults:",
        "  agent_model_reasoning_effort: medium",
        "modes:",
        "  explore:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: explore-user",
        "    agent_model_reasoning_effort: low",
        "  code_model:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - literal: code-user",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.runtimeDefaults?.agentModelReasoningEffort).toBe("medium");
    expect(rendered?.modes?.explore?.agentModelReasoningEffort).toBe("low");
    expect(rendered?.modes?.code_model?.agentModelReasoningEffort).toBeUndefined();
  });

  it("applies cliVars overrides for ${vars.*} interpolation", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        userParts: ["      - literal: objective-${vars.objective}"],
        extra: [
          "vars:",
          "  objective: from-config",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, {
      globalHomeDir: path.join(root, "missing-home"),
      cliVars: { objective: "from-cli" },
    });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.userMessage?.text).toContain("objective-from-cli");
    expect(rendered?.userMessage?.text).not.toContain("objective-from-config");
  });

  it("applies prompt-file override vars during prompt rendering", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.writeFile(
      path.join(root, "prompt.yaml"),
      [
        "operation: append",
        "parts:",
        "  - literal: prompt-${vars.target}",
      ].join("\n"),
      "utf8",
    );

    const renderedPrompt = await renderPromptFile(path.join(root, "prompt.yaml"), undefined, {
      overrideVars: { target: "from-cli" },
    });
    expect(renderedPrompt.text).toContain("prompt-from-cli");
  });

  it("renders templates and reloads referenced files on each render", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(path.join(root, "snippet.txt"), "version-one", "utf8");
    await fs.writeFile(path.join(root, "prompt.txt"), "run the checks", "utf8");
    await fs.writeFile(path.join(root, "schema.json"), '{"type":"object","properties":{"action":{"type":"string"}}}', "utf8");

    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        agentRules: ["Always produce an action"],
        systemParts: [
          "      - template: |",
          "          Header",
          "          {{file:../snippet.txt}}",
          "          {{tools}}",
        ],
        userParts: [
          "      - file: ../prompt.txt",
        ],
        extra: [
          "  review_timeout_ms: 240000",
          "context_management_strategy: aggressive",
          "tool_output:",
          "  max_lines: 15",
          "  max_bytes: 1500",
          "output_schema_file: ../schema.json",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const first = await renderRunConfig(loaded);
    expect(first?.systemMessage?.text).toContain("version-one");
    expect(first?.systemMessage?.text).toContain("- shell: { cmd: string[], cwd?: string }");
    expect(first?.userMessage?.text).toContain("run the checks");
    expect(first?.agentRules).toEqual({
      requirements: ["Always produce an action"],
      violations: [],
    });
    expect(first?.contextManagementStrategy).toBe("aggressive");
    expect(first?.reviewTimeoutMs).toBe(240000);
    expect(first?.supervisor?.reviewTimeoutMs).toBe(240000);
    expect(first?.toolOutput).toEqual({ maxLines: 15, maxBytes: 1500 });
    expect(first?.outputSchema).toEqual({
      type: "object",
      properties: {
        action: { type: "string" },
      },
    });

    await fs.writeFile(path.join(root, "snippet.txt"), "version-two", "utf8");
    await fs.writeFile(path.join(root, "schema.json"), '{"type":"object","required":["action"]}', "utf8");
    const second = await renderRunConfig(loaded);
    expect(second?.systemMessage?.text).toContain("version-two");
    expect(second?.outputSchema).toEqual({ type: "object", required: ["action"] });
  });

  it("renders files part with tail-style headers and per-file byte limit", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(path.join(root, "first.log"), "abcdef", "utf8");
    await fs.writeFile(path.join(root, "second.log"), "0123456789", "utf8");
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - files:",
          "          paths:",
          "            - ../first.log",
          "            - ../second.log",
          "          max_bytes_per_file: 4",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.systemMessage?.text).toContain("==> ../first.log <==");
    expect(rendered?.systemMessage?.text).toContain("\ncdef");
    expect(rendered?.systemMessage?.text).toContain("==> ../second.log <==");
    expect(rendered?.systemMessage?.text).toContain("\n6789");
  });

  it("ignores missing files in files parts by default", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(path.join(root, "exists.log"), "present", "utf8");
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - files:",
          "          paths:",
          "            - ../exists.log",
          "            - ../missing.log",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.systemMessage?.text).toContain("==> ../exists.log <==");
    expect(rendered?.systemMessage?.text).toContain("present");
    expect(rendered?.systemMessage?.text).not.toContain("../missing.log");
  });

  it("fails when files part strict_file_existence is enabled and direct files are missing", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - files:",
          "          strict_file_existence: true",
          "          paths:",
          "            - ../missing.log",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    await expect(renderRunConfig(loaded)).rejects.toThrow("failed to read referenced file '../missing.log'");
  });

  it("supports glob patterns in files parts and does not fail strict mode on unmatched globs", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(path.join(root, "a.log"), "AAA", "utf8");
    await fs.writeFile(path.join(root, "b.log"), "BBB", "utf8");
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - files:",
          "          strict_file_existence: true",
          "          paths:",
          "            - ../*.log",
          "            - ../no-match-*.log",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.systemMessage?.text).toContain("a.log <==");
    expect(rendered?.systemMessage?.text).toContain("b.log <==");
    expect(rendered?.systemMessage?.text).toContain("AAA");
    expect(rendered?.systemMessage?.text).toContain("BBB");
    expect(rendered?.systemMessage?.text).not.toContain("no-match-");
  });

  it("renders supervisor trigger overrides and keeps repo defaults", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "  supervisor_triggers:",
            "    agent_yield:",
            "      supervisor_prompt:",
            "        operation: append",
            "        parts:",
            "          - literal: yield-trigger-note",
          "    base:",
            "      supervisor_prompt:",
            "        operation: replace",
            "        parts:",
            "          - literal: custom-base-supervisor-note",
          "    agent_check_supervisor:",
            "      supervisor_prompt:",
            "        operation: replace",
            "        parts:",
            "          - literal: check-trigger-note",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.supervisorTriggers?.agent_yield?.supervisorPrompt?.text).toContain("yield-trigger-note");
    expect(rendered?.supervisorTriggers?.agent_check_supervisor?.supervisorPrompt?.text).toContain("check-trigger-note");
    expect(rendered?.supervisorTriggers?.agent_check_supervisor?.supervisorPrompt?.operation).toBe("replace");
    expect(rendered?.supervisorTriggers?.agent_error?.supervisorPrompt?.text).toContain("Trigger: `agent_error`.");
    expect(rendered?.supervisorTriggers?.base?.supervisorPrompt?.text).toContain("custom-base-supervisor-note");
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain("Trigger: `cadence`.");
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).not.toContain("Cadence trigger policy");
    expect(rendered?.supervisor?.cadenceTimeMs).toBe(600000);
    expect(rendered?.supervisor?.cadenceInterruptPolicy).toBe("boundary");
    expect(rendered?.supervisor?.reviewTimeoutMs).toBe(120000);
  });

  it("loads default trigger rationale prompts for all supervisor trigger types", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(path.join(root, ".ai-supervisor", "config.yaml"), baseConfig(), "utf8");

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.supervisorTriggers?.agent_yield?.supervisorPrompt?.operation).toBe("append");
    expect(rendered?.supervisorTriggers?.agent_yield?.supervisorPrompt?.text).toContain("Trigger: `agent_yield`.");
    expect(rendered?.supervisorTriggers?.agent_error?.supervisorPrompt?.operation).toBe("append");
    expect(rendered?.supervisorTriggers?.agent_error?.supervisorPrompt?.text).toContain("Trigger: `agent_error`.");
    expect(rendered?.supervisorTriggers?.agent_check_supervisor?.supervisorPrompt?.operation).toBe("append");
    expect(rendered?.supervisorTriggers?.agent_check_supervisor?.supervisorPrompt?.text).toContain("Trigger: `agent_check_supervisor`.");
    expect(rendered?.supervisorTriggers?.agent_tool_intercept?.supervisorPrompt?.operation).toBe("append");
    expect(rendered?.supervisorTriggers?.agent_tool_intercept?.supervisorPrompt?.text).toContain(
      "Trigger: `agent_tool_intercept`.",
    );
    expect(rendered?.supervisorTriggers?.agent_switch_mode_request?.supervisorPrompt?.operation).toBe("append");
    expect(rendered?.supervisorTriggers?.agent_switch_mode_request?.supervisorPrompt?.text).toContain(
      "Trigger: `agent_switch_mode_request`.",
    );
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.operation).toBe("append");
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain("Trigger: `cadence`.");
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain(
      "Message templates by trigger for append_message_and_continue:",
    );
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain("Trigger agent_yield:");
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain("standard_guidance:");
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain("Trigger cadence:");
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain("supervisor_command:");
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain(
      "Trigger agent_switch_mode_request:",
    );
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain(
      "replace_switch_mode_with_guidance:",
    );
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain(
      "Trigger agent_tool_intercept:",
    );
    expect(rendered?.supervisorTriggers?.cadence?.supervisorPrompt?.text).toContain(
      "replace_tool_call_with_guidance:",
    );
    expect(rendered?.supervisor?.agentDefaultSystemMessage).toContain("<supervisor-command ...>");
    expect(rendered?.supervisorTriggers?.cadence?.messageTemplates?.[0]?.messageType).toBe("user");
    expect(rendered?.supervisorTriggers?.cadence?.messageTemplates?.[0]?.text).toContain("<supervisor-command");
  });

  it("replaces matching supervisor interjection triggers while keeping other defaults", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "  supervisor_triggers:",
          "    cadence:",
          "      message_templates:",
          "        - name: custom_cadence",
          "          description: custom cadence guidance",
          "          message_type: user",
          "          text: custom cadence {{message}}",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.supervisorTriggers?.cadence?.messageTemplates?.[0]?.name).toBe("custom_cadence");
    expect(rendered?.supervisorTriggers?.cadence?.messageTemplates?.[0]?.text).toBe("custom cadence {{message}}");
    expect(rendered?.supervisorTriggers?.agent_error?.messageTemplates?.[0]?.text).toContain("Supervisor recovery guidance");
  });

  it("accepts message templates with no customizable fields", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        extra: [
          "  supervisor_triggers:",
          "    cadence:",
          "      message_templates:",
          "        - name: static_cadence",
          "          description: fixed text with no placeholders",
          "          message_type: user",
          "          text: PLEASE_RETURN_CONTROL",
        ],
      }),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.supervisorTriggers?.cadence?.messageTemplates?.[0]?.name).toBe("static_cadence");
    expect(rendered?.supervisorTriggers?.cadence?.messageTemplates?.[0]?.text).toBe("PLEASE_RETURN_CONTROL");
  });

  it("supports image parts in config and prompt files", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(path.join(root, "diagram.png"), "png-bytes", "utf8");
    await fs.writeFile(path.join(root, "prompt-image.png"), "png-bytes", "utf8");
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      baseConfig({
        systemParts: [
          "      - literal: system text",
          "      - image: ../diagram.png",
        ],
        userParts: [
          "      - literal: describe this",
          "      - image: ../diagram.png",
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "prompt.yaml"),
      [
        "operation: append",
        "parts:",
        "  - literal: image prompt",
        "  - image: ./prompt-image.png",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.systemMessage?.text).toContain("system text");
    expect(rendered?.systemMessage?.images).toEqual([path.resolve(root, "diagram.png")]);
    expect(rendered?.userMessage?.text).toContain("![image](");
    expect(rendered?.userMessage?.content).toEqual([
      { type: "text", text: "describe this" },
      { type: "text", text: "\n\n" },
      { type: "image", path: path.resolve(root, "diagram.png") },
    ]);

    const prompt = await renderPromptFile(path.join(root, "prompt.yaml"));
    expect(prompt.text).toContain("image prompt");
    expect(prompt.text).toContain(path.resolve(root, "prompt-image.png"));
    expect(prompt.content.some((part) => part.type === "image")).toBe(true);
  });

  it("renders reusable prompt_parts via prompt_part references", async () => {
    const root = await makeTempRoot("run-config-");
    await fs.mkdir(path.join(root, ".ai-supervisor"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".ai-supervisor", "config.yaml"),
      [
        "prompt_parts:",
        "  common_rules:",
        "    - literal: common rule line",
        "  nested_rules:",
        "    - prompt_part: common_rules",
        "    - literal: nested rule line",
        "agent:",
        "  system_message:",
        "    operation: append",
        "    parts:",
        "      - prompt_part: nested_rules",
        "  user_message:",
        "    operation: append",
        "    parts:",
        "      - literal: user text",
        "modes:",
        "  theory:",
        "    user_message:",
        "      operation: append",
        "      parts:",
        "        - prompt_part: common_rules",
        "mode_state_machine:",
        "  initial_mode: theory",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadRunConfigForDirectory(root, { globalHomeDir: path.join(root, "missing-home") });
    const rendered = await renderRunConfig(loaded);
    expect(rendered?.systemMessage?.text).toContain("common rule line");
    expect(rendered?.systemMessage?.text).toContain("nested rule line");
    expect(rendered?.modes?.theory?.userMessage?.text).toContain("common rule line");
  });

  it("uses explicit config path when provided", async () => {
    const root = await makeTempRoot("run-config-");
    const workspace = path.join(root, "workspace");
    const custom = path.join(root, "custom.yaml");
    await fs.mkdir(path.join(workspace, ".ai-supervisor"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, ".ai-supervisor", "config.yaml"), baseConfig({ userMessage: "default" }), "utf8");
    await fs.writeFile(custom, baseConfig({ userMessage: "explicit" }), "utf8");

    const loaded = await loadRunConfigForDirectory(workspace, { explicitConfigPath: custom });
    const rendered = await renderRunConfig(loaded);
    expect(loaded?.sources).toHaveLength(1);
    expect(rendered?.userMessage?.text).toBe("explicit");
    expect(rendered?.agentRules).toEqual({ requirements: [], violations: [] });
    expect(rendered?.supervisorInstructions).toEqual([]);
    expect(rendered?.runtimeDefaults).toBeUndefined();
    expect(rendered?.contextManagementStrategy).toBeUndefined();
    expect(rendered?.reviewTimeoutMs).toBeUndefined();
    expect(rendered?.toolOutput).toBeUndefined();
  });

});
