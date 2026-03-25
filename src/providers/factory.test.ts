import { describe, it, expect } from "bun:test";
import { createProvider } from "./factory.js";
import { MockProvider } from "./mock_provider.js";
import { CodexProvider } from "./codex_provider.js";
import { ClaudeProvider } from "./claude_provider.js";
import type { ProviderConfig } from "./types.js";
import { promptContentFromText } from "../utils/prompt_content.js";

describe("createProvider", () => {
  it("creates MockProvider when provider is mock", () => {
    const config: ProviderConfig = {
      provider: "mock",
      model: "test-model",
      workingDirectory: "/tmp",
    };
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(MockProvider);
  });

  it("creates CodexProvider when provider is codex", () => {
    const config: ProviderConfig = {
      provider: "codex",
      model: "gpt-5.3-codex",
      workingDirectory: "/tmp",
    };
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(CodexProvider);
  });

  it("creates ClaudeProvider when provider is claude", () => {
    const config: ProviderConfig = {
      provider: "claude",
      model: "claude-sonnet-4-5",
      workingDirectory: "/tmp",
    };
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(ClaudeProvider);
  });

  it("throws for unknown provider values", () => {
    const config: ProviderConfig = {
      provider: "unknown" as any,
      model: "gpt-4",
      workingDirectory: "/tmp",
    };
    expect(() => createProvider(config)).toThrow("unsupported provider");
  });

  it("passes config to MockProvider", async () => {
    const config: ProviderConfig = {
      provider: "mock",
      model: "custom-model",
      workingDirectory: "/custom/path",
      threadId: "preset_thread_123",
    };
    const provider = createProvider(config);
    const result = await provider.runOnce(promptContentFromText("test"));
    expect(result.text).toContain("custom-model");
    expect(result.threadId).toBe("preset_thread_123");
  });
});
