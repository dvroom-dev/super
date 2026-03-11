import { describe, expect, it } from "bun:test";
import { selectBaseForkId } from "./common.js";

describe("selectBaseForkId", () => {
  it("prefers explicit base fork id", () => {
    const selected = selectBaseForkId({
      explicitBaseForkId: "fork_explicit",
      docForkId: "fork_doc",
      indexHeadId: "fork_head",
      knownForkIds: ["fork_doc", "fork_head"],
    });
    expect(selected).toBe("fork_explicit");
  });

  it("uses doc fork id when it exists in index", () => {
    const selected = selectBaseForkId({
      docForkId: "fork_doc",
      indexHeadId: "fork_head",
      knownForkIds: ["fork_doc", "fork_head"],
    });
    expect(selected).toBe("fork_doc");
  });

  it("falls back to index head when doc fork id is stale", () => {
    const selected = selectBaseForkId({
      docForkId: "fork_stale",
      indexHeadId: "fork_head",
      knownForkIds: ["fork_head"],
    });
    expect(selected).toBe("fork_head");
  });

  it("returns undefined when no base fork can be resolved", () => {
    const selected = selectBaseForkId({
      docForkId: "fork_unknown",
      knownForkIds: [],
    });
    expect(selected).toBeUndefined();
  });
});
