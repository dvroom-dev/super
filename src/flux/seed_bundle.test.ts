import { describe, expect, test } from "bun:test";
import { validateFluxSeedBundle } from "./seed_bundle.js";

function baseSeed() {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    syntheticMessages: [{ role: "assistant", text: "seed message" }],
    replayPlan: [] as Array<Record<string, unknown>>,
    assertions: [],
  };
}

describe("validateFluxSeedBundle", () => {
  test("accepts gameplay-relative read_file paths", () => {
    const seed = baseSeed();
    seed.replayPlan.push({ tool: "read_file", args: { path: "agent/game_ls20/level_1/sequences/seq_0001.json" } });
    expect(validateFluxSeedBundle(seed).replayPlan).toHaveLength(1);
  });

  test("rejects flux bookkeeping paths in replay steps", () => {
    const seed = baseSeed();
    seed.replayPlan.push({ tool: "read_file", args: { path: "flux/seed/current_meta.json" } });
    expect(() => validateFluxSeedBundle(seed)).toThrow(/solver\/game workspace artifacts/);
  });

  test("rejects malformed shell replay steps", () => {
    const seed = baseSeed();
    seed.replayPlan.push({ tool: "shell", args: { command: "echo hi" } });
    expect(() => validateFluxSeedBundle(seed)).toThrow(/args\.cmd must be a non-empty string array/);
  });

  test("rejects parent traversal in replay paths", () => {
    const seed = baseSeed();
    seed.replayPlan.push({ tool: "write_file", args: { path: "../outside.txt", content: "x" } });
    expect(() => validateFluxSeedBundle(seed)).toThrow(/must not escape the game workspace/);
  });
});
