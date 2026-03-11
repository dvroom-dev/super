import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeInlineToolCall } from "./tool_calls.js";
import type { InlineToolCall } from "./inline_tools.js";

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

function makeCall(name: string, args: any): InlineToolCall {
  return { name, args, body: JSON.stringify(args) };
}

describe("executeInlineToolCall", () => {
  it("returns structured failure when check_supervisor is invoked without rules context", async () => {
    const workspaceRoot = await makeTempRoot("tool-calls-");
    const result = await executeInlineToolCall({
      call: makeCall("check_supervisor", { mode: "hard" }),
      workspaceRoot,
      conversationId: "conv_missing_rules",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toBe("");
    expect(result.error).toContain("check_supervisor requires rulesCheck context");
    expect(result.markdown).toContain("```tool_result");
    expect(result.markdown).toContain("(ok=false)");
    expect(result.markdown).toContain("[error]");
  });

  it("handles check_rules alias and emits a check_supervisor JSON payload", async () => {
    const workspaceRoot = await makeTempRoot("tool-calls-");
    const result = await executeInlineToolCall({
      call: makeCall("check_rules", { mode: "soft" }),
      workspaceRoot,
      conversationId: "conv_check_rules",
      rulesCheck: {
        workspaceRoot,
        conversationId: "conv_check_rules",
        documentText: "```chat role=user\ncheck\n```",
        trigger: "agent_check_supervisor",
        providerName: "mock",
        model: "mock-model",
        allowedNextModes: ["default"],
        modePayloadFieldsByMode: { default: [] },
      },
    });

    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.source).toBe("check_supervisor");
    expect(payload.trigger).toBe("agent_check_supervisor");
    expect(payload.mode).toBe("soft");
    expect(typeof payload.decision).toBe("string");
    expect(payload.decision).toBe("return_check_supervisor");
    expect(Array.isArray(payload.agent_rule_checks)).toBe(true);
    expect(typeof payload.prompt_log).toBe("string");
    expect(typeof payload.response_log).toBe("string");
    expect(result.markdown).toContain("```tool_result");

    const promptPath = path.join(workspaceRoot, String(payload.prompt_log));
    const responsePath = path.join(workspaceRoot, String(payload.response_log));
    const [promptStat, responseStat] = await Promise.all([fs.stat(promptPath), fs.stat(responsePath)]);
    expect(promptStat.isFile()).toBe(true);
    expect(responseStat.isFile()).toBe(true);
  });

  it("offloads oversized tool output and returns only a file ref plus page hint", async () => {
    const workspaceRoot = await makeTempRoot("tool-calls-");
    const largeText = Array.from({ length: 40 }, (_, idx) => `line_${idx}_${"X".repeat(80)}`).join("\n");
    await fs.writeFile(path.join(workspaceRoot, "large.txt"), largeText, "utf8");

    const result = await executeInlineToolCall({
      call: makeCall("read_file", { path: "large.txt" }),
      workspaceRoot,
      conversationId: "conv_large_output",
      toolOutput: { maxLines: 5, maxBytes: 200 },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("<full results at .ai-supervisor/conversations/conv_large_output/tool_outputs/");
    expect(result.output).toContain("<page 1 of");
    expect(result.output).toContain("paginate_tool_response");
    expect(result.output).not.toContain("line_0_");
    expect(result.markdown).toContain("```tool_result");

    const toolOutputDir = path.join(
      workspaceRoot,
      ".ai-supervisor",
      "conversations",
      "conv_large_output",
      "tool_outputs",
    );
    const entries = await fs.readdir(toolOutputDir);
    expect(entries.some((name) => name.endsWith(".txt"))).toBe(true);
    expect(entries.some((name) => name.endsWith(".json"))).toBe(true);
  });

  it("respects builtin policy from tool config", async () => {
    const workspaceRoot = await makeTempRoot("tool-calls-");
    await fs.writeFile(path.join(workspaceRoot, "blocked.txt"), "blocked", "utf8");
    const result = await executeInlineToolCall({
      call: makeCall("read_file", { path: "blocked.txt" }),
      workspaceRoot,
      conversationId: "conv_blocked",
      toolConfig: { builtinPolicy: { mode: "deny", names: ["read_file"] } },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Tool disabled by config: read_file");
  });

  it("executes configured custom tools", async () => {
    const workspaceRoot = await makeTempRoot("tool-calls-");
    const script =
      "let input='';process.stdin.on('data',(d)=>input+=d);" +
      "process.stdin.on('end',()=>{const args=JSON.parse(input||'{}');process.stdout.write(`custom=${String(args.value ?? '')}`);});";
    const result = await executeInlineToolCall({
      call: makeCall("custom_echo", { value: "ok" }),
      workspaceRoot,
      conversationId: "conv_custom",
      toolConfig: {
        customTools: [
          {
            name: "custom_echo",
            description: "Echo custom value.",
            command: [process.execPath, "-e", script],
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.output.trim()).toBe("custom=ok");
  });

  it("uses toolWorkspaceRoot for builtin tool execution when provided", async () => {
    const workspaceRoot = await makeTempRoot("tool-calls-");
    const toolWorkspaceRoot = path.join(workspaceRoot, "agent-root");
    await fs.mkdir(toolWorkspaceRoot, { recursive: true });
    await fs.writeFile(path.join(toolWorkspaceRoot, "agent-only.txt"), "agent-root-content", "utf8");

    const result = await executeInlineToolCall({
      call: makeCall("read_file", { path: "agent-only.txt" }),
      workspaceRoot,
      toolWorkspaceRoot,
      conversationId: "conv_tool_workspace_root",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("agent-root-content");
  });
});
