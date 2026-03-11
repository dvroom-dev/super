import { describe, it, expect } from "bun:test";
import { diffLines, applyPatch } from "./patch.js";

function roundTrip(base: string, next: string) {
  const patch = diffLines(base, next);
  const rebuilt = applyPatch(base, patch);
  return { patch, rebuilt };
}

describe("patch", () => {
  it("round-trips identical text", () => {
    const base = "line one\nline two";
    const { rebuilt } = roundTrip(base, base);
    expect(rebuilt).toBe(base);
  });

  it("round-trips insertions", () => {
    const base = "alpha\nbeta";
    const next = "alpha\nINSERT\nbeta";
    const { rebuilt } = roundTrip(base, next);
    expect(rebuilt).toBe(next);
  });

  it("round-trips deletions", () => {
    const base = "alpha\nbeta\ngamma";
    const next = "alpha\ngamma";
    const { rebuilt } = roundTrip(base, next);
    expect(rebuilt).toBe(next);
  });

  it("round-trips replacements", () => {
    const base = "alpha\nbeta\ngamma";
    const next = "alpha\nBETA\ngamma";
    const { rebuilt } = roundTrip(base, next);
    expect(rebuilt).toBe(next);
  });
});
