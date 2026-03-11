import type { AgentProvider, ProviderEvent, ProviderConfig } from "./types.js";
import { newId } from "../utils/ids.js";
import { promptContentToText, type PromptContent } from "../utils/prompt_content.js";

export class MockProvider implements AgentProvider {
  private config: ProviderConfig;
  private threadId: string;
  private runOnceCalls = 0;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.threadId = config.threadId ?? newId("mock_thread");
  }

  async *runStreamed(prompt: PromptContent, options?: { outputSchema?: any; signal?: AbortSignal }): AsyncGenerator<ProviderEvent, void, void> {
    yield { type: "status", message: "mock: starting turn" };
    const delayMs = Number(process.env.MOCK_PROVIDER_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          if (options?.signal) options.signal.removeEventListener("abort", onAbort);
          clearTimeout(timer);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          const err = new Error("Aborted");
          (err as any).name = "AbortError";
          reject(err);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }, Math.floor(delayMs));
        if (options?.signal) {
          if (options.signal.aborted) {
            onAbort();
            return;
          }
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    const promptText = promptContentToText(prompt);
    const promptEcho =
      process.env.MOCK_PROVIDER_ECHO_PROMPT_TAIL === "1" ? promptText.slice(-240) : promptText.slice(0, 120);
    const full =
      typeof process.env.MOCK_PROVIDER_STREAMED_TEXT === "string"
        ? String(process.env.MOCK_PROVIDER_STREAMED_TEXT)
        : `Mock response for model=${this.config.model}. You said: ${promptEcho}`;
    if (process.env.MOCK_PROVIDER_SKIP_DELTAS !== "1") {
      for (const chunk of ["Mock response", " for model=", this.config.model, ". ", "You said: "]) {
        yield { type: "assistant_delta", delta: chunk };
      }
    }
    if (typeof process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON === "string") {
      try {
        const injected = JSON.parse(process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON);
        if (Array.isArray(injected)) {
          for (const entry of injected) {
            const event = entry as ProviderEvent;
            if (event && typeof event === "object" && typeof (event as any).type === "string") {
              yield event;
            }
          }
        }
      } catch {
        // ignore malformed test-only injection
      }
    }
    if (process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE === "1") {
      yield { type: "done", finalText: undefined, threadId: this.threadId };
      return;
    }
    yield { type: "assistant_message", text: full };
    if (process.env.MOCK_PROVIDER_EMIT_USAGE === "1") {
      const inputTokens = Number(process.env.MOCK_PROVIDER_INPUT_TOKENS ?? 120);
      const cachedInputTokens = Number(process.env.MOCK_PROVIDER_CACHED_INPUT_TOKENS ?? 40);
      const outputTokens = Number(process.env.MOCK_PROVIDER_OUTPUT_TOKENS ?? 32);
      yield {
        type: "usage",
        usage: {
          input_tokens: Number.isFinite(inputTokens) ? inputTokens : 120,
          cached_input_tokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : 40,
          output_tokens: Number.isFinite(outputTokens) ? outputTokens : 32,
        },
      };
    }
    yield { type: "done", finalText: `Mock response for model=${this.config.model}.`, threadId: this.threadId };
  }

  async runOnce(
    prompt: PromptContent,
    options?: { outputSchema?: any; signal?: AbortSignal },
  ): Promise<{ text: string; threadId?: string; items?: any[] }> {
    const delayMs = Number(process.env.MOCK_PROVIDER_RUNONCE_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          if (options?.signal) options.signal.removeEventListener("abort", onAbort);
          clearTimeout(timer);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          const err = new Error("Aborted");
          (err as any).name = "AbortError";
          reject(err);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }, Math.floor(delayMs));
        if (options?.signal) {
          if (options.signal.aborted) {
            onAbort();
            return;
          }
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    if (typeof process.env.MOCK_PROVIDER_RUNONCE_ERROR === "string") {
      const err = new Error(String(process.env.MOCK_PROVIDER_RUNONCE_ERROR)) as Error & {
        name: string;
        threadId?: string;
      };
      err.name = "ProviderExecutionError";
      err.threadId = this.threadId;
      throw err;
    }
    if (process.env.MOCK_PROVIDER_RUNONCE_EMPTY === "1") {
      return { text: "", threadId: this.threadId, items: [] };
    }
    if (typeof process.env.MOCK_PROVIDER_RUNONCE_TEXT_SEQUENCE === "string") {
      try {
        const sequence = JSON.parse(process.env.MOCK_PROVIDER_RUNONCE_TEXT_SEQUENCE);
        if (Array.isArray(sequence) && sequence.length > 0) {
          const idx = Math.min(this.runOnceCalls, sequence.length - 1);
          this.runOnceCalls += 1;
          return { text: String(sequence[idx] ?? ""), threadId: this.threadId, items: [] };
        }
      } catch {
        // ignore malformed test-only override
      }
    }
    if (typeof process.env.MOCK_PROVIDER_RUNONCE_TEXT === "string") {
      return { text: String(process.env.MOCK_PROVIDER_RUNONCE_TEXT), threadId: this.threadId, items: [] };
    }
    const promptText = promptContentToText(prompt);
    return { text: `Mock response for model=${this.config.model}. Prompt: ${promptText}`, threadId: this.threadId, items: [] };
  }
}
