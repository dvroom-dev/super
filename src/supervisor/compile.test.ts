import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "bun:test";
import {
  CONFIG_SYSTEM_APPEND_BEGIN,
  CONFIG_SYSTEM_APPEND_END,
  compileFullPrompt,
  compileIncrementalPrompt,
  compileSupervisorReview,
  compileGraceAssessment,
  resolveSystemMessage,
  type CompileInputs,
  type SupervisorReviewInputs,
  type GraceAssessmentInputs,
} from "./compile.js";
import { buildSupervisorResponseSchema } from "./review_schema.js";
const fm = ["---", "conversation_id: test", "fork_id: fork_1", "---", ""].join("\n");
const withFm = (body: string) => fm + body;

describe("resolveSystemMessage", () => {
  it("appends configured system text in a bounded replaceable block", () => {
    const result = resolveSystemMessage("Base system", { operation: "append", text: "Config tail" });
    expect(result).toContain("Base system");
    expect(result).toContain(CONFIG_SYSTEM_APPEND_BEGIN);
    expect(result).toContain("Config tail");
    expect(result).toContain(CONFIG_SYSTEM_APPEND_END);
  });
  it("replaces prior appended block instead of stacking", () => {
    const first = resolveSystemMessage("Base system", { operation: "append", text: "First tail" });
    const second = resolveSystemMessage(first, { operation: "append", text: "Second tail" });
    expect(second).toContain("Base system");
    expect(second).toContain("Second tail");
    expect(second).not.toContain("First tail");
    expect(second.match(new RegExp(CONFIG_SYSTEM_APPEND_BEGIN, "g"))?.length ?? 0).toBe(1);
  });
  it("removes prior appended block when append text is empty", () => {
    const first = resolveSystemMessage("Base system", { operation: "append", text: "Tail" });
    const second = resolveSystemMessage(first, { operation: "append", text: "   " });
    expect(second).toBe("Base system");
  });
});

describe("compileFullPrompt", () => {
  it("compiles basic prompt with user message", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nHello\n```"),
      agentRules: [],
    };
    const result = compileFullPrompt(input);
    expect(result.parseErrors).toHaveLength(0);
    expect(result.promptText).toContain("You are Codex");
    expect(result.promptText).toContain("Hello");
    expect(result.lastUserText).toBe("Hello");
  });
  it("appends configured system message", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      configuredSystemMessage: { operation: "append", text: "Custom system tail" },
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("You are Codex");
    expect(result.promptText).toContain("Custom system tail");
  });
  it("replaces default system message when configured", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      provider: "codex",
      agentRules: [],
      defaultSystemMessage: "Default agent system message.",
      configuredSystemMessage: { operation: "replace", text: "You are a custom runner." },
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("You are a custom runner.");
    expect(result.promptText).toContain("You are Codex");
    expect(result.promptText).not.toContain("Default agent system message.");
  });

  it("includes agent rules when configured", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: ["Rule 1", "Rule 2"],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Agent Rules:");
    expect(result.promptText).toContain("- Rule 1");
    expect(result.promptText).toContain("- Rule 2");
  });

  it("includes additional agent rules when configured", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: ["Check A", "Check B"],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Agent Rules:");
    expect(result.promptText).toContain("- Check A");
    expect(result.promptText).toContain("- Check B");
  });

  it("shows (none) when no rules", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).not.toContain("Agent Rules:");
  });

  it("includes AGENTS.md when provided", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      agentsMd: "# AGENTS.md instructions for /tmp\n\n<INSTRUCTIONS>\nProject guidelines here\n</INSTRUCTIONS>",
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("# AGENTS.md instructions for /tmp");
    expect(result.promptText).toContain("Project guidelines here");
  });

  it("includes workspace listing when provided", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      workspaceListing: "src/\npackage.json\nREADME.md",
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Workspace listing (top-level):");
    expect(result.promptText).toContain("src/");
    expect(result.promptText).toContain("package.json");
  });

  it("includes tagged files", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nCheck @file.ts\n```"),
      agentRules: [],
      taggedFiles: [
        { path: "file.ts", kind: "file", content: "const x = 1;" },
      ],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Tagged files");
    expect(result.promptText).toContain("@file.ts");
    expect(result.promptText).toContain("const x = 1;");
  });

  it("includes open buffers", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      openFiles: [
        { path: "open.ts", kind: "file", content: "// open file" },
      ],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Open buffers:");
    expect(result.promptText).toContain("open.ts");
  });

  it("includes utilities status", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      utilities: [
        { name: "ripgrep", command: "rg", available: true, path: "/usr/bin/rg" },
        { name: "fd", command: "fd", available: false },
      ],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Utilities (preflight):");
    expect(result.promptText).toContain("ripgrep: available");
    expect(result.promptText).toContain("fd: missing");
  });

  it("does not duplicate shared context sections", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      workspaceListing: "src/\nREADME.md",
      utilities: [{ name: "ripgrep", command: "rg", available: true, path: "/usr/bin/rg" }],
      taggedFiles: [{ path: "file.ts", kind: "file", content: "const x = 1;" }],
      openFiles: [{ path: "open.ts", kind: "file", content: "// open file" }],
      skillsToInvoke: [{ name: "linting", description: "run lint", path: "/tmp/skills/linting/SKILL.md", scope: "user" }],
      skillInstructions: [{ name: "linting", path: "/tmp/skills/linting/SKILL.md", contents: "do the lint thing" }],
    };
    const result = compileFullPrompt(input);
    const count = (needle: string) => (result.promptText.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    expect(count("Workspace listing (top-level):")).toBe(1);
    expect(count("Utilities (preflight):")).toBe(1);
    expect(count("Tagged files (from @path mentions):")).toBe(1);
    expect(count("Open buffers:")).toBe(1);
    expect(count("Skills to invoke:")).toBe(1);
    expect(count("Skill instructions:")).toBe(1);
  });

  it("includes skills section when provided", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      skills: [{ name: "linting", description: "run lint", path: "/tmp/skills/linting/SKILL.md", scope: "user" }],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("## Skills");
    expect(result.promptText).toContain("linting: run lint");
  });

  it("includes skills to invoke list when provided", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      skillsToInvoke: [{ name: "linting", description: "run lint", path: "/tmp/skills/linting/SKILL.md", scope: "user" }],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Skills to invoke:");
    expect(result.promptText).toContain("- linting");
  });

  it("includes skill instructions when provided", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      skillInstructions: [{ name: "linting", path: "/tmp/skills/linting/SKILL.md", contents: "do the lint thing" }],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Skill instructions:");
    expect(result.promptText).toContain("<skill>");
    expect(result.promptText).toContain("<name>linting</name>");
    expect(result.promptText).toContain("<path>/tmp/skills/linting/SKILL.md</path>");
    expect(result.promptText).toContain("do the lint thing");
  });

  it("strips supervisor_context blocks", () => {
    const input: CompileInputs = {
      documentText: withFm(`\`\`\`supervisor_context section=system
System message
\`\`\`

\`\`\`chat role=user
Actual message
\`\`\``),
      agentRules: [],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).not.toContain("supervisor_context");
    expect(result.promptText).toContain("Actual message");
  });

  it("reports parse errors", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat\nMissing role\n```"),
      agentRules: [],
    };
    const result = compileFullPrompt(input);
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]).toContain("missing valid role");
  });

  it("handles truncated tagged files", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      taggedFiles: [
        { path: "large.ts", kind: "file", content: "...", truncated: true },
      ],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("truncated");
  });

  it("handles missing tagged files", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      taggedFiles: [
        { path: "missing.ts", kind: "missing", content: "", error: "File not found" },
      ],
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("missing");
    expect(result.promptText).toContain("File not found");
  });

  it("includes mode contract and mode-scoped tool list when provided", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      currentMode: "explore",
      allowedNextModes: ["plan"],
      modePayloadFieldsByMode: { plan: ["hypothesis"] },
      modeGuidanceByMode: {
        explore: { description: "Gather evidence.", startWhen: [], stopWhen: ["We can plan."] },
        plan: { description: "Build a concrete plan.", startWhen: ["Evidence is sufficient."], stopWhen: [] },
      },
      availableToolsMarkdown: "- read_file: { path: string }",
      provider: "claude",
      providerFilesystemPolicy: {
        write: { allow: ["theory.md", "components.py"] },
        allowNewFiles: false,
      },
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Mode Contract (agent-visible):");
    expect(result.promptText).toContain("Mode Permissions (agent-visible):");
    expect(result.promptText).toContain("Provider filesystem policy (claude, enforced at runtime):");
    expect(result.promptText).toContain("`theory.md`, `components.py`");
    expect(result.promptText).toContain("New file creation: blocked.");
    expect(result.promptText).toContain('"current_mode": "explore"');
    expect(result.promptText).toContain('"candidate_modes"');
    expect(result.promptText).toContain("Available tools (current mode):");
    expect(result.promptText).toContain("- read_file: { path: string }");
    expect(result.promptText).toContain("Use the `switch_mode` CLI only when you need to move to another mode.");
  });

  it("surfaces the latest mode handoff ahead of older transcript context in full prompts", () => {
    const payload = Buffer.from(JSON.stringify({ user_message: "Execute exactly one ACTION1 and stop." }), "utf8").toString("base64url");
    const documentText = [
      "---",
      "conversation_id: test",
      "fork_id: fork_1",
      "mode: explore_and_solve",
      `mode_payload_b64: ${payload}`,
      "---",
      "",
      "```chat role=user",
      "Old route: ACTION4 ACTION4 ACTION1 ACTION1",
      "```",
      "",
      "```chat role=supervisor",
      "Execute exactly one ACTION1 from the current state, then stop immediately.",
      "```",
    ].join("\n");
    const input: CompileInputs = {
      documentText,
      agentRules: [],
      currentMode: "explore_and_solve",
      allowedNextModes: ["theory"],
      modePayloadFieldsByMode: { theory: [], explore_and_solve: ["user_message"] },
      modeGuidanceByMode: {
        explore_and_solve: { description: "Run the current bounded probe.", startWhen: [], stopWhen: [] },
        theory: { description: "Synthesize next step.", startWhen: [], stopWhen: [] },
      },
    };
    const result = compileFullPrompt(input);
    const activeIdx = result.promptText.indexOf("Active Mode Contract (latest authoritative handoff):");
    const transcriptIdx = result.promptText.indexOf("Authoritative transcript (Markdown). Continue from the last user message:");
    expect(activeIdx).toBeGreaterThan(-1);
    expect(transcriptIdx).toBeGreaterThan(activeIdx);
    expect(result.promptText).toContain('"user_message": "Execute exactly one ACTION1 and stop."');
    expect(result.promptText).toContain("Latest supervisor handoff:");
    expect(result.promptText).toContain("Execute exactly one ACTION1 from the current state, then stop immediately.");
    expect(result.promptText).toContain("Latest user-mode handoff:");
    expect(result.promptText).toContain("Old route: ACTION4 ACTION4 ACTION1 ACTION1");
    expect(result.promptText).toContain("If older transcript content conflicts with this section, treat this section as the current contract for the next turn.");
  });

  it("hydrates offloaded latest handoff blobs into the active mode contract", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "compile-full-prompt-"));
    const blobDir = path.join(workspaceRoot, ".ai-supervisor", "conversations", "conversation_test", "blobs");
    await fs.mkdir(blobDir, { recursive: true });
    const supervisorBlobRel = ".ai-supervisor/conversations/conversation_test/blobs/supervisor.txt";
    const userBlobRel = ".ai-supervisor/conversations/conversation_test/blobs/user.txt";
    await fs.writeFile(path.join(workspaceRoot, supervisorBlobRel), "Execute exactly one ACTION1 from the current state, then stop immediately.\n");
    await fs.writeFile(path.join(workspaceRoot, userBlobRel), "Do not switch yet; update theory and then hand off one bounded target.\n");
    const payload = Buffer.from(JSON.stringify({ user_message: "Execute exactly one ACTION1 and stop." }), "utf8").toString(
      "base64url",
    );
    const documentText = [
      "---",
      "conversation_id: conversation_test",
      "fork_id: fork_1",
      "mode: explore_and_solve",
      `mode_payload_b64: ${payload}`,
      "---",
      "",
      "```chat role=user",
      "summary: (see blob)",
      `blob_ref: ${userBlobRel}`,
      "blob_bytes: 67",
      "```",
      "",
      "```chat role=supervisor",
      "summary: (see blob)",
      `blob_ref: ${supervisorBlobRel}`,
      "blob_bytes: 72",
      "```",
    ].join("\n");
    const result = compileFullPrompt({
      documentText,
      workspaceRoot,
      currentMode: "explore_and_solve",
      allowedNextModes: ["theory"],
      modePayloadFieldsByMode: { theory: [], explore_and_solve: ["user_message"] },
      modeGuidanceByMode: {
        explore_and_solve: { description: "Run the current bounded probe.", startWhen: [], stopWhen: [] },
        theory: { description: "Synthesize next step.", startWhen: [], stopWhen: [] },
      },
    });
    const activeSection = result.promptText.slice(
      result.promptText.indexOf("Active Mode Contract (latest authoritative handoff):"),
      result.promptText.indexOf("Authoritative transcript (Markdown). Continue from the last user message:"),
    );
    expect(result.promptText).toContain("Execute exactly one ACTION1 from the current state, then stop immediately.");
    expect(result.promptText).toContain("Do not switch yet; update theory and then hand off one bounded target.");
    expect(activeSection).not.toContain(`blob_ref: ${supervisorBlobRel}`);
    expect(activeSection).not.toContain(`blob_ref: ${userBlobRel}`);
  });

  it("prefers a persisted leading system block from the transcript", () => {
    const input: CompileInputs = {
      documentText: withFm([
        "```chat role=system scope=agent_base",
        "Persisted session system",
        "```",
        "",
        "```chat role=user",
        "Test",
        "```",
      ].join("\n")),
      agentRules: ["Rule 1"],
      configuredSystemMessage: { operation: "replace", text: "Config system that should be ignored" },
    };
    const result = compileFullPrompt(input);
    expect(result.promptText).toContain("Persisted session system");
    expect(result.promptText).not.toContain("Config system that should be ignored");
  });

});

describe("compileIncrementalPrompt", () => {
  it("compiles prompt with only the latest user message for thread reuse", () => {
    const input: CompileInputs = {
      documentText: withFm(`\`\`\`chat role=system scope=agent_base
Persisted system prompt
\`\`\`

\`\`\`chat role=user
First message
\`\`\`

\`\`\`chat role=assistant
Response
\`\`\`

\`\`\`chat role=user
Last message
\`\`\``),
      agentRules: ["Rule X", "Check Y"],
    };
    const result = compileIncrementalPrompt(input);
    expect(result.parseErrors).toHaveLength(0);
    expect(result.promptText).toContain("Last message");
    expect(result.promptText).not.toContain("Persisted system prompt");
    expect(result.promptText).not.toContain("Rule X");
    expect(result.promptText).not.toContain("Check Y");
  });

  it("returns error when no user message", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=assistant\nOnly assistant\n```"),
      agentRules: [],
    };
    const result = compileIncrementalPrompt(input);
    expect(result.promptText).toContain("No user message found");
    expect(result.parseErrors).toContain("No user message found.");
  });
  it("includes AGENTS.md in incremental prompt", () => {
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      agentsMd: "# AGENTS.md instructions for /tmp\n\n<INSTRUCTIONS>\nGuidelines\n</INSTRUCTIONS>",
    };
    const result = compileIncrementalPrompt(input);
    expect(result.promptText).toContain("# AGENTS.md instructions for /tmp");
    expect(result.promptText).toContain("Guidelines");
  });
});

describe("compileSupervisorReview", () => {
  function reviewInput(overrides?: Partial<SupervisorReviewInputs>): SupervisorReviewInputs {
    return {
      documentText: withFm("```chat role=user\nDo X\n```"),
      agentRules: [],
      assistantText: "I did X",
      stopReasons: ["return_control"],
      trigger: "agent_yield",
      stopCondition: "Task is fully complete",
      currentMode: "explore",
      allowedNextModes: ["explore", "plan"],
      modePayloadFieldsByMode: { explore: [], plan: ["hypothesis", "next_probe"] },
      modeGuidanceByMode: { explore: { description: "Explore unknown mechanics.", startWhen: ["Mechanics are uncertain."], stopWhen: ["Evidence supports concrete planning."] }, plan: { description: "Plan a concrete next action.", startWhen: ["Evidence supports a falsifiable plan."], stopWhen: ["Execution path is chosen."] } },
      responseSchema: buildSupervisorResponseSchema({
        trigger: "agent_yield",
        allowedNextModes: ["explore", "plan"],
        modePayloadFieldsByMode: { explore: [], plan: ["hypothesis", "next_probe"] },
      }),
      ...(overrides ?? {}),
    };
  }

  it("compiles review prompt", () => {
    const input = reviewInput({ agentRules: ["Must do X", "Verify X done"] });
    const result = compileSupervisorReview(input);
    expect(result.promptText).toContain("You are the supervisor for an agent/supervisor loop.");
    expect(result.promptText).toContain("Must do X");
    expect(result.promptText).toContain("Verify X done");
    expect(result.promptText).toContain("I did X");
    expect(result.promptText).toContain("return_control");
    expect(result.promptText).toContain("Trigger: agent_yield");
    expect(result.promptText).toContain("Top-level `decision` must be one of:");
    expect(result.promptText).toContain("Current mode: explore");
    expect(result.promptText).toContain("Allowed next modes: explore, plan");
    expect(result.promptText).toContain("Evaluate mode transitions in this strict order:"); expect(result.promptText).toContain("\"current_mode\": \"explore\""); expect(result.promptText).toContain("\"current_mode_stop_when\"");
    expect(result.promptText).toContain("\"candidate_modes\""); expect(result.promptText).toContain("Evidence supports a falsifiable plan.");
    expect(result.promptText).toContain("Stop condition: Task is fully complete");
  });

  it("includes supervisor-only instructions", () => {
    const input = reviewInput({
      agentRules: ["Keep notes up to date"],
      supervisorInstructions: ["Prefer concise advice"],
      stopCondition: "Task is complete",
      allowedNextModes: ["explore"],
      modePayloadFieldsByMode: { explore: [] },
      responseSchema: buildSupervisorResponseSchema({
        trigger: "agent_yield",
        allowedNextModes: ["explore"],
        modePayloadFieldsByMode: { explore: [] },
      }),
    });
    const result = compileSupervisorReview(input);
    expect(result.promptText).toContain("Agent Requirements:");
    expect(result.promptText).toContain("Keep notes up to date");
    expect(result.promptText).toContain("Supervisor instructions (supervisor-only):");
    expect(result.promptText).toContain("Prefer concise advice");
  });
  it("uses the bootstrap template for run_start_bootstrap", () => {
    const input = reviewInput({
      trigger: "run_start_bootstrap",
      assistantText: "",
      stopReasons: ["run_start_bootstrap"],
      currentMode: "(bootstrap)",
      allowedNextModes: ["explore_and_solve"],
      modePayloadFieldsByMode: { explore_and_solve: ["user_message"] },
      responseSchema: buildSupervisorResponseSchema({
        trigger: "run_start_bootstrap",
        allowedNextModes: ["explore_and_solve"],
        modePayloadFieldsByMode: { explore_and_solve: ["user_message"] },
      }),
    });
    const result = compileSupervisorReview(input);
    expect(result.promptText).toContain("You are the supervisor for a new agent/supervisor run before the first agent turn.");
    expect(result.promptText).toContain("Kind: bootstrap");
    expect(result.promptText).toContain("Allowed starting modes: explore_and_solve");
    expect(result.promptText).not.toContain("Assistant response to review:");
  });
  it("includes supervisor carryover section when provided", () => {
    const input = reviewInput({
      currentMode: "plan",
      allowedNextModes: ["plan", "act"],
      modePayloadFieldsByMode: { plan: [], act: [] },
      responseSchema: buildSupervisorResponseSchema({
        trigger: "agent_yield",
        allowedNextModes: ["plan", "act"],
        modePayloadFieldsByMode: { plan: [], act: [] },
      }),
      supervisorCarryover: "- at: now\n  action: continue",
    });
    const result = compileSupervisorReview(input);
    expect(result.promptText).toContain("Supervisor carryover history:");
    expect(result.promptText).toContain("action: continue");
  });
  it("shows manual when no stop reasons", () => {
    const input = reviewInput({
      documentText: withFm("```chat role=user\nTest\n```"),
      assistantText: "Response",
      stopReasons: [],
      currentMode: "default",
      allowedNextModes: ["default"],
      modePayloadFieldsByMode: { default: [] },
      responseSchema: buildSupervisorResponseSchema({
        trigger: "agent_yield",
        allowedNextModes: ["default"],
        modePayloadFieldsByMode: { default: [] },
      }),
    });
    const result = compileSupervisorReview(input);
    expect(result.promptText).toContain("Stop reasons: manual");
  });
  it("includes multiple stop reasons", () => {
    const input = reviewInput({
      documentText: withFm("```chat role=user\nTest\n```"),
      assistantText: "Response",
      stopReasons: ["time_limit", "token_limit"],
      currentMode: "default",
      allowedNextModes: ["default"],
      modePayloadFieldsByMode: { default: [] },
      responseSchema: buildSupervisorResponseSchema({
        trigger: "agent_yield",
        allowedNextModes: ["default"],
        modePayloadFieldsByMode: { default: [] },
      }),
    });
    const result = compileSupervisorReview(input);
    expect(result.promptText).toContain("time_limit, token_limit");
  });
  it("includes JSON schema instruction", () => {
    const input = reviewInput({
      documentText: withFm("```chat role=user\nTest\n```"),
      assistantText: "Response",
      stopReasons: [],
      currentMode: "default",
      allowedNextModes: ["default"],
      modePayloadFieldsByMode: { default: ["hypothesis"] },
      responseSchema: buildSupervisorResponseSchema({
        trigger: "agent_yield",
        allowedNextModes: ["default"],
        modePayloadFieldsByMode: { default: ["hypothesis"] },
      }),
    });
    const result = compileSupervisorReview(input);
    expect(result.promptText).toContain('"decision"');
    expect(result.promptText).toContain('"stop_and_return"');
    expect(result.promptText).toContain('"rewrite_with_check_supervisor_and_continue"');
    expect(result.promptText).toContain('"fork_new_conversation"');
    expect(result.promptText).toContain("agent_rule_checks");
    expect(result.promptText).toContain("mode_payload");
  });
});

describe("compileGraceAssessment", () => {
  it("compiles grace assessment prompt", () => {
    const input: GraceAssessmentInputs = {
      documentText: withFm("```chat role=user\nComplete task\n```"),
      agentRules: ["Rule 1", "Check 1"],
      assistantText: "Working on it...",
      graceMinutes: 10,
    };
    const result = compileGraceAssessment(input);
    expect(result.promptText).toContain("time limit");
    expect(result.promptText).toContain("Rule 1");
    expect(result.promptText).toContain("Check 1");
    expect(result.promptText).toContain("Working on it...");
    expect(result.promptText).toContain("10 minutes");
  });
  it("includes JSON schema for grace response", () => {
    const input: GraceAssessmentInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      assistantText: "Response",
      graceMinutes: 5,
    };
    const result = compileGraceAssessment(input);
    expect(result.promptText).toContain('"needs_grace":boolean');
    expect(result.promptText).toContain('"progress_summary"');
    expect(result.promptText).toContain('"grace_prompt"');
  });
  it("does not append context-management strategy templates in grace assessment prompts", () => {
    const input: GraceAssessmentInputs = {
      documentText: withFm("```chat role=user\nTest\n```"),
      agentRules: [],
      assistantText: "Response",
      graceMinutes: 5,
      contextManagementStrategy: "focused",
    };
    const result = compileGraceAssessment(input);
    expect(result.promptText).not.toContain("Context management strategy:");
  });
});
