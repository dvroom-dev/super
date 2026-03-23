import { describe, expect, it } from "bun:test";
import { processAssignmentForTransition, selectedModelKeyForTaskProfile } from "./process_runtime.js";

describe("processAssignmentForTransition", () => {
  it("ignores stale transition task_profile/process_stage when they do not match the requested mode", () => {
    const config: any = {
      taskProfiles: {
        spatial_analysis: { mode: "theory" },
        model_repair: { mode: "code_model" },
      },
      process: {
        stages: {
          feature_inventory: { profile: "spatial_analysis" },
          model_repair: { profile: "model_repair" },
        },
      },
    };

    const assignment = processAssignmentForTransition({
      config,
      mode: "code_model",
      transitionPayload: {
        process_stage: "feature_inventory",
        task_profile: "spatial_analysis",
      },
    });

    expect(assignment.mode).toBe("code_model");
    expect(assignment.profileId).toBe("model_repair");
    expect(assignment.stageId).toBe("model_repair");
  });

  it("selects the first preferred model even when it belongs to a different provider", () => {
    const config: any = {
      taskProfiles: {
        model_repair: { mode: "code_model", preferredModels: ["code_repair"] },
      },
      models: {
        code_repair: { provider: "codex", model: "gpt-5.3-codex-spark" },
      },
    };

    expect(selectedModelKeyForTaskProfile(config, "model_repair")).toBe("code_repair");
  });
});
