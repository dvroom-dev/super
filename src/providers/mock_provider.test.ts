import { describe, it, expect } from "bun:test";
import { MockProvider } from "./mock_provider.js";
import type { ProviderConfig, ProviderEvent } from "./types.js";
import { promptContentFromText } from "../utils/prompt_content.js";

describe("MockProvider", () => {
  const baseConfig: ProviderConfig = {
    provider: "mock",
    model: "test-model",
    workingDirectory: "/tmp",
  };

  describe("constructor", () => {
    it("creates provider with config", () => {
      const provider = new MockProvider(baseConfig);
      expect(provider).toBeDefined();
    });

    it("uses provided threadId if given", async () => {
      const config = { ...baseConfig, threadId: "existing_thread" };
      const provider = new MockProvider(config);
      const result = await provider.runOnce(promptContentFromText("test"));
      expect(result.threadId).toBe("existing_thread");
    });

    it("generates new threadId if not provided", async () => {
      const provider = new MockProvider(baseConfig);
      const result = await provider.runOnce(promptContentFromText("test"));
      expect(result.threadId).toMatch(/^mock_thread_/);
    });
  });

  describe("runOnce", () => {
    it("returns mock response with model name", async () => {
      const provider = new MockProvider(baseConfig);
      const result = await provider.runOnce(promptContentFromText("Hello"));
      expect(result.text).toContain("Mock response");
      expect(result.text).toContain("test-model");
      expect(result.text).toContain("Hello");
    });

    it("returns threadId", async () => {
      const provider = new MockProvider(baseConfig);
      const result = await provider.runOnce(promptContentFromText("test"));
      expect(result.threadId).toBeDefined();
    });

    it("returns empty items array", async () => {
      const provider = new MockProvider(baseConfig);
      const result = await provider.runOnce(promptContentFromText("test"));
      expect(result.items).toEqual([]);
    });

    it("includes prompt in response", async () => {
      const provider = new MockProvider(baseConfig);
      const result = await provider.runOnce(promptContentFromText("Custom prompt text"));
      expect(result.text).toContain("Custom prompt text");
    });

    it("supports runOnce text sequences for multi-attempt tests", async () => {
      process.env.MOCK_PROVIDER_RUNONCE_TEXT_SEQUENCE = JSON.stringify(["first", "second"]);
      try {
        const provider = new MockProvider(baseConfig);
        const result1 = await provider.runOnce(promptContentFromText("test-1"));
        const result2 = await provider.runOnce(promptContentFromText("test-2"));
        const result3 = await provider.runOnce(promptContentFromText("test-3"));
        expect(result1.text).toBe("first");
        expect(result2.text).toBe("second");
        expect(result3.text).toBe("second");
      } finally {
        delete process.env.MOCK_PROVIDER_RUNONCE_TEXT_SEQUENCE;
      }
    });
  });

  describe("runStreamed", () => {
    it("yields status event first", async () => {
      const provider = new MockProvider(baseConfig);
      const events: ProviderEvent[] = [];
      for await (const event of provider.runStreamed(promptContentFromText("test"))) {
        events.push(event);
      }
      expect(events[0].type).toBe("status");
      expect((events[0] as any).message).toContain("starting turn");
    });

    it("yields assistant_delta events", async () => {
      const provider = new MockProvider(baseConfig);
      const events: ProviderEvent[] = [];
      for await (const event of provider.runStreamed(promptContentFromText("test"))) {
        events.push(event);
      }
      const deltas = events.filter((e) => e.type === "assistant_delta");
      expect(deltas.length).toBeGreaterThan(0);
    });

    it("yields assistant_message event", async () => {
      const provider = new MockProvider(baseConfig);
      const events: ProviderEvent[] = [];
      for await (const event of provider.runStreamed(promptContentFromText("test"))) {
        events.push(event);
      }
      const messages = events.filter((e) => e.type === "assistant_message");
      expect(messages).toHaveLength(1);
      expect((messages[0] as any).text).toContain("Mock response");
    });

    it("yields done event last", async () => {
      const provider = new MockProvider(baseConfig);
      const events: ProviderEvent[] = [];
      for await (const event of provider.runStreamed(promptContentFromText("test"))) {
        events.push(event);
      }
      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe("done");
      expect((lastEvent as any).threadId).toBeDefined();
    });

    it("includes model in response", async () => {
      const config = { ...baseConfig, model: "custom-model-v2" };
      const provider = new MockProvider(config);
      const events: ProviderEvent[] = [];
      for await (const event of provider.runStreamed(promptContentFromText("test"))) {
        events.push(event);
      }
      const message = events.find((e) => e.type === "assistant_message") as any;
      expect(message.text).toContain("custom-model-v2");
    });

    it("includes partial prompt in full response", async () => {
      const provider = new MockProvider(baseConfig);
      const events: ProviderEvent[] = [];
      const longPrompt = "This is a very long prompt that should be truncated in the mock response";
      for await (const event of provider.runStreamed(promptContentFromText(longPrompt))) {
        events.push(event);
      }
      const message = events.find((e) => e.type === "assistant_message") as any;
      expect(message.text).toContain("This is a very long prompt");
    });
  });
});
