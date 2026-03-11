import { describe, expect, it } from "bun:test";
import { ClaudeProvider } from "./claude_provider.js";
import type { ProviderConfig } from "./types.js";
import { promptContentFromText } from "../utils/prompt_content.js";

type QueryInvocation = { prompt: string | AsyncIterable<any>; options?: Record<string, unknown> };

function makeQueryStub(capture: { invocation?: QueryInvocation }) {
  return (invocation: QueryInvocation) => {
    capture.invocation = invocation;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", result: "ok", session_id: "sess_env" };
      },
      close() {},
    };
  };
}

describe("ClaudeProvider env inheritance", () => {
  const baseConfig: ProviderConfig = {
    provider: "claude",
    model: "claude-sonnet-4-5-20250929",
    workingDirectory: "/tmp/work",
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
  };

  it("inherits process env when explicit provider env is omitted", async () => {
    const capture: { invocation?: QueryInvocation } = {};
    const previous = process.env.CLAUDE_PROVIDER_TEST_INHERITED;
    process.env.CLAUDE_PROVIDER_TEST_INHERITED = "expected";
    try {
      const provider = new ClaudeProvider(baseConfig, { query: makeQueryStub(capture) });
      await provider.runOnce(promptContentFromText("ping"));
      const options = (capture.invocation?.options ?? {}) as Record<string, any>;
      expect(options.env?.CLAUDE_PROVIDER_TEST_INHERITED).toBe("expected");
      expect(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PROVIDER_TEST_INHERITED;
      else process.env.CLAUDE_PROVIDER_TEST_INHERITED = previous;
    }
  });

  it("allows explicit provider env to override inherited values", async () => {
    const capture: { invocation?: QueryInvocation } = {};
    const previous = process.env.CLAUDE_PROVIDER_TEST_OVERRIDE;
    process.env.CLAUDE_PROVIDER_TEST_OVERRIDE = "from-process";
    try {
      const provider = new ClaudeProvider(
        {
          ...baseConfig,
          env: {
            CLAUDE_PROVIDER_TEST_OVERRIDE: "from-config",
          },
        },
        { query: makeQueryStub(capture) },
      );
      await provider.runOnce(promptContentFromText("ping"));
      const options = (capture.invocation?.options ?? {}) as Record<string, any>;
      expect(options.env?.CLAUDE_PROVIDER_TEST_OVERRIDE).toBe("from-config");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PROVIDER_TEST_OVERRIDE;
      else process.env.CLAUDE_PROVIDER_TEST_OVERRIDE = previous;
    }
  });
});
