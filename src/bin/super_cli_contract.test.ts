import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runSuper(args: string[], envOverrides: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", "src/bin/super.ts", ...args], {
    cwd: "/home/dvroom/projs/super",
    env: {
      ...process.env,
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function writeBasicConfig(workspaceRoot: string): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
    [
      "supervisor:",
      "  stop_condition: task complete",
      "modes:",
      "  default:",
      "    user_message:",
      "      operation: append",
      "      parts:",
      "        - literal: seeded prompt",
      "mode_state_machine:",
      "  initial_mode: default",
      "  transitions:",
      "    default: [default]",
    ].join("\n"),
    "utf8",
  );
}

async function writeV2Config(workspaceRoot: string): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, ".ai-supervisor"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".ai-supervisor", "config.yaml"),
    [
      "schema_version: 2",
      "runtime_defaults:",
      "  agent_provider: mock",
      "  agent_model: mock-model",
      "  supervisor_provider: mock",
      "  supervisor_model: mock-supervisor",
      "task_profiles:",
      "  action_vocabulary:",
      "    mode: default",
      "    resume_strategy: fork_fresh",
      "process:",
      "  initial_stage: action_vocabulary",
      "  ledger_path: super/process_ledger.json",
      "  stages:",
      "    action_vocabulary:",
      "      profile: action_vocabulary",
      "supervisor:",
      "  stop_condition: task complete",
      "modes:",
      "  default:",
      "    user_message:",
      "      operation: append",
      "      parts:",
      "        - literal: seeded prompt",
      "mode_state_machine:",
      "  initial_mode: default",
      "  transitions:",
      "    default: [default]",
    ].join("\n"),
    "utf8",
  );
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("super CLI contracts", () => {
  it("prints only the final assistant message when --output is used with super new", async () => {
    const workspaceRoot = await makeTempDir("super-cli-new-");
    const outputPath = path.join(workspaceRoot, "session.md");
    await writeBasicConfig(workspaceRoot);

    const result = await runSuper(
      ["new", "--workspace", workspaceRoot, "--provider", "mock", "--model", "mock-model", "--disable-supervision", "--cycle-limit", "1", "--output", outputPath],
      { MOCK_PROVIDER_STREAMED_TEXT: "assistant from new" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("mock: starting turn");
    expect(result.stdout.trim()).toBe("assistant from new");
    expect(await fs.readFile(outputPath, "utf8")).toContain("assistant from new");
  });

  it("accepts --prompt-file on super new and preserves image-backed prompt content", async () => {
    const workspaceRoot = await makeTempDir("super-cli-new-prompt-file-");
    const outputPath = path.join(workspaceRoot, "session.md");
    const promptFile = path.join(workspaceRoot, "prompt.yaml");
    const imagePath = path.join(workspaceRoot, "level_001_initial.png");
    await writeBasicConfig(workspaceRoot);
    await fs.writeFile(imagePath, "png", "utf8");
    await fs.writeFile(
      promptFile,
      [
        "operation: append",
        "parts:",
        "  - literal: |",
        "      prompt from file",
        `  - image: ${imagePath}`,
      ].join("\n"),
      "utf8",
    );

    const result = await runSuper(
      [
        "new",
        "--workspace", workspaceRoot,
        "--provider", "mock",
        "--model", "mock-model",
        "--disable-supervision",
        "--cycle-limit", "1",
        "--prompt-file", promptFile,
        "--output", outputPath,
      ],
      { MOCK_PROVIDER_STREAMED_TEXT: "assistant from new" },
    );

    expect(result.exitCode).toBe(0);
    const exported = await fs.readFile(outputPath, "utf8");
    expect(exported).toContain("prompt from file");
    expect(exported).toContain(`![image](${imagePath})`);
  });

  it("resumes from state.json and the fork store without a transcript path", async () => {
    const workspaceRoot = await makeTempDir("super-cli-resume-");
    const outputPath = path.join(workspaceRoot, "resume-output.md");
    await writeBasicConfig(workspaceRoot);
    const first = await runSuper(
      ["new", "--workspace", workspaceRoot, "--provider", "mock", "--model", "mock-model", "--disable-supervision", "--cycle-limit", "1", "--output", outputPath],
      { MOCK_PROVIDER_STREAMED_TEXT: "assistant from new" },
    );
    expect(first.exitCode).toBe(0);
    const priorState = JSON.parse(await fs.readFile(path.join(workspaceRoot, "super", "state.json"), "utf8"));

    const result = await runSuper(
      ["resume", "--workspace", workspaceRoot, "--provider", "mock", "--model", "mock-model", "--disable-supervision", "--cycle-limit", "1", "--output", outputPath],
      { MOCK_PROVIDER_STREAMED_TEXT: "assistant from resume" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("mock: starting turn");
    expect(result.stdout.trim()).toBe("assistant from resume");
    const state = JSON.parse(await fs.readFile(path.join(workspaceRoot, "super", "state.json"), "utf8"));
    expect(state.activeForkId).not.toBe(priorState.activeForkId);
    expect(state.conversationId).toBe(priorState.conversationId);
    const exported = await fs.readFile(outputPath, "utf8");
    expect(exported).toContain("seeded prompt");
    expect(exported).toContain("assistant from new");
    expect(exported).toContain("assistant from resume");
  });

  it("applies --prompt-file on resume as a new user message", async () => {
    const workspaceRoot = await makeTempDir("super-cli-resume-prompt-file-");
    const outputPath = path.join(workspaceRoot, "resume-output.md");
    const promptFile = path.join(workspaceRoot, "resume-prompt.yaml");
    const imagePath = path.join(workspaceRoot, "level_002_initial.png");
    await writeBasicConfig(workspaceRoot);
    await fs.writeFile(imagePath, "png", "utf8");
    await fs.writeFile(
      promptFile,
      [
        "operation: append",
        "parts:",
        "  - literal: |",
        "      resume prompt from file",
        `  - image: ${imagePath}`,
      ].join("\n"),
      "utf8",
    );
    const first = await runSuper(
      ["new", "--workspace", workspaceRoot, "--provider", "mock", "--model", "mock-model", "--disable-supervision", "--cycle-limit", "1", "--output", outputPath],
      { MOCK_PROVIDER_STREAMED_TEXT: "assistant from new" },
    );
    expect(first.exitCode).toBe(0);

    const result = await runSuper(
      [
        "resume",
        "--workspace", workspaceRoot,
        "--provider", "mock",
        "--model", "mock-model",
        "--disable-supervision",
        "--cycle-limit", "1",
        "--prompt-file", promptFile,
        "--output", outputPath,
      ],
      { MOCK_PROVIDER_STREAMED_TEXT: "assistant from resume" },
    );

    expect(result.exitCode).toBe(0);
    const exported = await fs.readFile(outputPath, "utf8");
    expect(exported).toContain("resume prompt from file");
    expect(exported).toContain(`![image](${imagePath})`);
    expect(exported).toContain("assistant from resume");
  });

  it("writes a process ledger for schema_version 2 runs", async () => {
    const workspaceRoot = await makeTempDir("super-cli-v2-ledger-");
    const outputPath = path.join(workspaceRoot, "session.md");
    await writeV2Config(workspaceRoot);

    const result = await runSuper(
      ["new", "--workspace", workspaceRoot, "--provider", "mock", "--model", "mock-model", "--cycle-limit", "1", "--output", outputPath],
      {
        MOCK_PROVIDER_RUNONCE_TEXT: JSON.stringify({
          decision: "fork_new_conversation",
          payload: {
            reason: null,
            advice: null,
            agent_rule_checks: null,
            agent_violation_checks: null,
            message: null,
            message_template: null,
            message_type: null,
            wait_for_boundary: false,
            mode: "default",
            mode_payload: { default: {} },
          },
          transition_payload: {
            process_stage: "action_vocabulary",
            task_profile: "action_vocabulary",
          },
          mode_assessment: {
            current_mode_stop_satisfied: true,
            candidate_modes_ranked: [
              { mode: "default", confidence: "high", evidence: "initial profile maps to default" },
            ],
            recommended_action: "fork_new_conversation",
          },
          reasoning: "bootstrap into default",
          agent_model: null,
        }),
        MOCK_PROVIDER_STREAMED_TEXT: "assistant from v2 new",
      },
    );

    expect(result.exitCode).toBe(0);
    const ledger = JSON.parse(await fs.readFile(path.join(workspaceRoot, "super", "process_ledger.json"), "utf8"));
    expect(ledger.current.stageId).toBe("action_vocabulary");
    expect(ledger.current.profileId).toBe("action_vocabulary");
    expect(Array.isArray(ledger.history)).toBe(true);
    expect(ledger.history.length).toBeGreaterThan(0);
    const runHistory = JSON.parse(
      await fs.readFile(path.join(workspaceRoot, ".ai-supervisor", "supervisor", "run_history", "index.json"), "utf8"),
    );
    expect(Array.isArray(runHistory.forks)).toBe(true);
    expect(runHistory.forks.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects transcript paths for resume", async () => {
    const workspaceRoot = await makeTempDir("super-cli-resume-");
    await writeBasicConfig(workspaceRoot);
    const resumeDocPath = path.join(workspaceRoot, "session.md");
    await fs.writeFile(resumeDocPath, "placeholder", "utf8");

    const result = await runSuper(["resume", resumeDocPath, "--workspace", workspaceRoot]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("resume does not accept a document path");
  });
});
