import { describe, it, expect } from "bun:test";
import { sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("generates consistent hash for same input", () => {
    const hash1 = sha256Hex("hello");
    const hash2 = sha256Hex("hello");
    expect(hash1).toBe(hash2);
  });

  it("generates different hash for different input", () => {
    const hash1 = sha256Hex("hello");
    const hash2 = sha256Hex("world");
    expect(hash1).not.toBe(hash2);
  });

  it("returns 64-character hex string", () => {
    const hash = sha256Hex("test");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("handles empty string", () => {
    const hash = sha256Hex("");
    expect(hash).toHaveLength(64);
    // Known SHA-256 of empty string
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("handles unicode input", () => {
    const hash = sha256Hex("Hello, \u4e16\u754c!");
    expect(hash).toHaveLength(64);
  });

  it("handles multiline input", () => {
    const hash = sha256Hex("line1\nline2\nline3");
    expect(hash).toHaveLength(64);
  });
});
