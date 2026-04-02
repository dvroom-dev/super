import type { FluxSeedBundle } from "./types.js";

function describe(index: number, field: string): string {
  return `syntheticMessages[${index}].${field}`;
}

export function validateFluxSeedBundle(seedBundle: unknown): FluxSeedBundle {
  if (!seedBundle || typeof seedBundle !== "object" || Array.isArray(seedBundle)) {
    throw new Error("seed bundle must be an object");
  }
  const record = seedBundle as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`seed bundle version must be 1, got ${JSON.stringify(record.version)}`);
  }
  if (typeof record.generatedAt !== "string" || record.generatedAt.trim().length === 0) {
    throw new Error("seed bundle generatedAt must be a non-empty string");
  }
  if (!Array.isArray(record.syntheticMessages)) {
    throw new Error("seed bundle syntheticMessages must be an array");
  }
  if (!Array.isArray(record.replayPlan)) {
    throw new Error("seed bundle replayPlan must be an array");
  }
  if (!Array.isArray(record.assertions)) {
    throw new Error("seed bundle assertions must be an array");
  }
  record.syntheticMessages.forEach((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error(`seed bundle ${describe(index, "")} must be an object`);
    }
    const msg = message as Record<string, unknown>;
    const role = msg.role;
    if (role !== "assistant" && role !== "user") {
      throw new Error(`seed bundle ${describe(index, "role")} must be "assistant" or "user", got ${JSON.stringify(role)}`);
    }
    if (typeof msg.text !== "string" || msg.text.trim().length === 0) {
      throw new Error(`seed bundle ${describe(index, "text")} must be a non-empty string`);
    }
    if ("content" in msg) {
      throw new Error(`seed bundle ${describe(index, "content")} is not allowed; use ${describe(index, "text")}`);
    }
  });
  record.replayPlan.forEach((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`seed bundle replayPlan[${index}] must be an object`);
    }
    const replayStep = step as Record<string, unknown>;
    if (typeof replayStep.tool !== "string" || replayStep.tool.trim().length === 0) {
      throw new Error(`seed bundle replayPlan[${index}].tool must be a non-empty string`);
    }
    if (!replayStep.args || typeof replayStep.args !== "object" || Array.isArray(replayStep.args)) {
      throw new Error(`seed bundle replayPlan[${index}].args must be an object`);
    }
  });
  return record as unknown as FluxSeedBundle;
}
