import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { annotateErrorWithStderr, appendStderrTail, inheritedProcessEnv } from "./provider_runtime.js";

export type JsonRpcId = string | number;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

type JsonRpcServerRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type CodexAppServerNotification = {
  method: string;
  params?: unknown;
};

export type CodexAppServerRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CodexAppServerApprovalDecision = {
  decision: "approve" | "decline";
  reason?: string;
};

export type CodexAppServerApprovalRequest = {
  method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
  params?: unknown;
};

export type CodexAppServerClientOptions = {
  workingDirectory: string;
  env?: Record<string, string>;
  configOverrides?: Record<string, unknown>;
  codexPathOverride?: string;
  clientInfoName?: string;
  clientInfoVersion?: string;
  startupTimeoutMs?: number;
  approvalRequestHandler?: (
    request: CodexAppServerApprovalRequest,
  ) => CodexAppServerApprovalDecision | Promise<CodexAppServerApprovalDecision>;
};

export interface CodexAppServerClientLike {
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown, options?: CodexAppServerRequestOptions): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  subscribe(handler: (notification: CodexAppServerNotification) => void): () => void;
  waitForNotification(
    predicate: (notification: CodexAppServerNotification) => boolean,
    options?: CodexAppServerRequestOptions,
  ): Promise<CodexAppServerNotification>;
  close(): Promise<void>;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  signal?: AbortSignal;
};

const INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const AGENT_STUDIO_ORIGINATOR = "agent_studio";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isObject(value) && (typeof value.id === "string" || typeof value.id === "number");
}

function isJsonRpcServerRequest(value: unknown): value is JsonRpcServerRequest {
  return isObject(value) && (typeof value.id === "string" || typeof value.id === "number") && typeof value.method === "string";
}

function isJsonRpcNotification(value: unknown): value is CodexAppServerNotification {
  return isObject(value) && typeof value.method === "string" && value.id === undefined;
}

function createAbortError(): Error {
  const err = new Error("aborted");
  (err as any).name = "AbortError";
  return err;
}

function formatJsonRpcError(error: JsonRpcError, method: string): Error {
  return new Error(`app-server ${method} failed (${error.code}): ${error.message}`);
}

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function toTomlValue(value: TomlValue, pathHint: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`codex config override at ${pathHint} must be a finite number`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    const rendered = value.map((entry, index) => toTomlValue(entry, `${pathHint}[${index}]`));
    return `[${rendered.join(", ")}]`;
  }
  const parts: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    parts.push(`${formatTomlKey(key)} = ${toTomlValue(entry, `${pathHint}.${key}`)}`);
  }
  return `{${parts.join(", ")}}`;
}

function flattenConfigOverrides(
  value: unknown,
  prefix: string,
  out: string[],
): void {
  if (!isObject(value)) {
    if (!prefix) throw new Error("codex config overrides must be a plain object");
    out.push(`${prefix}=${toTomlValue(value as TomlValue, prefix)}`);
    return;
  }
  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) return;
  if (prefix && entries.length === 0) {
    out.push(`${prefix}={}`);
    return;
  }
  for (const [key, entry] of entries) {
    if (!key) throw new Error("codex config override keys must be non-empty strings");
    if (entry === undefined || entry === null) continue;
    const next = prefix ? `${prefix}.${key}` : key;
    if (isObject(entry)) flattenConfigOverrides(entry, next, out);
    else out.push(`${next}=${toTomlValue(entry as TomlValue, next)}`);
  }
}

function serializeConfigOverrides(configOverrides?: Record<string, unknown>): string[] {
  if (!configOverrides) return [];
  const out: string[] = [];
  flattenConfigOverrides(configOverrides, "", out);
  return out;
}

function targetTriple(): string {
  const { platform, arch } = process;
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }
  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }
  throw new Error(`unsupported platform for codex binary: ${platform}/${arch}`);
}

function resolveCodexPath(codexPathOverride?: string): string {
  if (codexPathOverride && codexPathOverride.trim()) return codexPathOverride;
  try {
    const require = createRequire(import.meta.url);
    const sdkPackagePath = require.resolve("@openai/codex-sdk/package.json");
    const sdkRoot = path.dirname(sdkPackagePath);
    const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
    const candidate = path.join(sdkRoot, "vendor", targetTriple(), "codex", binaryName);
    if (existsSync(candidate)) return candidate;
  } catch {
    // fall back to PATH lookup below
  }
  return "codex";
}

export class CodexAppServerClient implements CodexAppServerClientLike {
  private options: CodexAppServerClientOptions;
  private process: ChildProcessWithoutNullStreams | undefined;
  private started = false;
  private closed = false;
  private nextId = 1;
  private startPromise: Promise<void> | undefined;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private notificationHandlers = new Set<(notification: CodexAppServerNotification) => void>();
  private stdoutInterface: readline.Interface | undefined;
  private recentStderr = "";

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    if (this.closed) throw new Error("app-server client is closed");
    const codexPath = resolveCodexPath(this.options.codexPathOverride);
    const overrideArgs = serializeConfigOverrides(this.options.configOverrides);
    const args: string[] = ["app-server"];
    for (const override of overrideArgs) args.push("-c", override);

    const env = inheritedProcessEnv(this.options.env);
    if (!env[INTERNAL_ORIGINATOR_ENV]) env[INTERNAL_ORIGINATOR_ENV] = AGENT_STUDIO_ORIGINATOR;

    const child = spawn(codexPath, args, {
      cwd: this.options.workingDirectory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process = child;
    this.stdoutInterface = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    this.stdoutInterface.on("line", (line) => this.onStdoutLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.recentStderr = appendStderrTail(this.recentStderr, String(chunk));
    });
    child.once("error", (err) => this.handleProcessExit(err instanceof Error ? err : new Error(String(err))));
    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      this.handleProcessExit(annotateErrorWithStderr(`codex app-server exited (${detail})`, this.recentStderr));
    });

    const initializeTimeoutMs = this.options.startupTimeoutMs ?? 15000;
    await this.requestRaw(
      "initialize",
      {
        clientInfo: {
          name: this.options.clientInfoName ?? "agent_studio",
          version: this.options.clientInfoVersion ?? "0.1.0",
        },
      },
      { timeoutMs: initializeTimeoutMs },
    );
    await this.notifyRaw("initialized", {});
    this.started = true;
  }

  subscribe(handler: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async waitForNotification(
    predicate: (notification: CodexAppServerNotification) => boolean,
    options?: CodexAppServerRequestOptions,
  ): Promise<CodexAppServerNotification> {
    await this.start();
    return new Promise<CodexAppServerNotification>((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(createAbortError());
        return;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = this.subscribe((notification) => {
        if (!predicate(notification)) return;
        cleanup();
        resolve(notification);
      });
      const abortHandler = () => {
        cleanup();
        reject(createAbortError());
      };
      const cleanup = () => {
        unsubscribe();
        if (timeout) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", abortHandler);
      };
      if (options?.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`timeout waiting for app-server notification (${options.timeoutMs}ms)`));
        }, options.timeoutMs);
      }
      options?.signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }

  async request<T = unknown>(method: string, params?: unknown, options?: CodexAppServerRequestOptions): Promise<T> {
    await this.start();
    return this.requestRaw(method, params, options) as Promise<T>;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.start();
    await this.notifyRaw(method, params);
  }

  private async requestRaw(method: string, params?: unknown, options?: CodexAppServerRequestOptions): Promise<unknown> {
    if (this.closed) throw new Error("app-server client is closed");
    const child = this.process;
    if (!child?.stdin || child.stdin.destroyed) throw new Error("app-server stdin unavailable");

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, signal: options?.signal };
      if (options?.timeoutMs && options.timeoutMs > 0) {
        pending.timeoutHandle = setTimeout(() => {
          this.pending.delete(id);
          reject(annotateErrorWithStderr(`app-server request timeout: ${method}`, this.recentStderr));
        }, options.timeoutMs);
      }
      if (options?.signal) {
        const onAbort = () => {
          this.pending.delete(id);
          reject(createAbortError());
        };
        pending.abortHandler = onAbort;
        if (options.signal.aborted) {
          reject(createAbortError());
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, pending);
    });

    child.stdin.write(payload, "utf8");
    return responsePromise;
  }

  private async notifyRaw(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error("app-server client is closed");
    const child = this.process;
    if (!child?.stdin || child.stdin.destroyed) throw new Error("app-server stdin unavailable");
    child.stdin.write(JSON.stringify({ method, params }) + "\n", "utf8");
  }

  private onStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (isJsonRpcResponse(parsed)) {
      this.handleResponse(parsed);
      return;
    }
    if (isJsonRpcServerRequest(parsed)) {
      this.handleServerRequest(parsed).catch(() => {
        // best-effort response path
      });
      return;
    }
    if (isJsonRpcNotification(parsed)) {
      for (const handler of [...this.notificationHandlers]) {
        try {
          handler(parsed);
        } catch {
          // keep dispatching remaining handlers
        }
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    if (pending.abortHandler && pending.signal) pending.signal.removeEventListener("abort", pending.abortHandler);
    if (response.error) {
      pending.reject(formatJsonRpcError(response.error, "request"));
      return;
    }
    pending.resolve(response.result);
  }

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    if (this.closed) return;
    const method = request.method;
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const decision = this.options.approvalRequestHandler
        ? await this.options.approvalRequestHandler({ method, params: request.params })
        : { decision: "decline" as const };
      await this.sendServerResponse(request.id, {
        decision: decision.decision,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      return;
    }
    if (method === "item/tool/call") {
      await this.sendServerResponse(request.id, {
        success: false,
        contentItems: [],
      });
      return;
    }
    await this.sendServerError(request.id, {
      code: -32601,
      message: `unsupported server request: ${method}`,
    });
  }

  private async sendServerResponse(id: JsonRpcId, result: unknown): Promise<void> {
    if (this.closed) return;
    const child = this.process;
    if (!child?.stdin || child.stdin.destroyed) return;
    child.stdin.write(JSON.stringify({ id, result }) + "\n", "utf8");
  }

  private async sendServerError(id: JsonRpcId, error: JsonRpcError): Promise<void> {
    if (this.closed) return;
    const child = this.process;
    if (!child?.stdin || child.stdin.destroyed) return;
    child.stdin.write(JSON.stringify({ id, error }) + "\n", "utf8");
  }

  private handleProcessExit(error: Error): void {
    if (this.closed) return;
    const errorWithStderr = annotateErrorWithStderr(error.message, this.recentStderr);
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      if (pending.abortHandler && pending.signal) pending.signal.removeEventListener("abort", pending.abortHandler);
      pending.reject(errorWithStderr);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.startPromise = undefined;
    this.notificationHandlers.clear();
    this.stdoutInterface?.close();
    const child = this.process;
    this.process = undefined;
    if (!child) return;
    if (!child.killed) child.kill();
  }
}
