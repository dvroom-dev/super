import { describe, expect, test } from "bun:test";
import { resolveActiveWorkerRuntime, resolveRuntimeProvidersAndModels } from "./super.ts";

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
        agentModel: "claude-opus-4-7",
        supervisorProvider: "codex",
        supervisorModel: "gpt-5.3-codex",
      },
    } as any;

    expect(resolveRuntimeProvidersAndModels(options, renderedConfig)).toEqual({
      agentProvider: "claude",
      agentModel: "claude-opus-4-7",
      supervisorProvider: "codex",
      supervisorModel: "gpt-5.3-codex",
    });
  });
});

describe("resolveActiveWorkerRuntime", () => {
  test("prefers active task-profile model/provider over stale prior state on resume", () => {
    const options = {
      provider: "codex",
      model: "gpt-5-codex",
      providerExplicit: false,
      modelExplicit: false,
      supervisorProviderExplicit: false,
      supervisorModelExplicit: false,
    } as any;
    const renderedConfig = {
      schemaVersion: 2,
      runtimeDefaults: {
        agentProvider: "claude",
        agentModel: "claude-opus-4-7",
        supervisorProvider: "codex",
        supervisorModel: "gpt-5.4",
      },
      models: {
        code_repair: {
          provider: "claude",
          model: "claude-opus-4-7",
        },
      },
      taskProfiles: {
        component_coding: {
          mode: "code_model",
          preferredModels: ["code_repair"],
        },
      },
      process: {
        initialStage: "component_coding",
        stages: {
          component_coding: {
            profile: "component_coding",
          },
        },
      },
    } as any;
    const documentText = [
      "---",
      "mode: code_model",
      "process_stage: component_coding",
      "task_profile: component_coding",
      "---",
      "",
      "body",
    ].join("\n");

    expect(resolveActiveWorkerRuntime({
      options,
      renderedConfig,
      documentText,
      activeTransitionPayload: {},
    })).toEqual({
      agentProvider: "claude",
      agentModel: "claude-opus-4-7",
      supervisorProvider: "codex",
      supervisorModel: "gpt-5.4",
    });
  });
});
