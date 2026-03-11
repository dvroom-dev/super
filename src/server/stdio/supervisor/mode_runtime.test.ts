import { describe, expect, it } from "bun:test";
import {
  applySupervisorTemplateFields,
  buildFreshModeDocument,
  extractSupervisorTemplateFields,
  resolveModePayload,
  updateFrontmatterModePayload,
} from "./mode_runtime.js";

describe("mode_runtime placeholders + payload persistence", () => {
  it("extracts unique supervisor template fields from text", () => {
    const fields = extractSupervisorTemplateFields(
      [
        "Plan: {{supervisor.hypothesis}}",
        "Probe: {{ supervisor.next_probe }}",
        "Repeat: {{supervisor.hypothesis}}",
      ].join("\n"),
    );
    expect(fields).toEqual(["hypothesis", "next_probe"]);
  });

  it("applies supervisor template field replacements", () => {
    const rendered = applySupervisorTemplateFields(
      "Plan {{supervisor.hypothesis}} then {{supervisor.next_probe}}.",
      {
        hypothesis: "color toggles encode direction",
        next_probe: "move to cross and press space",
      },
    );
    expect(rendered).toContain("color toggles encode direction");
    expect(rendered).toContain("move to cross and press space");
    expect(rendered).not.toContain("{{supervisor.");
  });

  it("stores and loads mode payload in frontmatter", () => {
    const doc = buildFreshModeDocument({
      conversationId: "conv_mode_payload",
      forkId: "fork_mode_payload",
      mode: "plan",
      systemMessage: "Mode system",
      userMessage: "Plan next step.",
      modePayload: {
        hypothesis: "door opens when matching colors align",
        next_probe: "test cross button near center",
      },
    });
    const payload = resolveModePayload(doc);
    expect(doc).toContain("```chat role=system scope=agent_base");
    expect(doc).toContain("Mode system");
    expect(payload.hypothesis).toContain("door opens");
    expect(payload.next_probe).toContain("cross button");
  });

  it("updates existing frontmatter with mode payload", () => {
    const base = [
      "---",
      "conversation_id: conv_update",
      "fork_id: fork_update",
      "mode: explore",
      "---",
      "",
      "```chat role=user",
      "Continue",
      "```",
    ].join("\n");
    const next = updateFrontmatterModePayload(base, {
      hypothesis: "adjacent colors are linked",
    });
    const payload = resolveModePayload(next);
    expect(payload.hypothesis).toBe("adjacent colors are linked");
  });
});
