import { describe, expect, test } from "bun:test";
import { resolveRuntimeProvidersAndModels } from "./super.ts";

describe("resolveRuntimeProvidersAndModels", () => {
  test("prefers rendered runtime defaults over CLI defaults for agent prompt construction", () => {
    const options = {
      provider: "codex",
      model: "gpt-5-codex",
      providerExplicit: false,
      modelExplicit: false,
      supervisorProviderExplicit: false,
      supervisorModelExplicit: false,
    } as any;
    const renderedConfig = {
      runtimeDefaults: {
        agentProvider: "claude",
        agentModel: "claude-opus-4-6",
        supervisorProvider: "codex",
        supervisorModel: "gpt-5.3-codex",
      },
    } as any;

    expect(resolveRuntimeProvidersAndModels(options, renderedConfig)).toEqual({
      agentProvider: "claude",
      agentModel: "claude-opus-4-6",
      supervisorProvider: "codex",
      supervisorModel: "gpt-5.3-codex",
    });
  });
});
