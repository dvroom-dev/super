import type { AgentProvider, ProviderEvent, ProviderConfig } from "./types.js";
import { newId } from "../utils/ids.js";
import { promptContentToText, type PromptContent } from "../utils/prompt_content.js";

function readSequenceEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.map((entry) => String(entry ?? ""));
  } catch {
    return undefined;
  }
}

function matchPromptOverride(promptText: string): string | undefined {
  const raw = process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const contains = typeof (entry as any).contains === "string" ? String((entry as any).contains) : "";
      const text = typeof (entry as any).text === "string" ? String((entry as any).text) : "";
      if (contains && promptText.includes(contains)) return text;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class MockProvider implements AgentProvider {
  private config: ProviderConfig;
  private threadId: string;
  private runOnceCalls = 0;
  private runStreamedCalls = 0;
  private compactCalls = 0;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.threadId = config.threadId ?? newId("mock_thread");
  }

  async *runStreamed(prompt: PromptContent, options?: { outputSchema?: any; signal?: AbortSignal }): AsyncGenerator<ProviderEvent, void, void> {
    yield { type: "status", message: "mock: starting turn" };
    const threadScopedError = process.env.MOCK_PROVIDER_STREAMED_ERROR_IF_THREAD_ID_SET;
    if (typeof threadScopedError === "string" && threadScopedError.trim().length > 0 && this.config.threadId) {
      const err = new Error(threadScopedError) as Error & { name: string; threadId?: string; };
      err.name = "ProviderExecutionError";
      err.threadId = this.threadId;
      throw err;
    }
    const delayMs = Number(process.env.MOCK_PROVIDER_DELAY_MS ?? process.env.MOCK_PROVIDER_RUNONCE_DELAY_MS ?? 0);
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
    const streamedTextSequence = readSequenceEnv("MOCK_PROVIDER_RUNONCE_TEXT_SEQUENCE");
    const streamedErrorSequence = readSequenceEnv("MOCK_PROVIDER_STREAMED_ERROR_SEQUENCE")
      ?? readSequenceEnv("MOCK_PROVIDER_RUNONCE_ERROR_SEQUENCE");
    if (Array.isArray(streamedErrorSequence) && streamedErrorSequence.length > 0) {
      const idx = Math.min(this.runStreamedCalls, streamedErrorSequence.length - 1);
      const message = String(streamedErrorSequence[idx] ?? "").trim();
      this.runStreamedCalls += 1;
      if (message) {
        const err = new Error(message) as Error & { name: string; threadId?: string; };
        err.name = "ProviderExecutionError";
        err.threadId = this.threadId;
        throw err;
      }
    } else {
      this.runStreamedCalls += 1;
    }
    if (typeof process.env.MOCK_PROVIDER_RUNONCE_ERROR === "string") {
      const err = new Error(String(process.env.MOCK_PROVIDER_RUNONCE_ERROR)) as Error & { name: string; threadId?: string; };
      err.name = "ProviderExecutionError";
      err.threadId = this.threadId;
      throw err;
    }
    const sequenceIdx = Math.max(this.runStreamedCalls - 1, 0);
    const promptOverride = matchPromptOverride(promptText);
    const full =
      promptOverride
      ?? (Array.isArray(streamedTextSequence) && streamedTextSequence.length > 0
        ? String(streamedTextSequence[Math.min(sequenceIdx, streamedTextSequence.length - 1)] ?? "")
        : typeof process.env.MOCK_PROVIDER_STREAMED_TEXT === "string"
          ? String(process.env.MOCK_PROVIDER_STREAMED_TEXT)
          : typeof process.env.MOCK_PROVIDER_RUNONCE_TEXT === "string"
            ? String(process.env.MOCK_PROVIDER_RUNONCE_TEXT)
            : `Mock response for model=${this.config.model}. You said: ${promptEcho}`);
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
    if (process.env.MOCK_PROVIDER_RUNONCE_EMPTY === "1" || process.env.MOCK_PROVIDER_SKIP_ASSISTANT_MESSAGE === "1") {
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
    yield { type: "done", finalText: full, threadId: this.threadId };
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
    const runOnceErrorSequence = readSequenceEnv("MOCK_PROVIDER_RUNONCE_ERROR_SEQUENCE");
    if (Array.isArray(runOnceErrorSequence) && runOnceErrorSequence.length > 0) {
      const idx = Math.min(this.runOnceCalls, runOnceErrorSequence.length - 1);
      const message = String(runOnceErrorSequence[idx] ?? "").trim();
      if (message) {
        this.runOnceCalls += 1;
        const err = new Error(message) as Error & {
          name: string;
          threadId?: string;
        };
        err.name = "ProviderExecutionError";
        err.threadId = this.threadId;
        throw err;
      }
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

  async compactThread(_options?: { signal?: AbortSignal; reason?: string }): Promise<{ compacted: boolean; threadId?: string; details?: string }> {
    this.compactCalls += 1;
    const compactSequence = readSequenceEnv("MOCK_PROVIDER_COMPACT_RESULT_SEQUENCE");
    const compactResult = Array.isArray(compactSequence) && compactSequence.length > 0
      ? String(compactSequence[Math.min(this.compactCalls - 1, compactSequence.length - 1)] ?? "").trim()
      : (process.env.MOCK_PROVIDER_COMPACT_RESULT ?? "compacted").trim();
    if (!compactResult || compactResult.toLowerCase() === "false" || compactResult.toLowerCase() === "no") {
      return { compacted: false, threadId: this.threadId, details: "mock compact disabled" };
    }
    const compactedThreadId = String(
      process.env.MOCK_PROVIDER_COMPACTED_THREAD_ID
        ?? `${this.threadId}_compacted_${this.compactCalls}`,
    ).trim();
    if (compactedThreadId) {
      this.threadId = compactedThreadId;
      this.config.threadId = compactedThreadId;
    }
    return { compacted: true, threadId: this.threadId, details: compactResult };
  }
}
