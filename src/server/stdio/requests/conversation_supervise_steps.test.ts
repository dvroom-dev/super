import { describe, expect, it } from "bun:test";
import type { CustomToolDefinition } from "../../../tools/definitions.js";
import { providerCustomToolsForTurn } from "./conversation_supervise_steps.js";

describe("providerCustomToolsForTurn", () => {
  it("adds a callable switch_mode proxy tool for Claude by default", () => {
    const tools = providerCustomToolsForTurn({
      providerName: "claude",
      customTools: [],
    });
    expect(tools?.some((tool) => tool.name === "switch_mode")).toBe(true);
  });

  it("does not add switch_mode proxy when switch_mode is denied", () => {
    const tools = providerCustomToolsForTurn({
      providerName: "claude",
      toolConfig: {
        builtinPolicy: {
          mode: "deny",
          names: ["switch_mode"],
        },
        customTools: [],
      },
      customTools: [],
    });
    expect(Boolean(tools?.some((tool) => tool.name === "switch_mode"))).toBe(false);
  });

  it("keeps existing custom tools unchanged for non-Claude providers", () => {
    const customTools: CustomToolDefinition[] = [
      {
        name: "arc_action",
        description: "Run ARC helper",
        command: ["echo", "ok"],
      },
    ];
    const tools = providerCustomToolsForTurn({
      providerName: "codex",
      customTools,
    });
    expect(tools?.map((tool) => tool.name)).toEqual(["arc_action"]);
  });
});
