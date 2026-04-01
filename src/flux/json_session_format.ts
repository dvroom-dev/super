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
  if (name === "bootstrap_seed_decision_v1") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["decision", "summary", "seed_bundle_updated", "notes"],
      properties: {
        decision: { enum: ["continue_refining", "finalize_seed"] },
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

export function parseJsonObjectFromAssistantText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}
