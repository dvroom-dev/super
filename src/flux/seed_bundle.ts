import type { FluxSeedBundle } from "./types.js";

function describe(index: number, field: string): string {
  return `syntheticMessages[${index}].${field}`;
}

function validateReplayPath(index: number, tool: string, pathText: unknown): void {
  if (typeof pathText !== "string" || pathText.trim().length === 0) {
    throw new Error(`seed bundle replayPlan[${index}].args.path must be a non-empty string for ${tool}`);
  }
  const normalized = pathText.trim();
  if (normalized.startsWith("/") || normalized.match(/^[A-Za-z]:[\\/]/)) {
    throw new Error(`seed bundle replayPlan[${index}].args.path must be relative, got ${JSON.stringify(pathText)}`);
  }
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) {
    throw new Error(`seed bundle replayPlan[${index}].args.path must not be empty`);
  }
  if (parts.includes("..")) {
    throw new Error(`seed bundle replayPlan[${index}].args.path must not escape the game workspace`);
  }
  const forbiddenRoots = new Set(["flux", ".ai-flux", "config", "prompts", "scripts", ".ctxs", "runs"]);
  if (forbiddenRoots.has(parts[0]!)) {
    throw new Error(
      `seed bundle replayPlan[${index}].args.path must target solver/game workspace artifacts, not ${JSON.stringify(parts[0])}`,
    );
  }
  if (parts.includes("sequences") || parts.includes("sequence_compare")) {
    throw new Error(
      `seed bundle replayPlan[${index}].args.path must not target generated sequence artifacts; carry that evidence in seed messages instead`,
    );
  }
  const basename = parts[parts.length - 1]!;
  if (basename === "current_compare.json" || basename === "current_compare.md" || basename === "current_meta.json") {
    throw new Error(
      `seed bundle replayPlan[${index}].args.path must not target generated compare/meta artifacts; carry that evidence in seed messages instead`,
    );
  }
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
    const tool = replayStep.tool.trim();
    if (tool !== "shell" && tool !== "read_file" && tool !== "write_file") {
      throw new Error(`seed bundle replayPlan[${index}].tool must be shell, read_file, or write_file`);
    }
    if (!replayStep.args || typeof replayStep.args !== "object" || Array.isArray(replayStep.args)) {
      throw new Error(`seed bundle replayPlan[${index}].args must be an object`);
    }
    const args = replayStep.args as Record<string, unknown>;
    if (tool === "shell") {
      const cmd = args.cmd;
      if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((item) => typeof item !== "string" || item.length === 0)) {
        throw new Error(`seed bundle replayPlan[${index}].args.cmd must be a non-empty string array for shell`);
      }
    }
    if (tool === "read_file" || tool === "write_file") {
      validateReplayPath(index, tool, args.path);
    }
  });
  return record as unknown as FluxSeedBundle;
}
