import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentProvider,
  ProviderCompactionResult,
  ProviderConfig,
  ProviderEvent,
  ProviderInterruptResult,
  ProviderSteerResult,
} from "./types.js";
import { normalizeCodexItem } from "./normalize_item.js";
import type { PromptContent } from "../utils/prompt_content.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientLike,
  type CodexAppServerClientOptions,
} from "./codex_app_server_client.js";
import {
  asRecord,
  asString,
  createAbortError,
  createNotificationQueue,
  customToolsCodexConfig,
  isStrictProfile,
  mergeRecords,
  normalizeCustomTools,
  normalizeSchemaConstrainedText,
  notificationThreadId,
  notificationTurnId,
  sandboxForThread,
  toTurnInput,
  waitWithSignal,
} from "./codex_provider_helpers.js";
import { extractShellCommandText, shellInvocationPolicyViolation } from "../tools/shell_invocation_policy.js";
import { firstFilesystemPolicyViolation } from "./filesystem_permissions.js";
type CodexProviderDeps = {
  appServerFactory?: (options: CodexAppServerClientOptions) => CodexAppServerClientLike;
  supportedModelSlugs?: () => Set<string>;
};
const SUPER_CUSTOM_TOOL_MCP_SERVER = "super_custom_tools";
const CUSTOM_TOOLS_MCP_SERVER_SCRIPT = fileURLToPath(new URL("../bin/custom_tools_mcp_server.ts", import.meta.url));
const COMPACTION_TIMEOUT_MS = 120000;
const DEFAULT_CODEX_DISALLOWED_TOOLS = [
  "mcpToolCall",
  "read_mcp_resource",
  "list_mcp_resources",
  "resources/read",
  "resources/list",
];
const RELEVANT_TURN_NOTIFICATION_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "thread/tokenUsage/updated",
  "error",
  "item/started",
  "item/updated",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
]);
function createProviderExecutionError(message: string, details: { threadId?: string; turnId?: string } = {}): Error {
  const err = new Error(message) as Error & {
    name: string;
    threadId?: string;
    turnId?: string;
  };
  err.name = "ProviderExecutionError";
  if (details.threadId) err.threadId = details.threadId;
  if (details.turnId) err.turnId = details.turnId;
  return err;
}
function isErrorStatusMessage(message: string): boolean {
  const normalized = String(message ?? "").toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("starting turn")) return false;
  return normalized.includes("error") || normalized.includes("failed") || normalized.includes("exception");
}
function defaultSupportedCodexModelSlugs(): Set<string> {
  const modelsCachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(modelsCachePath, "utf8"));
  } catch (error: any) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`codex model validation failed: could not read ${modelsCachePath}: ${detail}`);
  }
  const modelEntries = Array.isArray(asRecord(parsed)?.models) ? (asRecord(parsed)?.models as unknown[]) : null;
  if (!modelEntries) {
    throw new Error(`codex model validation failed: ${modelsCachePath} is missing a models[] catalog`);
  }
  const slugs = new Set<string>();
  for (const entry of modelEntries) {
    const slug = asString(asRecord(entry)?.slug) ?? asString(asRecord(entry)?.id);
    if (slug) slugs.add(slug);
  }
  if (slugs.size === 0) {
    throw new Error(`codex model validation failed: ${modelsCachePath} contained no model slugs`);
  }
  return slugs;
}
function validateConfiguredCodexModel(
  configuredModel: string,
  supportedModelSlugs: Set<string>,
): void {
  if (supportedModelSlugs.has(configuredModel)) return;
  const available = Array.from(supportedModelSlugs).sort().join(", ");
  throw new Error(
    `unsupported codex model '${configuredModel}'; local Codex catalog does not advertise it. ` +
    `Available models: ${available}`,
  );
}
export class CodexProvider implements AgentProvider {
  private config: ProviderConfig;
  private deps?: CodexProviderDeps;
  private client: CodexAppServerClientLike | undefined;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private currentTurnIdFromResponse(response: unknown): string | undefined {
    return asString(asRecord(response)?.turnId) ?? asString(asRecord(response)?.turn_id) ?? asString(asRecord(asRecord(response)?.turn)?.id);
  }
  constructor(config: ProviderConfig, deps?: CodexProviderDeps) {
    this.config = { ...config };
    this.deps = deps;
    this.threadId = undefined;
    validateConfiguredCodexModel(
      this.config.model,
      this.deps?.supportedModelSlugs ? this.deps.supportedModelSlugs() : defaultSupportedCodexModelSlugs(),
    );
  }
  private shellPolicyEnabled(): boolean {
    return Boolean(
      (this.config.shellInvocationPolicy?.allow?.length ?? 0) > 0
      || (this.config.shellInvocationPolicy?.disallow?.length ?? 0) > 0,
    );
  }
  private filesystemPolicyEnabled(): boolean {
    const policy = this.config.providerFilesystemPolicy;
    return Boolean(policy?.read || policy?.write || policy?.create || policy?.allowNewFiles != null);
  }
  private effectiveApprovalPolicy(): "untrusted" | "on-failure" | "on-request" | "never" {
    return (this.shellPolicyEnabled() || this.filesystemPolicyEnabled()) ? "on-request" : (this.config.approvalPolicy ?? "never");
  }
  private async approvalDecision(args: {
    method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
    params?: unknown;
  }): Promise<{ decision: "approve" | "decline"; reason?: string }> {
    if (args.method === "item/fileChange/requestApproval") {
      const violation = firstFilesystemPolicyViolation({
        provider: "codex",
        workspaceRoot: this.config.workingDirectory,
        toolName: "Write",
        input: asRecord(args.params) ?? {},
        policy: this.config.providerFilesystemPolicy,
      });
      if (!violation) return { decision: "approve" };
      return { decision: "decline", reason: violation };
    }
    const commandText = extractShellCommandText(args.params);
    if (commandText) {
      const violation = shellInvocationPolicyViolation({
        policy: this.config.shellInvocationPolicy,
        commandText,
      });
      if (violation) {
        return { decision: "decline", reason: violation };
      }
    }
    const violation = firstFilesystemPolicyViolation({
      provider: "codex",
      workspaceRoot: this.config.workingDirectory,
      toolName: "Bash",
      input: asRecord(args.params) ?? {},
      policy: this.config.providerFilesystemPolicy,
    });
    if (!violation) return { decision: "approve" };
    return { decision: "decline", reason: violation };
  }
  private providerConfigOverrides(): Record<string, unknown> {
    const customTools = normalizeCustomTools(this.config.customTools);
    const customToolConfig = customToolsCodexConfig(
      customTools,
      this.config.workingDirectory,
      SUPER_CUSTOM_TOOL_MCP_SERVER,
      CUSTOM_TOOLS_MCP_SERVER_SCRIPT,
    );
    const defaultProviderOptions: Record<string, unknown> = {
      show_raw_agent_reasoning: true,
      hide_hard_reasoning: false,
      model_reasoning_summary: "detailed",
    };
    const providerOptions = asRecord(this.config.providerOptions) ?? {};
    let mergedConfig = customToolConfig
      ? mergeRecords(mergeRecords(defaultProviderOptions, providerOptions), customToolConfig)
      : mergeRecords(defaultProviderOptions, providerOptions);
    const configuredDisallowedTools = Array.isArray(mergedConfig.disallowedTools)
      ? mergedConfig.disallowedTools
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter(Boolean)
      : [];
    mergedConfig = mergeRecords(mergedConfig, {
      disallowedTools: Array.from(new Set([...configuredDisallowedTools, ...DEFAULT_CODEX_DISALLOWED_TOOLS])),
    });
    if (this.config.modelReasoningEffort) {
      mergedConfig = mergeRecords(mergedConfig, {
        model_reasoning_effort: this.config.modelReasoningEffort,
      });
    }
    return mergedConfig;
  }
  private async ensureClient(): Promise<CodexAppServerClientLike> {
    if (this.client) return this.client;
    const options: CodexAppServerClientOptions = {
      workingDirectory: this.config.workingDirectory,
      env: this.config.env,
      configOverrides: this.providerConfigOverrides(),
      ...((this.shellPolicyEnabled() || this.filesystemPolicyEnabled())
        ? {
            approvalRequestHandler: (request: {
              method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
              params?: unknown;
            }) => this.approvalDecision(request),
          }
        : {}),
    };
    this.client = this.deps?.appServerFactory
      ? this.deps.appServerFactory(options)
      : new CodexAppServerClient(options);
    await this.client.start();
    return this.client;
  }
  private async ensureThreadId(): Promise<string> {
    if (this.threadId) return this.threadId;
    const client = await this.ensureClient();
    if (this.config.threadId) {
      const response = await client.request<any>("thread/resume", {
        threadId: this.config.threadId,
        model: this.config.model,
        cwd: this.config.workingDirectory,
        approvalPolicy: this.effectiveApprovalPolicy(),
        sandbox: sandboxForThread(this.config),
      });
      const resumedThreadId = asString(asRecord(response)?.thread && (asRecord(response)?.thread as any).id) ?? this.config.threadId;
      this.threadId = resumedThreadId;
      this.config.threadId = resumedThreadId;
      return resumedThreadId;
    }
    const response = await client.request<any>("thread/start", {
      model: this.config.model,
      cwd: this.config.workingDirectory,
      approvalPolicy: this.effectiveApprovalPolicy(),
      sandbox: sandboxForThread(this.config),
    });
    const startedThreadId = asString(asRecord(response)?.thread && (asRecord(response)?.thread as any).id);
    if (!startedThreadId) throw new Error("codex app-server did not return thread id");
    this.threadId = startedThreadId;
    this.config.threadId = startedThreadId;
    return startedThreadId;
  }
  private async interruptActiveTurnIfNeeded(signal?: AbortSignal): Promise<void> {
    if (!signal?.aborted) return;
    await this.interruptActiveTurn({ signal, reason: "abort_signal" });
    throw createAbortError();
  }
  async steerActiveTurn(
    prompt: PromptContent,
    options?: { signal?: AbortSignal; expectedTurnId?: string },
  ): Promise<ProviderSteerResult> {
    const threadId = this.threadId ?? this.config.threadId;
    const activeTurnId = this.activeTurnId;
    if (!threadId || !activeTurnId) {
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
      const client = await this.ensureClient();
      const response = await client.request<any>("turn/steer", {
        threadId,
        turnId: activeTurnId,
        expectedTurnId,
        input: toTurnInput(prompt),
      }, { signal: options?.signal });
      const turnId = this.currentTurnIdFromResponse(response) ?? activeTurnId;
      this.activeTurnId = turnId;
      return { applied: true, deferred: false, threadId, turnId };
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
  async interruptActiveTurn(
    options?: { signal?: AbortSignal; reason?: string },
  ): Promise<ProviderInterruptResult> {
    const threadId = this.threadId ?? this.config.threadId;
    const activeTurnId = this.activeTurnId;
    if (!threadId || !activeTurnId) {
      return {
        interrupted: false,
        reason: "no active turn",
        threadId,
        turnId: activeTurnId,
      };
    }
    try {
      const client = await this.ensureClient();
      await client.request("turn/interrupt", {
        threadId,
        turnId: activeTurnId,
        reason: options?.reason,
      }, { signal: options?.signal, timeoutMs: 15000 });
      return { interrupted: true, threadId, turnId: activeTurnId };
    } catch (err: any) {
      return {
        interrupted: false,
        reason: err?.message ?? String(err),
        threadId,
        turnId: activeTurnId,
      };
    }
  }
  async compactThread(
    options?: { signal?: AbortSignal; reason?: string }
  ): Promise<ProviderCompactionResult> {
    if (!this.threadId && !this.config.threadId) {
      return { compacted: false, details: "no thread to compact" };
    }
    try {
      const client = await this.ensureClient();
      const threadId = await this.ensureThreadId();
      await client.request("thread/compact/start", { threadId }, { signal: options?.signal });
      await client.waitForNotification((notification) => {
        if (notification.method === "thread/compacted") {
          return notificationThreadId(notification) === threadId;
        }
        if (notification.method === "item/completed") {
          const params = asRecord(notification.params);
          if (!params) return false;
          if (asString(params.threadId) !== threadId) return false;
          const itemType = asString(asRecord(params.item)?.type)?.toLowerCase();
          return itemType === "contextcompaction" || itemType === "context_compaction";
        }
        return false;
      }, {
        signal: options?.signal,
        timeoutMs: COMPACTION_TIMEOUT_MS,
      });
      this.config.threadId = threadId;
      return { compacted: true, threadId };
    } catch (err: any) {
      return {
        compacted: false,
        threadId: this.threadId ?? this.config.threadId,
        details: err?.message ?? String(err),
      };
    }
  }
  async *runStreamed(
    prompt: PromptContent,
    options?: { outputSchema?: any; signal?: AbortSignal }
  ): AsyncGenerator<ProviderEvent, void, void> {
    const schemaConstrained = Boolean(options?.outputSchema);
    const client = await this.ensureClient();
    const threadId = await this.ensureThreadId();
    yield { type: "status", message: "codex: starting turn" };
    const queue = createNotificationQueue();
    const unsubscribe = client.subscribe((notification) => {
      if (!RELEVANT_TURN_NOTIFICATION_METHODS.has(notification.method)) return;
      const msgThreadId = notificationThreadId(notification);
      if (msgThreadId && msgThreadId !== threadId) return;
      queue.push(notification);
    });
    const unsubscribeExit = client.onExit((error) => {
      queue.fail(error);
    });
    let turnId: string | undefined;
    let finalText: string | undefined;
    let emittedAssistant = false;
    try {
      const turnStartResponse = await client.request<any>("turn/start", {
        threadId,
        input: toTurnInput(prompt),
        outputSchema: options?.outputSchema,
      }, { signal: options?.signal });
      turnId = asString(asRecord(turnStartResponse)?.turn && (asRecord(turnStartResponse)?.turn as any).id);
      if (!turnId) throw new Error("codex app-server did not return turn id");
      this.activeTurnId = turnId;
      while (true) {
        await this.interruptActiveTurnIfNeeded(options?.signal);
        const notification = await waitWithSignal(queue.next(), options?.signal);
        const method = notification.method;
        const params = asRecord(notification.params);
        if (!params) continue;
        const eventTurnId = notificationTurnId(notification);
        const currentTurnId: string | undefined = this.activeTurnId ?? turnId; if (currentTurnId) turnId = currentTurnId;
        if (method === "turn/started") {
          const nextTurnId = asString(asRecord(params.turn)?.id) ?? eventTurnId;
          if (nextTurnId) {
            turnId = nextTurnId;
            this.activeTurnId = nextTurnId;
          }
          continue;
        }
        const isCurrentTurn = !eventTurnId || eventTurnId === currentTurnId;
        if (!isCurrentTurn) continue;
        if (method === "item/agentMessage/delta") {
          const delta = typeof params.delta === "string" ? params.delta : undefined;
          if (delta && !schemaConstrained) {
            yield { type: "assistant_delta", delta };
          }
          continue;
        }
        if (method === "item/completed") {
          const item = asRecord(params.item);
          if (!item) continue;
          const itemType = asString(item.type)?.toLowerCase();
          if (itemType === "agentmessage") {
            const itemText = asString(item.text);
            if (!itemText) continue;
            const normalizedText = schemaConstrained
              ? normalizeSchemaConstrainedText(itemText) ?? itemText.trim()
              : itemText;
            if (!normalizedText) continue;
            finalText = normalizedText;
            emittedAssistant = true;
            yield { type: "assistant_message", text: normalizedText };
          } else {
            yield { type: "provider_item", item: normalizeCodexItem(item), raw: notification };
          }
          continue;
        }
        if (
          method === "item/commandExecution/outputDelta"
          || method === "item/fileChange/outputDelta"
          || method === "item/reasoning/summaryTextDelta"
          || method === "item/reasoning/textDelta"
        ) {
          const delta = typeof params.delta === "string" ? params.delta : undefined;
          if (!delta) continue;
          const itemId = asString(params.itemId) ?? asString(params.item_id);
          const inferredType = method.includes("commandExecution")
            ? "commandExecution"
            : method.includes("fileChange")
              ? "fileChange"
              : "reasoning";
          const normalized = normalizeCodexItem({
            id: itemId,
            type: inferredType,
            status: "inProgress",
          });
          normalized.includeInTranscript = false;
          yield {
            type: "provider_item_delta",
            item: normalized,
            delta,
            id: itemId,
            raw: notification,
          };
          continue;
        }
        if (method === "thread/tokenUsage/updated") {
          const usage = params.usage ?? params.tokenUsage;
          if (usage) yield { type: "usage", usage };
          continue;
        }
        if (method === "error") {
          const message = asString(params.message) ?? asString(asRecord(params.error)?.message) ?? "codex: stream error";
          yield { type: "status", message };
          continue;
        }
        if (method === "turn/completed") {
          const turn = asRecord(params.turn);
          if (!turn) continue;
          const status = asString(turn.status) ?? "completed";
          const usage = turn.usage ?? turn.tokenUsage;
          if (usage) yield { type: "usage", usage };
          if (status === "failed") {
            const errMessage = asString(asRecord(turn.error)?.message) ?? "codex: turn failed";
            throw createProviderExecutionError(errMessage, {
              threadId,
              turnId: asString(turn.id) ?? turnId,
            });
          }
          if (schemaConstrained && !emittedAssistant && typeof finalText === "string" && finalText.trim()) {
            const normalizedText = normalizeSchemaConstrainedText(finalText);
            if (normalizedText) {
              finalText = normalizedText;
              yield { type: "assistant_message", text: normalizedText };
            }
          }
          yield { type: "done", finalText, threadId };
          return;
        }
      }
    } finally {
      unsubscribe();
      unsubscribeExit();
      if (this.activeTurnId === turnId) this.activeTurnId = undefined;
    }
  }
  async runOnce(
    prompt: PromptContent,
    options?: { outputSchema?: any; signal?: AbortSignal }
  ): Promise<{ text: string; threadId?: string; items?: any[] }> {
    let text = "";
    let threadId: string | undefined = this.threadId ?? this.config.threadId;
    const items: any[] = [];
    const statusErrors: string[] = [];
    for await (const event of this.runStreamed(prompt, options)) {
      if (event.type === "assistant_message") text = event.text;
      if (event.type === "provider_item") items.push(event.item);
      if (event.type === "status" && isErrorStatusMessage(event.message)) {
        statusErrors.push(event.message);
      }
      if (event.type === "done") {
        threadId = event.threadId ?? threadId;
        if (typeof event.finalText === "string" && event.finalText.trim()) {
          text = event.finalText;
        }
      }
    }
    if (!text.trim() && statusErrors.length > 0) {
      throw createProviderExecutionError(statusErrors[statusErrors.length - 1] ?? "codex: provider execution error", {
        threadId,
      });
    }
    return { text, threadId, items };
  }
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.activeTurnId = undefined;
    if (!client) return;
    try {
      await client.close();
    } catch {
      // best-effort cleanup
    }
  }
}
