import type { PromptContent } from "../utils/prompt_content.js";
import type { CustomToolDefinition } from "../tools/definitions.js";
import type { ProviderConfig } from "./types.js";
import type { CodexAppServerNotification } from "./codex_app_server_client.js";

export type NotificationQueue = {
  push: (notification: CodexAppServerNotification) => void;
  fail: (error: Error) => void;
  next: () => Promise<CodexAppServerNotification>;
};

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = cloneJson(entry);
  }
  return out;
}

export function mergeRecords(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    const existingRecord = asRecord(existing);
    const valueRecord = asRecord(value);
    if (existingRecord && valueRecord) {
      out[key] = mergeRecords(existingRecord, valueRecord);
      continue;
    }
    out[key] = cloneJson(value);
  }
  return out;
}

export function normalizeCustomTools(customTools: CustomToolDefinition[] | undefined): CustomToolDefinition[] {
  if (!Array.isArray(customTools) || customTools.length === 0) return [];
  return customTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    command: [...tool.command],
    cwd: tool.cwd,
  }));
}

export function customToolsCodexConfig(
  customTools: CustomToolDefinition[],
  workspaceRoot: string,
  serverName: string,
  serverScriptPath: string,
): Record<string, unknown> | undefined {
  if (customTools.length === 0) return undefined;
  const runner = process.env.BUN ?? "bun";
  const toolsJson = JSON.stringify(customTools);
  return {
    mcp_servers: {
      [serverName]: {
        command: runner,
        args: ["run", serverScriptPath],
        env: {
          SUPER_CUSTOM_TOOLS_JSON: toolsJson,
          SUPER_CUSTOM_TOOLS_WORKSPACE_ROOT: workspaceRoot,
        },
      },
    },
  };
}

export function isStrictProfile(config: ProviderConfig): boolean {
  return config.permissionProfile !== "yolo";
}

export function toTurnInput(prompt: PromptContent): Array<{ type: "text"; text: string } | { type: "localImage"; path: string }> {
  const items: Array<{ type: "text"; text: string } | { type: "localImage"; path: string }> = [];
  for (const part of prompt) {
    if (part.type === "text") {
      items.push({ type: "text", text: part.text });
      continue;
    }
    items.push({ type: "localImage", path: part.path });
  }
  return items.length ? items : [{ type: "text", text: "" }];
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

export function normalizeSchemaConstrainedText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const parsed = tryParseJsonObject(text);
  if (parsed) return JSON.stringify(parsed);
  const trimmed = text.trim();
  return trimmed || undefined;
}

export function notificationThreadId(notification: CodexAppServerNotification): string | undefined {
  const params = asRecord(notification.params);
  if (!params) return undefined;
  return asString(params.threadId) ?? asString(params.thread_id);
}

export function notificationTurnId(notification: CodexAppServerNotification): string | undefined {
  const params = asRecord(notification.params);
  if (!params) return undefined;
  return asString(params.turnId) ?? asString(params.turn_id) ?? asString(asRecord(params.turn)?.id);
}

export function createAbortError(): Error {
  const err = new Error("aborted");
  (err as any).name = "AbortError";
  return err;
}

export async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw createAbortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function sandboxForThread(config: ProviderConfig): "read-only" | "workspace-write" | "danger-full-access" {
  if (config.sandboxMode === "read-only") return "read-only";
  if (config.sandboxMode === "danger-full-access") return "danger-full-access";
  return "workspace-write";
}

export function createNotificationQueue(): NotificationQueue {
  const buffered: CodexAppServerNotification[] = [];
  const waiters: Array<{ resolve: (value: CodexAppServerNotification) => void; reject: (error: Error) => void }> = [];
  let failedError: Error | undefined;
  return {
    push(notification) {
      if (failedError) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(notification);
      else buffered.push(notification);
    },
    fail(error) {
      if (failedError) return;
      failedError = error;
      while (waiters.length > 0) {
        waiters.shift()?.reject(error);
      }
    },
    async next() {
      if (buffered.length) return buffered.shift() as CodexAppServerNotification;
      if (failedError) throw failedError;
      return new Promise<CodexAppServerNotification>((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}
