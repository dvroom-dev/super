import { describe, expect, it } from "bun:test";
import { promptContentFromText } from "../../../utils/prompt_content.js";
import { resolveConfiguredSystemMessage } from "./system_message_runtime.js";

describe("resolveConfiguredSystemMessage", () => {
  it("applies mode payload and appends default supervisor system guidance", () => {
    const base = {
      operation: "append" as const,
      text: "Mode seed={{supervisor.seed}}",
      images: [],
      content: promptContentFromText("Mode seed={{supervisor.seed}}"),
    };
    const resolved = resolveConfiguredSystemMessage({
      configuredSystemMessage: base,
      modePayload: { seed: "alpha" },
      defaultSystemMessage:
        "Supervisor channel includes <supervisor-command ...> tags.",
    });
    expect(resolved?.text).toContain("Mode seed=alpha");
    expect(resolved?.text).toContain("<supervisor-command ...>");
  });

  it("returns undefined when both configured and default messages are absent", () => {
    const resolved = resolveConfiguredSystemMessage({});
    expect(resolved).toBeUndefined();
  });
});
