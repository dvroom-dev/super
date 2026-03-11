import { describe, expect, it } from "bun:test";
import { toolInterceptionContextForTool } from "./conversation_supervise_tool_interception.js";

describe("tool interception context normalization", () => {
  it("maps Claude Bash tool names to bash interception context", () => {
    const context = toolInterceptionContextForTool({
      toolName: "Bash",
      toolArgs: { command: "arc_repl status 2>&1" },
    });
    expect(context?.tool).toBe("bash");
    expect(context?.toolName).toBe("Bash");
    expect(context?.invocationText).toContain("arc_repl status 2>&1");
  });

  it("keeps builtin non-shell tools out of interception scope", () => {
    const context = toolInterceptionContextForTool({
      toolName: "Read",
      toolArgs: { file_path: "./theory.md" },
    });
    expect(context).toBeUndefined();
  });

  it("maps unknown/custom tools to mcp interception context", () => {
    const context = toolInterceptionContextForTool({
      toolName: "mcp__arc_tools__action",
      toolArgs: { action: "status" },
      toolConfig: {
        customTools: [{ name: "mcp__arc_tools__action", command: ["true"] }],
      } as any,
    });
    expect(context?.tool).toBe("mcp");
    expect(context?.invocationText).toContain("tool_name: mcp__arc_tools__action");
  });
});
