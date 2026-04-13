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
      required: ["decision", "summary", "seed_bundle_updated", "notes", "solver_action", "seed_delta_kind"],
      properties: {
        decision: { enum: ["continue_refining", "finalize_seed"] },
        summary: { type: "string" },
        seed_bundle_updated: { type: "boolean" },
        notes: { type: "string" },
        solver_action: { enum: ["no_action", "queue_without_interrupt", "queue_and_interrupt"] },
        seed_delta_kind: { type: "string" },
      },
    };
  }
  if (name === "model_box_labels_v1") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["level", "summary", "boxes"],
      properties: {
        level: { type: "integer", minimum: 1 },
        summary: { type: "string" },
        boxes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["box_id", "features", "tags"],
            properties: {
              box_id: { type: "string" },
              features: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
              tags: {
                type: "array",
                minItems: 1,
                items: {
                  enum: ["stable", "movable", "transient", "ui_like", "unknown"],
                },
              },
              notes: { type: "string" },
            },
          },
        },
      },
    };
  }
  return undefined;
}

export function formatSeedBundleForPrompt(seedBundle: FluxSeedBundle): string {
  const replayActions = seedBundle.replayPlan
    .map((step) => {
      const cmd = step.tool === "shell" && Array.isArray(step.args?.cmd)
        ? (step.args.cmd as unknown[]).filter((item): item is string => typeof item === "string")
        : [];
      if (cmd[0] === "arc_action" && cmd[1]) return cmd[1];
      return step.tool;
    })
    .filter(Boolean);
  const lines = ["Best known seed context:"];
  if (seedBundle.syntheticMessages.length > 0) {
    lines.push("- Synthetic transcript to inherit:");
    for (const message of seedBundle.syntheticMessages) {
      const role = String(message.role ?? "assistant").toUpperCase();
      lines.push(`  - ${role}: ${String(message.text ?? "").trim()}`);
    }
  }
  if (replayActions.length > 0) {
    lines.push(`- Replay actions: ${replayActions.join(" ")}`);
  }
  if (Array.isArray(seedBundle.assertions) && seedBundle.assertions.length > 0) {
    lines.push("- Assertions:");
    for (const assertion of seedBundle.assertions) {
      if (typeof assertion === "string") {
        lines.push(`  - ${assertion}`);
      } else {
        lines.push(`  - ${JSON.stringify(assertion)}`);
      }
    }
  }
  if (seedBundle.metadata) {
    lines.push(`- Seed metadata: ${JSON.stringify(seedBundle.metadata)}`);
  }
  return lines.join("\n");
}

function findLatestEvidenceState(payload: Record<string, unknown>): Record<string, unknown> | null {
  const evidence = payload.evidence;
  if (!Array.isArray(evidence)) return null;
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const item = evidence[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const state = (item as Record<string, unknown>).state;
    if (state && typeof state === "object" && !Array.isArray(state)) {
      return state as Record<string, unknown>;
    }
  }
  return null;
}

function summarizeComparePayload(comparePayload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const level = Number(comparePayload.level ?? 0) || 0;
  const allMatch = comparePayload.all_match === true;
  const error = comparePayload.error;
  if (allMatch) {
    lines.push(`- Model compare: clean at level ${level || "unknown"}.`);
    return lines;
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "compare_error";
    const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
    lines.push(`- Model compare: ${type} at level ${level || "unknown"}: ${message}`);
    return lines;
  }
  const diverged = Number(comparePayload.diverged_sequences ?? 0) || 0;
  const compared = Number(comparePayload.compared_sequences ?? 0) || 0;
  lines.push(`- Model compare: ${diverged} diverged of ${compared} compared at level ${level || "unknown"}.`);
  return lines;
}

export function formatSeedReplayResultForPrompt(payload: Record<string, unknown>): string {
  const lines = ["Seed preplay already ran on this instance."];
  const replayOk = payload.replay_ok;
  if (typeof replayOk === "boolean") {
    lines.push(`- Replay status: ${replayOk ? "ok" : "failed"}`);
  }
  const latestState = findLatestEvidenceState(payload);
  if (latestState) {
    const currentLevel = Number(latestState.current_level ?? 0) || 0;
    const levelsCompleted = Number(latestState.levels_completed ?? 0) || 0;
    const totalSteps = Number(latestState.total_steps ?? latestState.current_attempt_steps ?? 0) || 0;
    const lastActionName = typeof latestState.last_action_name === "string"
      ? latestState.last_action_name
      : typeof latestState.action_input_name === "string"
        ? latestState.action_input_name
        : typeof latestState.last_action === "string"
          ? latestState.last_action
          : "unknown";
    const stateName = typeof latestState.state === "string" ? latestState.state : "UNKNOWN";
    lines.push(
      `- Current live state after preplay: level ${currentLevel || "unknown"}, completed ${levelsCompleted}, state ${stateName}, total steps ${totalSteps}, last action ${lastActionName}.`,
    );
  }
  const comparePayload = payload.compare_payload;
  if (comparePayload && typeof comparePayload === "object" && !Array.isArray(comparePayload)) {
    lines.push(...summarizeComparePayload(comparePayload as Record<string, unknown>));
  }
  const error = payload.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    lines.push(`- Replay error: ${JSON.stringify(error)}`);
  }
  return lines.join("\n");
}

export function formatEvidenceForPrompt(evidenceRecord: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof evidenceRecord.summary === "string" && evidenceRecord.summary.trim()) {
    lines.push(`- Summary: ${evidenceRecord.summary.trim()}`);
  }
  const state = evidenceRecord.state;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const record = state as Record<string, unknown>;
    const currentLevel = Number(record.current_level ?? 0) || 0;
    const levelsCompleted = Number(record.levels_completed ?? 0) || 0;
    const stateName = typeof record.state === "string" ? record.state : "UNKNOWN";
    const totalSteps = Number(record.total_steps ?? 0) || 0;
    const currentAttemptSteps = Number(record.current_attempt_steps ?? 0) || 0;
    const lastActionName = typeof record.last_action_name === "string"
      ? record.last_action_name
      : typeof record.action_input_name === "string"
        ? record.action_input_name
        : typeof record.last_action === "string"
          ? record.last_action
          : "unknown";
    lines.push(
      `- State: level ${currentLevel || "unknown"}, completed ${levelsCompleted}, status ${stateName}, total steps ${totalSteps}, steps since latest restart ${currentAttemptSteps}, last action ${lastActionName}.`,
    );
    const availableActions = Array.isArray(record.available_actions)
      ? record.available_actions.map((item) => String(item)).join(", ")
      : "";
    if (availableActions) {
      lines.push(`- Available actions: ${availableActions}`);
    }
  }
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
