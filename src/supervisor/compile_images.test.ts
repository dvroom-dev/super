import { describe, it, expect } from "bun:test";
import path from "node:path";
import { compileFullPrompt, compileIncrementalPrompt, compileSupervisorReview, type CompileInputs } from "./compile.js";
import { buildSupervisorResponseSchema } from "./review_schema.js";

const fm = ["---", "conversation_id: test", "fork_id: fork_1", "---", ""].join("\n");
const withFm = (body: string) => fm + body;

describe("compile multimodal prompt images", () => {
  it("attaches transcript images and configured system images", () => {
    const workspaceRoot = path.resolve("/tmp/compile-images");
    const input: CompileInputs = {
      documentText: withFm("```chat role=user\nSee image ![grid](./grid.png)\n```"),
      workspaceRoot,
      agentRules: [],
      configuredSystemMessage: {
        operation: "append",
        text: "System image",
        images: [path.resolve(workspaceRoot, "system.png")],
      },
    };
    const result = compileFullPrompt(input);
    const imagePaths = result.prompt.filter((part) => part.type === "image").map((part) => part.path);
    expect(imagePaths).toContain(path.resolve(workspaceRoot, "grid.png"));
    expect(imagePaths).toContain(path.resolve(workspaceRoot, "system.png"));
  });

  it("attaches images only from the last user message", () => {
    const workspaceRoot = path.resolve("/tmp/compile-images-incremental");
    const input: CompileInputs = {
      documentText: withFm(`\`\`\`chat role=user
Earlier ![old](./old.png)
\`\`\`

\`\`\`chat role=assistant
ok
\`\`\`

\`\`\`chat role=user
Current ![latest](./latest.png)
\`\`\``),
      workspaceRoot,
      agentRules: [],
    };
    const result = compileIncrementalPrompt(input);
    const imagePaths = result.prompt.filter((part) => part.type === "image").map((part) => part.path);
    expect(imagePaths).toEqual([path.resolve(workspaceRoot, "latest.png")]);
  });

  it("includes transcript images in supervisor review prompts", () => {
    const workspaceRoot = path.resolve("/tmp/compile-images-supervisor");
    const result = compileSupervisorReview({
      documentText: withFm("```chat role=user\nCheck ![state](./state.png)\n```"),
      workspaceRoot,
      agentRules: [],
      assistantText: "Investigating",
      stopReasons: ["agent_stop"],
      trigger: "agent_yield",
      stopCondition: "task complete",
      currentMode: "default",
      allowedNextModes: ["default"],
      modePayloadFieldsByMode: { default: [] },
      responseSchema: buildSupervisorResponseSchema({
        trigger: "agent_yield",
        allowedNextModes: ["default"],
        modePayloadFieldsByMode: { default: [] },
      }),
    });
    const imagePaths = result.prompt.filter((part) => part.type === "image").map((part) => part.path);
    expect(imagePaths).toContain(path.resolve(workspaceRoot, "state.png"));
  });
});
