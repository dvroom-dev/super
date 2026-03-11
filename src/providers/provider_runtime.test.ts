import { describe, expect, it } from "bun:test";
import { annotateErrorWithStderr, appendStderrTail, inheritedProcessEnv } from "./provider_runtime.js";

describe("provider runtime helpers", () => {
  it("inherits process env and applies overrides", () => {
    const previous = process.env.PROVIDER_RUNTIME_TEST_KEY;
    process.env.PROVIDER_RUNTIME_TEST_KEY = "from-process";
    try {
      const env = inheritedProcessEnv({ PROVIDER_RUNTIME_TEST_KEY: "from-config" });
      expect(env.PROVIDER_RUNTIME_TEST_KEY).toBe("from-config");
    } finally {
      if (previous === undefined) delete process.env.PROVIDER_RUNTIME_TEST_KEY;
      else process.env.PROVIDER_RUNTIME_TEST_KEY = previous;
    }
  });

  it("retains the most recent stderr tail", () => {
    const tail = appendStderrTail("abcdef", "ghijkl", 8);
    expect(tail).toBe("efghijkl");
  });

  it("adds stderr context to surfaced errors", () => {
    const error = annotateErrorWithStderr("app-server request timeout: turn/start", "fatal: auth missing");
    expect(error.message).toContain("app-server request timeout: turn/start");
    expect(error.message).toContain("app-server stderr:");
    expect(error.message).toContain("fatal: auth missing");
  });
});
