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

  it("uses the explicit resume document instead of the fork stored in super/state.json", async () => {
    const workspaceRoot = await makeTempDir("super-cli-resume-");
    const outputPath = path.join(workspaceRoot, "resume-output.md");
    await writeBasicConfig(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "super"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "super", "state.json"),
      JSON.stringify({
        version: 1,
        workspaceRoot,
        conversationId: "conversation_resume",
        activeForkId: "fork_state_only",
        activeMode: "default",
        activeModePayload: {},
        agentProvider: "mock",
        agentModel: "mock-model",
        supervisorProvider: "mock",
        supervisorModel: "mock-model",
        cycleCount: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        lastStopReasons: [],
        lastStopDetails: [],
      }, null, 2),
      "utf8",
    );
    const resumeDocPath = path.join(workspaceRoot, "resume.md");
    await fs.writeFile(
      resumeDocPath,
      [
        "---",
        "conversation_id: conversation_resume",
        "fork_id: fork_resume",
        "mode: default",
        "---",
        "",
        "```chat role=user",
        "Resume from explicit document.",
        "```",
      ].join("\n"),
      "utf8",
    );

    const result = await runSuper(
      ["resume", resumeDocPath, "--workspace", workspaceRoot, "--provider", "mock", "--model", "mock-model", "--disable-supervision", "--cycle-limit", "1", "--output", outputPath],
      { MOCK_PROVIDER_STREAMED_TEXT: "assistant from resume" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("mock: starting turn");
    expect(result.stdout.trim()).toBe("assistant from resume");
    const state = JSON.parse(await fs.readFile(path.join(workspaceRoot, "super", "state.json"), "utf8"));
    expect(state.activeForkId).not.toBe("fork_state_only");
    const exported = await fs.readFile(outputPath, "utf8");
    expect(exported).toContain("Resume from explicit document.");
    expect(exported).toContain("assistant from resume");
  });
});
