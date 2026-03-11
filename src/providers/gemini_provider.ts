import { spawn, type SpawnOptions } from "node:child_process";
import readline from "node:readline";
import type { AgentProvider, NormalizedProviderItem, ProviderConfig, ProviderEvent } from "./types.js";
import type { PromptContent } from "../utils/prompt_content.js";

type GeminiSpawnedProcess = {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: (event: "error", listener: (error: Error) => void) => void;
  off: (event: "error", listener: (error: Error) => void) => void;
  once: (event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
};

type GeminiSpawnFn = (command: string, args: string[], options: SpawnOptions) => GeminiSpawnedProcess;
type GeminiProviderDeps = { spawn?: GeminiSpawnFn };
const DEFAULT_GEMINI_SAFE_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "LS",
];

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function isStrictProfile(config: ProviderConfig): boolean {
  return config.permissionProfile !== "yolo";
}

function looksLikeNetworkTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("web")) return true;
  if (normalized.includes("browser")) return true;
  if (normalized.includes("fetch")) return true;
  if (normalized.includes("http")) return true;
  if (normalized.includes("search")) return true;
  return false;
}

function toPlainPrompt(prompt: PromptContent): string {
  const parts: string[] = [];
  for (const part of prompt) {
    if (part.type === "text") {
      parts.push(part.text);
      continue;
    }
    // Gemini CLI supports local multimodal references via @path in prompts.
    const escapedPath = part.path.replace(/\\/g, "\\\\").replace(/ /g, "\\ ");
    parts.push(`\n@${escapedPath}\n`);
  }
  return parts.join("");
}

function buildSchemaPrompt(basePrompt: string, outputSchema: unknown): string {
  const schema = JSON.stringify(outputSchema ?? {}, null, 2);
  return [
    "Return ONLY one JSON object that matches this JSON Schema.",
    "Do not include markdown, prose, or extra keys.",
    "JSON Schema:",
    "```json",
    schema,
    "```",
    "",
    "User prompt:",
    basePrompt,
  ].join("\n");
}

function tryParseJsonObject(source: string): Record<string, unknown> | undefined {
  const text = source.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // continue with embedded-object scan
  }
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        continue;
      }
      if (ch !== "}") continue;
      depth -= 1;
      if (depth !== 0) continue;
      const candidate = text.slice(start, i + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        break;
      }
      break;
    }
  }
  return undefined;
}

function normalizeSchemaConstrainedText(text: string): string | undefined {
  const parsed = tryParseJsonObject(text);
  if (parsed) return JSON.stringify(parsed);
  const trimmed = text.trim();
  return trimmed || undefined;
}

function toolCallItem(event: any): NormalizedProviderItem {
  const name = asString(event?.tool_name) ?? "tool";
  const id = asString(event?.tool_id);
  const parameters = event?.parameters && typeof event.parameters === "object" ? event.parameters : undefined;
  const parameterKeys = parameters ? Object.keys(parameters as Record<string, unknown>).slice(0, 20) : undefined;
  return {
    id,
    provider: "gemini",
    kind: "tool_call",
    type: "assistant.tool_use",
    name,
    status: "emitted",
    summary: `tool_call ${name}`,
    details: parameterKeys ? { parameter_keys: parameterKeys } : undefined,
    includeInTranscript: true,
  };
}

function toolResultItem(event: any): NormalizedProviderItem {
  const id = asString(event?.tool_id);
  const statusRaw = asString(event?.status) ?? "success";
  const isError = statusRaw.toLowerCase() === "error" || Boolean(event?.error);
  const output = asString(event?.output);
  const error = event?.error && typeof event.error === "object" ? event.error : undefined;
  const errorType = asString((error as any)?.type);
  const errorMessage = asString((error as any)?.message);
  return {
    id,
    provider: "gemini",
    kind: isError ? "tool_error" : "tool_result",
    type: "tool_result",
    name: "tool_result",
    status: isError ? "error" : "completed",
    summary: isError ? "tool_error" : "tool_result",
    text: errorMessage ?? output,
    details: {
      tool_id: id,
      status: statusRaw,
      error_type: errorType,
    },
    includeInTranscript: true,
  };
}

function usageFromResultEvent(event: any): Record<string, number> | undefined {
  const stats = event?.stats;
  if (!stats || typeof stats !== "object") return undefined;
  const inputTokens = asNumber((stats as any).input_tokens ?? (stats as any).input);
  const outputTokens = asNumber((stats as any).output_tokens);
  const cachedInputTokens = asNumber((stats as any).cached);
  const totalTokens = asNumber((stats as any).total_tokens) ?? (
    inputTokens != null && outputTokens != null ? inputTokens + outputTokens : undefined
  );
  const usage: Record<string, number> = {};
  if (inputTokens != null) usage.input_tokens = Math.max(0, Math.floor(inputTokens));
  if (outputTokens != null) usage.output_tokens = Math.max(0, Math.floor(outputTokens));
  if (cachedInputTokens != null) usage.cached_input_tokens = Math.max(0, Math.floor(cachedInputTokens));
  if (totalTokens != null) usage.total_tokens = Math.max(0, Math.floor(totalTokens));
  return Object.keys(usage).length ? usage : undefined;
}

function tail(text: string, max = 400): string {
  if (text.length <= max) return text.trim();
  return text.slice(text.length - max).trim();
}

function isSpawnFailureError(error: unknown): error is { code?: string; syscall?: string; message?: string; path?: string } {
  if (!error || typeof error !== "object") return false;
  const err = error as Record<string, unknown>;
  const code = typeof err.code === "string" ? err.code : "";
  const syscall = typeof err.syscall === "string" ? err.syscall : "";
  return Boolean(code) && syscall.toLowerCase().includes("spawn");
}

function formatSpawnFailure(command: string, error: { code?: string; syscall?: string; message?: string; path?: string }): string {
  const pathText = asString(error.path) ?? command;
  const code = asString(error.code)?.toUpperCase();
  if (code === "ENOENT") {
    return `failed to start gemini command '${pathText}' (not found)`;
  }
  const firstLine = String(error.message ?? "spawn failed").split(/\r?\n/, 1)[0]?.trim() || "spawn failed";
  return `failed to start gemini command '${pathText}': ${firstLine}`;
}

export class GeminiProvider implements AgentProvider {
  private config: ProviderConfig;
  private deps?: GeminiProviderDeps;

  constructor(config: ProviderConfig, deps?: GeminiProviderDeps) {
    this.config = config;
    this.deps = deps;
  }

  private spawnGemini(promptText: string, signal?: AbortSignal): {
    child: GeminiSpawnedProcess;
    stop: () => void;
  } {
    const providerOptions = this.config.providerOptions ?? {};
    const command = asString(providerOptions.command) ?? "gemini";
    const extraArgs = Array.isArray(providerOptions.args)
      ? providerOptions.args.map((value) => String(value))
      : [];
    const strictProfile = isStrictProfile(this.config);
    const configuredAllowedTools = asStringArray(providerOptions.allowedTools);
    const defaultAllowedTools = strictProfile ? DEFAULT_GEMINI_SAFE_ALLOWED_TOOLS : [];
    const allowedTools = (configuredAllowedTools.length > 0 ? configuredAllowedTools : defaultAllowedTools)
      .filter((name) => !strictProfile || !looksLikeNetworkTool(name));
    const disallowedTools = asStringArray(providerOptions.disallowedTools);
    if (disallowedTools.length > 0) {
      throw new Error("gemini provider does not support disallowedTools; use allowedTools");
    }
    const args = [...extraArgs];
    if (this.config.threadId) {
      args.push("--resume", this.config.threadId);
    }
    if (this.config.model) {
      args.push("--model", this.config.model);
    }
    const sandboxMode = this.config.sandboxMode ?? "workspace-write";
    const useSandbox = sandboxMode !== "danger-full-access";
    if (useSandbox) {
      args.push("--sandbox");
    }
    if (this.config.approvalPolicy === "never") {
      if (sandboxMode === "read-only") {
        args.push("--approval-mode", "plan");
      } else {
        args.push("--approval-mode", "yolo");
      }
    }
    for (const toolName of allowedTools) {
      args.push("--allowed-tools", toolName);
    }
    args.push("--output-format", "stream-json", "--prompt", promptText);
    const env: Record<string, string> = {
      ...Object.entries(process.env).reduce<Record<string, string>>((acc, [key, value]) => {
        if (typeof value === "string") acc[key] = value;
        return acc;
      }, {}),
      ...(this.config.env ?? {}),
    };
    const geminiHome = asString(providerOptions.home);
    if (geminiHome) env.GEMINI_CLI_HOME = geminiHome;
    const spawnFn = this.deps?.spawn ?? ((cmd, spawnArgs, options) => spawn(cmd, spawnArgs, options) as unknown as GeminiSpawnedProcess);
    const child = spawnFn(command, args, {
      cwd: this.config.workingDirectory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore kill failures
      }
    };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }
    return { child, stop };
  }

  async *runStreamed(
    prompt: PromptContent,
    options?: { outputSchema?: any; signal?: AbortSignal },
  ): AsyncGenerator<ProviderEvent, void, void> {
    const schemaConstrained = Boolean(options?.outputSchema);
    const basePrompt = toPlainPrompt(prompt);
    const promptText = schemaConstrained ? buildSchemaPrompt(basePrompt, options?.outputSchema) : basePrompt;
    yield { type: "status", message: "gemini: starting turn" };
    let child: GeminiSpawnedProcess;
    let stop: () => void;
    try {
      const spawned = this.spawnGemini(promptText, options?.signal);
      child = spawned.child;
      stop = spawned.stop;
    } catch (error: any) {
      if (!isSpawnFailureError(error)) throw error;
      yield { type: "status", message: `gemini error: ${formatSpawnFailure("gemini", error)}` };
      yield { type: "done", finalText: undefined, threadId: this.config.threadId };
      return;
    }
    const stderrChunks: string[] = [];
    const command = asString((this.config.providerOptions ?? {}).command) ?? "gemini";
    let spawnRuntimeError: Error | null = null;
    let closeResolved = false;
    let resolveClose: (() => void) | undefined;
    let rl: readline.Interface | null = null;
    const onStderrData = (chunk: unknown) => {
      const text = chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk ?? "");
      if (text.trim()) stderrChunks.push(text);
    };
    const onProcessError = (error: Error) => {
      spawnRuntimeError = error;
      try {
        rl?.close();
      } catch {
        // ignore readline close failures
      }
      try {
        (child.stdout as any)?.destroy?.();
      } catch {
        // ignore stream destroy failures
      }
      try {
        (child.stderr as any)?.destroy?.();
      } catch {
        // ignore stream destroy failures
      }
      stop();
      resolveClose?.();
    };
    child.stderr.on("data", onStderrData);
    child.on("error", onProcessError);

    let threadId: string | undefined = this.config.threadId;
    let assistantText = "";
    let finalText: string | undefined;
    let emittedAssistant = false;
    let closeCode: number | null = null;
    const closePromise = new Promise<void>((resolve) => {
      const finishClose = () => {
        if (closeResolved) return;
        closeResolved = true;
        resolve();
      };
      resolveClose = finishClose;
      child.once("close", (code) => {
        closeCode = code;
        finishClose();
      });
    });

    rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const lineRaw of rl) {
        const line = lineRaw.trim();
        if (!line) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          yield { type: "status", message: `gemini: ${line}` };
          continue;
        }

        if (event && typeof event.session_id === "string") threadId = event.session_id;
        const type = asString(event?.type) ?? "event";

        if (type === "message") {
          const role = asString(event?.role)?.toLowerCase();
          const content = typeof event?.content === "string" ? event.content : undefined;
          if (role === "assistant" && content) {
            const delta = Boolean(event?.delta);
            if (delta) {
              assistantText += content;
              if (!schemaConstrained) yield { type: "assistant_delta", delta: content };
            } else {
              assistantText = content;
              if (!schemaConstrained) {
                emittedAssistant = true;
                yield { type: "assistant_message", text: content };
              }
            }
          }
          continue;
        }

        if (type === "tool_use") {
          yield { type: "provider_item", item: toolCallItem(event), raw: event };
          continue;
        }

        if (type === "tool_result") {
          yield { type: "provider_item", item: toolResultItem(event), raw: event };
          continue;
        }

        if (type === "error") {
          const message = asString(event?.message) ?? "unknown error";
          yield { type: "status", message: `gemini error: ${message}` };
          continue;
        }

        if (type === "result") {
          const usage = usageFromResultEvent(event);
          if (usage) yield { type: "usage", usage };
          if (schemaConstrained) {
            const normalized = normalizeSchemaConstrainedText(assistantText);
            if (normalized) {
              finalText = normalized;
              yield { type: "assistant_message", text: normalized };
              emittedAssistant = true;
            } else {
              finalText = assistantText.trim() || undefined;
            }
          } else {
            finalText = assistantText.trim() || undefined;
          }
          continue;
        }
      }
      await closePromise;
    } finally {
      rl.close();
      child.stderr.off("data", onStderrData);
      child.off("error", onProcessError);
      stop();
    }

    if (!schemaConstrained && !emittedAssistant && assistantText.trim()) {
      finalText = assistantText.trim();
    }
    if (spawnRuntimeError && !options?.signal?.aborted) {
      yield { type: "status", message: `gemini error: ${formatSpawnFailure(command, spawnRuntimeError as any)}` };
    } else if ((closeCode ?? 0) !== 0 && !options?.signal?.aborted) {
      const detail = tail(stderrChunks.join(""));
      const message = detail || `gemini process exited with code ${String(closeCode)}`;
      yield { type: "status", message: `gemini error: ${message}` };
    }
    yield { type: "done", finalText, threadId };
  }

  async runOnce(
    prompt: PromptContent,
    options?: { outputSchema?: any; signal?: AbortSignal },
  ): Promise<{ text: string; threadId?: string; items?: any[] }> {
    const items: NormalizedProviderItem[] = [];
    let threadId: string | undefined = this.config.threadId;
    let text = "";
    for await (const event of this.runStreamed(prompt, options)) {
      if (event.type === "assistant_message") text = event.text;
      if (event.type === "assistant_delta") text += event.delta;
      if (event.type === "provider_item") items.push(event.item);
      if (event.type === "done") {
        threadId = event.threadId ?? threadId;
        if (!text && typeof event.finalText === "string") text = event.finalText;
      }
    }
    return { text, threadId, items };
  }
}
