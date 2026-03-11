import type { AgentProvider, ProviderConfig } from "./types.js";
import { ClaudeProvider } from "./claude_provider.js";
import { CodexProvider } from "./codex_provider.js";
import { GeminiProvider } from "./gemini_provider.js";
import { MockProvider } from "./mock_provider.js";

export function createProvider(config: ProviderConfig): AgentProvider {
  if (config.provider === "mock") return new MockProvider(config);
  if (config.provider === "claude") return new ClaudeProvider(config);
  if (config.provider === "gemini") return new GeminiProvider(config);
  if (config.provider === "codex") return new CodexProvider(config);
  throw new Error(`unsupported provider '${String((config as any).provider)}'`);
}
