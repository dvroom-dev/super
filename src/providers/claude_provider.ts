import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentProvider,
  ProviderCompactionResult,
  ProviderConfig,
  ProviderEvent,
  ProviderInterruptResult,
  ProviderSteerResult,
} from "./types.js";
import {
  normalizeClaudeAssistantMessage,
  normalizeClaudeReasoningMessage,
  normalizeClaudeGenericEvent,
  normalizeClaudeUserMessage,
  normalizeProviderFallback,
} from "./normalize_item.js";
import {
  asRecord,
  asToolNameList,
  extractAssistantText,
  extractDeltaFromStreamEvent,
  extractResultText,
  extractUsage,
  makePermissiveToolInputSchema,
  makeSwitchModeToolInputSchema,
  normalizeSchemaConstrainedResultText,
} from "./claude_provider_helpers.js";
import { promptContentToPlainText, type PromptContent } from "../utils/prompt_content.js";
import { executeTool } from "../tools/tools.js";
import type { CustomToolDefinition } from "../tools/definitions.js";
import { type ClaudePermissionResult, makeClaudeCanUseToolWithShellPolicy } from "./claude_tool_permissions.js";
import { inheritedProcessEnv } from "./provider_runtime.js";
import { buildClaudeSdkUserMessage } from "./claude_provider_prompt.js";
import type { ShellInvocationPolicy } from "../tools/shell_invocation_policy.js";
import type { ProviderFilesystemPolicy } from "./filesystem_permissions.js";
type ClaudeQueryArgs = { prompt: string | AsyncIterable<any>; options?: Record<string, unknown> };
type ClaudeQueryStream = AsyncIterable<any> & {
  close?: () => void;
  streamInput?: (stream: AsyncIterable<any>) => Promise<void>;
};
type ClaudeQueryFn = (args: ClaudeQueryArgs) => ClaudeQueryStream;
type ClaudeCreateSdkMcpServerFn = (options: {
  name: string;
  version?: string;
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<Record<string, unknown>>;
  }>;
}) => Record<string, unknown>;
type ClaudeProviderDeps = { query?: ClaudeQueryFn; createSdkMcpServer?: ClaudeCreateSdkMcpServerFn };
type ClaudeSdkReplayRecord = {
  schemaVersion: 1;
  provider: "claude";
  kind: "runStreamed" | "runOnce" | "compactThread";
  startedAt: string;
  workingDirectory: string;
  model: string;
  threadId?: string;
  prompt: unknown;
  options: Record<string, unknown>;
  replayConfig: {
    customTools: CustomToolDefinition[];
    shellInvocationPolicy?: ShellInvocationPolicy;
    providerFilesystemPolicy?: ProviderFilesystemPolicy;
    denyNetwork: boolean;
    toolPolicy?: { allow?: string[]; deny?: string[] };
  };
};
const READ_ONLY_DISALLOWED_TOOLS = ["Bash", "Edit", "MultiEdit", "Write", "FileEdit", "FileWrite", "NotebookEdit"];
const NETWORK_DISALLOWED_TOOLS = ["WebFetch", "WebSearch", "Browser", "Fetch", "HTTP", "UrlFetch", "Search"];
const SUPER_CUSTOM_TOOL_MCP_SERVER = "super_custom_tools";
const SWITCH_MODE_INPUT_SCHEMA = makeSwitchModeToolInputSchema();
const isStrictProfile = (config: ProviderConfig): boolean => config.permissionProfile !== "yolo";

function sanitizeForJson(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForJson(entry));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "function") continue;
      out[key] = sanitizeForJson(entry);
    }
    return out;
  }
  return String(value);
}

export class ClaudeProvider implements AgentProvider {
  private config: ProviderConfig;
  private query?: ClaudeQueryFn;
  private createSdkMcpServer?: ClaudeCreateSdkMcpServerFn;
  private customToolMcpServer?: Record<string, unknown>;
  private activeStream?: ClaudeQueryStream;
  private activeAbortController?: AbortController;
  private activeSessionId?: string;
  private activeTurnId?: string;
  private activeTurnCounter = 0;
  constructor(config: ProviderConfig, deps?: ClaudeProviderDeps) {
    this.config = config;
    this.query = deps?.query;
    this.createSdkMcpServer = deps?.createSdkMcpServer;
  }
  private sdkCallLogDir(): string {
    return path.join(this.config.workingDirectory, ".sdk_calls", "claude");
  }
  private async recordSdkCall(record: ClaudeSdkReplayRecord): Promise<void> {
    const dir = this.sdkCallLogDir();
    await fs.mkdir(dir, { recursive: true });
    const filename = `${record.startedAt.replace(/[:.]/g, "-")}-${record.kind}.json`;
    await fs.writeFile(
      path.join(dir, filename),
      JSON.stringify(record, null, 2) + "\n",
      "utf8",
    );
  }
  private replayConfig(toolPolicy?: { allow?: string[]; deny?: string[] }) {
    return {
      customTools: this.customToolsFromConfig(),
      shellInvocationPolicy: this.config.shellInvocationPolicy,
      providerFilesystemPolicy: this.config.providerFilesystemPolicy,
      denyNetwork: isStrictProfile(this.config),
      toolPolicy,
    };
  }
  private async ensureQuery(): Promise<ClaudeQueryFn> {
    if (!this.query || !this.createSdkMcpServer) {
      const mod = await import("@anthropic-ai/claude-agent-sdk");
      if (!this.query) {
        const query = (mod as any)?.query;
        if (typeof query !== "function") {
          throw new Error("claude provider requires @anthropic-ai/claude-agent-sdk query()");
        }
        this.query = query as ClaudeQueryFn;
      }
      if (!this.createSdkMcpServer) {
        const createSdkMcpServer = (mod as any)?.createSdkMcpServer;
        if (typeof createSdkMcpServer === "function") {
          this.createSdkMcpServer = createSdkMcpServer as ClaudeCreateSdkMcpServerFn;
        }
      }
    }
    return this.query;
  }
  private customToolsFromConfig(): CustomToolDefinition[] {
    return Array.isArray(this.config.customTools) ? this.config.customTools : [];
  }
  private async buildCustomToolMcpServer(): Promise<Record<string, unknown> | undefined> {
    const customTools = this.customToolsFromConfig();
    if (!customTools.length) return undefined;
    if (this.customToolMcpServer) return this.customToolMcpServer;
    await this.ensureQuery();
    if (!this.createSdkMcpServer) {
      throw new Error("claude provider custom tools require createSdkMcpServer()");
    }
    const tools = [
      ...customTools.map((customTool) => ({
        name: customTool.name,
        description: customTool.description,
        inputSchema: customTool.name === "switch_mode" ? SWITCH_MODE_INPUT_SCHEMA : makePermissiveToolInputSchema(),
        handler: async (toolArgs: Record<string, unknown>) => {
          const result = await executeTool(
            this.config.workingDirectory,
            { name: customTool.name, args: toolArgs ?? {} },
            { customTools: [customTool] },
          );
          const contentParts: string[] = [];
          if (result.output) contentParts.push(result.output);
          if (result.error) contentParts.push(`[error]\n${result.error}`);
          const text = contentParts.join("\n").trim() || (result.ok ? "ok" : "error");
          return {
            content: [{ type: "text", text }],
            ...(result.ok ? {} : { isError: true }),
          };
        },
      })),
    ];
    this.customToolMcpServer = this.createSdkMcpServer({
      name: SUPER_CUSTOM_TOOL_MCP_SERVER,
      version: "1.0.0",
      tools,
    });
    return this.customToolMcpServer;
  }
  private async buildQueryOptions(options?: { outputSchema?: any; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const defaultProviderOptions: Record<string, unknown> = {
      includePartialMessages: true,
    };
    const inheritedEnv = inheritedProcessEnv(this.config.env);
    delete inheritedEnv.CLAUDECODE;
    delete inheritedEnv.CLAUDE_CODE_ENTRYPOINT;
    delete inheritedEnv.CLAUDE_CODE_REPL_ENTRYPOINT;
    const out: Record<string, unknown> = {
      ...defaultProviderOptions,
      ...(this.config.providerOptions ?? {}),
      model: this.config.model,
      cwd: this.config.workingDirectory,
      env: {
        ...inheritedEnv,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
      permissionMode: "default",
    };
    const resumeThreadId = this.activeSessionId ?? this.config.threadId;
    if (resumeThreadId) out.resume = resumeThreadId;
    if (this.config.sandboxMode === "read-only") {
      const configuredDisallowed = asToolNameList(out.disallowedTools);
      out.disallowedTools = Array.from(new Set([...configuredDisallowed, ...READ_ONLY_DISALLOWED_TOOLS]));
    }
    if (isStrictProfile(this.config)) {
      const configuredDisallowed = asToolNameList(out.disallowedTools);
      out.disallowedTools = Array.from(new Set([...configuredDisallowed, ...NETWORK_DISALLOWED_TOOLS]));
    }
    const customToolMcpServer = await this.buildCustomToolMcpServer();
    if (customToolMcpServer) {
      const existingMcpServers = asRecord(out.mcpServers) ?? {};
      out.mcpServers = {
        ...existingMcpServers,
        [SUPER_CUSTOM_TOOL_MCP_SERVER]: customToolMcpServer,
      };
      if (Array.isArray(out.allowedTools)) {
        const existingAllowedTools = out.allowedTools
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter(Boolean);
        const customToolNames = this.customToolsFromConfig().map((tool) => tool.name);
        out.allowedTools = Array.from(new Set([...existingAllowedTools, ...customToolNames]));
      }
    }
    const hasProviderToolRestrictions =
      (asToolNameList(out.allowedTools).length > 0)
      || (asToolNameList(out.disallowedTools).length > 0);
    const hasShellRestrictions =
      (this.config.shellInvocationPolicy?.allow?.length ?? 0) > 0
      || (this.config.shellInvocationPolicy?.disallow?.length ?? 0) > 0;
    const hasFilesystemRestrictions = Boolean(this.config.providerFilesystemPolicy);
    const shouldInstallToolGate =
      this.config.approvalPolicy === "never"
      || isStrictProfile(this.config)
      || hasProviderToolRestrictions
      || hasShellRestrictions
      || hasFilesystemRestrictions;
    if (shouldInstallToolGate) {
      out.canUseTool = makeClaudeCanUseToolWithShellPolicy(
        this.config.workingDirectory,
        isStrictProfile(this.config),
        this.config.shellInvocationPolicy,
        this.config.providerFilesystemPolicy,
        {
          allow: asToolNameList(out.allowedTools),
          deny: asToolNameList(out.disallowedTools),
        },
      );
    }
    if (options?.outputSchema) out.outputFormat = { type: "json_schema", schema: options.outputSchema };
    if (options?.signal) out.abortController = new AbortController();
    if (options?.signal && out.abortController instanceof AbortController) {
      if (options.signal.aborted) out.abortController.abort();
      else options.signal.addEventListener("abort", () => out.abortController instanceof AbortController && out.abortController.abort(), { once: true });
    }
    return out;
  }
  private async buildQueryPrompt(prompt: PromptContent): Promise<string | AsyncIterable<any>> {
    const hasImages = prompt.some((part) => part.type === "image");
    const text = promptContentToPlainText(prompt);
    if (!hasImages) return text;
    const message = await buildClaudeSdkUserMessage(
      prompt,
      this.activeSessionId ?? this.config.threadId ?? `session_${Date.now().toString(36)}`,
    );
    return (async function* () {
      yield message;
    })();
  }
  private async recordableQueryPrompt(prompt: PromptContent): Promise<{ queryPrompt: string | AsyncIterable<any>; serializedPrompt: unknown }> {
    const hasImages = prompt.some((part) => part.type === "image");
    if (!hasImages) {
      const text = promptContentToPlainText(prompt);
      return { queryPrompt: text, serializedPrompt: text };
    }
    const message = await buildClaudeSdkUserMessage(
      prompt,
      this.activeSessionId ?? this.config.threadId ?? `session_${Date.now().toString(36)}`,
    );
    return {
      serializedPrompt: message,
      queryPrompt: (async function* () {
        yield message;
      })(),
    };
  }

  async steerActiveTurn(
    prompt: PromptContent,
    options?: { signal?: AbortSignal; expectedTurnId?: string },
  ): Promise<ProviderSteerResult> {
    const threadId = this.activeSessionId ?? this.config.threadId;
    const activeTurnId = this.activeTurnId;
    if (!this.activeStream || typeof this.activeStream.streamInput !== "function" || !activeTurnId) {
      return {
        applied: false,
        deferred: true,
        reason: "no active turn",
        threadId,
        turnId: activeTurnId,
      };
    }
    const expectedTurnId = options?.expectedTurnId ?? activeTurnId;
    if (expectedTurnId !== activeTurnId) {
      return {
        applied: false,
        deferred: true,
        reason: "stale expected turn id",
        threadId,
        turnId: activeTurnId,
      };
    }
    try {
      const message = await buildClaudeSdkUserMessage(
        prompt,
        threadId ?? this.activeSessionId ?? this.config.threadId ?? `session_${Date.now().toString(36)}`,
      );
      await this.activeStream.streamInput((async function* () {
        yield message;
      })());
      return {
        applied: true,
        deferred: false,
        threadId,
        turnId: activeTurnId,
      };
    } catch (err: any) {
      return {
        applied: false,
        deferred: true,
        reason: err?.message ?? String(err),
        threadId,
        turnId: activeTurnId,
      };
    }
  }

  async compactThread(
    options?: { signal?: AbortSignal; reason?: string },
  ): Promise<ProviderCompactionResult> {
    const currentThreadId = this.activeSessionId ?? this.config.threadId;
    if (!currentThreadId) {
      return { compacted: false, details: "no thread to compact" };
    }
    const query = await this.ensureQuery();
    let stream: ClaudeQueryStream | undefined;
    let threadId: string | undefined = currentThreadId;
    try {
      const queryOptions = await this.buildQueryOptions({ signal: options?.signal });
      await this.recordSdkCall({
        schemaVersion: 1,
        provider: "claude",
        kind: "compactThread",
        startedAt: new Date().toISOString(),
        workingDirectory: this.config.workingDirectory,
        model: this.config.model,
        threadId: currentThreadId,
        prompt: "/compact",
        options: sanitizeForJson(queryOptions) as Record<string, unknown>,
        replayConfig: this.replayConfig({
          allow: asToolNameList(queryOptions.allowedTools),
          deny: asToolNameList(queryOptions.disallowedTools),
        }),
      });
      stream = query({
        prompt: "/compact",
        options: queryOptions,
      });
      for await (const msg of stream) {
        if (typeof msg?.session_id === "string") threadId = msg.session_id;
      }
      if (threadId) {
        this.activeSessionId = threadId;
        this.config.threadId = threadId;
      }
      return { compacted: true, threadId };
    } catch (err: any) {
      return {
        compacted: false,
        threadId: threadId ?? currentThreadId,
        details: err?.message ?? String(err),
      };
    } finally {
      try {
        stream?.close?.();
      } catch {
        // ignore close errors from provider SDK teardown
      }
    }
  }

  async interruptActiveTurn(
    options?: { signal?: AbortSignal; reason?: string },
  ): Promise<ProviderInterruptResult> {
    const threadId = this.activeSessionId ?? this.config.threadId;
    const turnId = this.activeTurnId;
    if (!this.activeStream && !this.activeAbortController) {
      return {
        interrupted: false,
        reason: "no active turn",
        threadId,
        turnId,
      };
    }
    if (options?.signal?.aborted) {
      return {
        interrupted: false,
        reason: "interrupt signal already aborted",
        threadId,
        turnId,
      };
    }
    try {
      this.activeAbortController?.abort();
      try {
        this.activeStream?.close?.();
      } catch {
        // best-effort close for SDK stream teardown
      }
      return {
        interrupted: true,
        reason: options?.reason,
        threadId,
        turnId,
      };
    } catch (err: any) {
      return {
        interrupted: false,
        reason: err?.message ?? String(err),
        threadId,
        turnId,
      };
    }
  }

  async *runStreamed(
    prompt: PromptContent,
    options?: { outputSchema?: any; signal?: AbortSignal },
  ): AsyncGenerator<ProviderEvent, void, void> {
    const query = await this.ensureQuery();
    const schemaConstrained = Boolean(options?.outputSchema);
    let finalText: string | undefined;
    let threadId: string | undefined = this.config.threadId;
    let stream: ClaudeQueryStream | undefined;
    const activeTurnId = `claude_turn_${++this.activeTurnCounter}`;
    yield { type: "status", message: "claude: starting turn" };

    try {
      const { queryPrompt, serializedPrompt } = await this.recordableQueryPrompt(prompt);
      const queryOptions = await this.buildQueryOptions(options);
      await this.recordSdkCall({
        schemaVersion: 1,
        provider: "claude",
        kind: "runStreamed",
        startedAt: new Date().toISOString(),
        workingDirectory: this.config.workingDirectory,
        model: this.config.model,
        threadId: this.activeSessionId ?? this.config.threadId,
        prompt: sanitizeForJson(serializedPrompt),
        options: sanitizeForJson(queryOptions) as Record<string, unknown>,
        replayConfig: this.replayConfig({
          allow: asToolNameList(queryOptions.allowedTools),
          deny: asToolNameList(queryOptions.disallowedTools),
        }),
      });
      this.activeAbortController = queryOptions.abortController instanceof AbortController
        ? queryOptions.abortController
        : undefined;
      stream = query({ prompt: queryPrompt, options: queryOptions });
      this.activeStream = stream;
      this.activeSessionId = threadId;
      this.activeTurnId = activeTurnId;
      for await (const msg of stream) {
        if (!msg || typeof msg !== "object") continue;
        if (typeof msg?.session_id === "string") {
          threadId = msg.session_id;
          this.activeSessionId = threadId;
        }

        if (msg.type === "stream_event") {
          const delta = extractDeltaFromStreamEvent(msg.event);
          if (!schemaConstrained && typeof delta === "string" && delta.length > 0) yield { type: "assistant_delta", delta };
          continue;
        }
        if (msg.type === "assistant") {
          const reasoning = normalizeClaudeReasoningMessage(msg.message);
          if (reasoning) {
            yield { type: "provider_item", item: reasoning, raw: msg };
          }
          const text = extractAssistantText(msg.message);
          if (text) {
            finalText = text;
            if (!schemaConstrained) yield { type: "assistant_message", text };
          } else {
            const toolCall = normalizeClaudeAssistantMessage(msg.message);
            if (toolCall) {
              yield { type: "provider_item", item: toolCall, raw: msg };
            } else if (!reasoning) {
              yield { type: "provider_item", item: normalizeProviderFallback("claude", msg, "assistant"), raw: msg };
            }
          }
          continue;
        }
        if (msg.type === "user") {
          const normalizedItems = normalizeClaudeUserMessage(msg.message);
          if (normalizedItems.length > 0) {
            for (const item of normalizedItems) {
              yield { type: "provider_item", item, raw: msg };
            }
          } else {
            yield { type: "provider_item", item: normalizeProviderFallback("claude", msg, "user"), raw: msg };
          }
          continue;
        }
        if (msg.type === "result") {
          const usage = extractUsage(msg);
          if (usage) yield { type: "usage", usage };
          finalText = schemaConstrained
            ? normalizeSchemaConstrainedResultText(msg, finalText)
            : extractResultText(msg, finalText);
          yield { type: "provider_item", item: normalizeClaudeGenericEvent(msg) ?? normalizeProviderFallback("claude", msg, "result"), raw: msg };
          if (schemaConstrained && msg.subtype === "success" && !msg.is_error && typeof finalText === "string" && finalText.trim()) {
            yield { type: "assistant_message", text: finalText };
          }
          if (msg.subtype !== "success" || msg.is_error) {
            const errors = Array.isArray(msg.errors) ? msg.errors.map((v: any) => String(v)).filter(Boolean).join("; ") : "";
            const detail = errors || String(msg.subtype ?? "error_during_execution");
            yield { type: "status", message: `claude: ${detail}` };
          }
          continue;
        }
        if (msg.type === "system" && msg.subtype === "status" && typeof msg.status === "string" && msg.status) {
          yield { type: "provider_item", item: normalizeClaudeGenericEvent(msg) ?? normalizeProviderFallback("claude", msg, "system"), raw: msg };
          yield { type: "status", message: `claude: ${msg.status}` };
          continue;
        }
        if (msg.type === "auth_status") {
          const detail = Array.isArray(msg.output) ? msg.output.map((v: any) => String(v)).join(" ").trim() : "";
          yield { type: "provider_item", item: normalizeClaudeGenericEvent(msg) ?? normalizeProviderFallback("claude", msg, "auth_status"), raw: msg };
          if (detail) yield { type: "status", message: `claude: ${detail}` };
          continue;
        }
        yield { type: "provider_item", item: normalizeProviderFallback("claude", msg, "event"), raw: msg };
      }
    } finally {
      this.activeStream = undefined;
      this.activeAbortController = undefined;
      this.activeTurnId = undefined;
      this.activeSessionId = undefined;
      try {
        stream?.close?.();
      } catch {
        // ignore close errors from provider SDK teardown
      }
    }

    yield { type: "done", finalText, threadId };
  }

  async runOnce(
    prompt: PromptContent,
    options?: { outputSchema?: any; signal?: AbortSignal },
  ): Promise<{ text: string; threadId?: string; items?: any[] }> {
    const query = await this.ensureQuery();
    let finalText = "";
    let threadId: string | undefined = this.activeSessionId ?? this.config.threadId;
    const items: any[] = [];
    let stream: ClaudeQueryStream | undefined;

    try {
      const { queryPrompt, serializedPrompt } = await this.recordableQueryPrompt(prompt);
      const queryOptions = await this.buildQueryOptions(options);
      await this.recordSdkCall({
        schemaVersion: 1,
        provider: "claude",
        kind: "runOnce",
        startedAt: new Date().toISOString(),
        workingDirectory: this.config.workingDirectory,
        model: this.config.model,
        threadId: this.activeSessionId ?? this.config.threadId,
        prompt: sanitizeForJson(serializedPrompt),
        options: sanitizeForJson(queryOptions) as Record<string, unknown>,
        replayConfig: this.replayConfig({
          allow: asToolNameList(queryOptions.allowedTools),
          deny: asToolNameList(queryOptions.disallowedTools),
        }),
      });
      stream = query({ prompt: queryPrompt, options: queryOptions });
      this.activeSessionId = threadId;
      for await (const msg of stream) {
        if (!msg || typeof msg !== "object") continue;
        if (typeof msg?.session_id === "string") {
          threadId = msg.session_id;
          this.activeSessionId = threadId;
        }

        if (msg.type === "assistant") {
          const reasoning = normalizeClaudeReasoningMessage(msg.message);
          if (reasoning) items.push(reasoning);
          const text = extractAssistantText(msg.message);
          if (text) finalText = text;
          else {
            const toolCall = normalizeClaudeAssistantMessage(msg.message);
            if (toolCall) items.push(toolCall);
            else if (!reasoning) items.push(normalizeProviderFallback("claude", msg, "assistant"));
          }
          continue;
        }
        if (msg.type === "user") {
          const normalizedItems = normalizeClaudeUserMessage(msg.message);
          if (normalizedItems.length > 0) items.push(...normalizedItems);
          else items.push(normalizeProviderFallback("claude", msg, "user"));
          continue;
        }
        if (msg.type === "result") {
          finalText = options?.outputSchema
            ? normalizeSchemaConstrainedResultText(msg, finalText) ?? finalText
            : extractResultText(msg, finalText) ?? finalText;
          items.push(normalizeClaudeGenericEvent(msg) ?? normalizeProviderFallback("claude", msg, "result"));
          continue;
        }
        if (msg.type === "stream_event") continue;
        if (msg.type === "system" || msg.type === "auth_status") {
          items.push(normalizeClaudeGenericEvent(msg) ?? normalizeProviderFallback("claude", msg, msg.type));
          continue;
        }
        items.push(normalizeProviderFallback("claude", msg, "event"));
      }
    } finally {
      try {
        stream?.close?.();
      } catch {
        // ignore close errors from provider SDK teardown
      }
    }

    if (threadId) {
      this.activeSessionId = threadId;
      this.config.threadId = threadId;
    }
    return { text: finalText, threadId, items };
  }
}
