import type { FluxSeedBundle } from "./types.js";

export function schemaForName(name: string): Record<string, unknown> | undefined {
  if (name === "model_update_v1") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["decision", "summary", "message_for_bootstrapper", "artifacts_updated", "evidence_watermark"],
      properties: {
        decision: { enum: ["updated_model", "no_material_change"] },
        summary: { type: "string" },
        message_for_bootstrapper: { type: "string" },
        artifacts_updated: { type: "array", items: { type: "string" } },
        evidence_watermark: { type: "string" },
      },
    };
  }
  if (name === "bootstrap_attestation_v1") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["decision", "summary", "seed_bundle_updated", "notes"],
      properties: {
        decision: { enum: ["retry_with_updated_seed", "replay_satisfactory"] },
        summary: { type: "string" },
        seed_bundle_updated: { type: "boolean" },
        notes: { type: "string" },
      },
    };
  }
  return undefined;
}

export function formatSeedBundleForPrompt(seedBundle: FluxSeedBundle): string {
  const lines = [
    "Best known synthetic history and replay plan:",
    "",
    JSON.stringify(seedBundle, null, 2),
  ];
  return lines.join("\n");
}
