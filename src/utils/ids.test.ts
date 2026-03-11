import { describe, it, expect } from "bun:test";
import { newId } from "./ids.js";

describe("newId", () => {
  it("generates id with correct prefix", () => {
    const id = newId("test");
    expect(id.startsWith("test_")).toBe(true);
  });

  it("generates unique ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(newId("unique"));
    }
    expect(ids.size).toBe(100);
  });

  it("uses different prefixes correctly", () => {
    const forkId = newId("fork");
    const threadId = newId("thread");
    const msgId = newId("msg");

    expect(forkId.startsWith("fork_")).toBe(true);
    expect(threadId.startsWith("thread_")).toBe(true);
    expect(msgId.startsWith("msg_")).toBe(true);
  });

  it("generates valid UUID format after prefix", () => {
    const id = newId("test");
    const uuidPart = id.slice(5); // Remove "test_"
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(uuidPart).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("handles empty prefix", () => {
    const id = newId("");
    expect(id.startsWith("_")).toBe(true);
  });

  it("handles prefix with special characters", () => {
    const id = newId("test-item");
    expect(id.startsWith("test-item_")).toBe(true);
  });
});
