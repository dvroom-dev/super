import { createProvider } from "../providers/factory.js";
import type { ProviderFilesystemPolicy } from "../providers/filesystem_permissions.js";
import type { ProviderConfig, ProviderEvent } from "../providers/types.js";
import { imagePart, promptContentFromText, type PromptContent } from "../utils/prompt_content.js";
import { newId } from "../utils/ids.js";
import { appendProviderRawEvent, saveFluxSession, writeFluxPromptPayload } from "./session_store.js";
import type { FluxConfig, FluxSessionRecord, FluxSessionType } from "./types.js";

export type FluxProviderTurnResult = {
  assistantText: string;
  providerThreadId?: string;
  providerEvents: ProviderEvent[];
  interrupted: boolean;
  policyViolation?: string;
};

const MAX_SESSION_TEXT_CHARS = 16_000;

function capSessionText(value: string): string {
  const text = String(value ?? "");
  if (text.length <= MAX_SESSION_TEXT_CHARS) return text;
  const suffix = "\n...[truncated]";
  return text.slice(0, MAX_SESSION_TEXT_CHARS - suffix.length) + suffix;
}

function isMissingRolloutPathFailure(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? "");
  return /state db missing rollout path/i.test(message) || /missing rollout path for thread/i.test(message);
}

function isRetryableThreadBadRequest(args: {
  error: unknown;
  providerEvents: ProviderEvent[];
}): boolean {
  const errorMessage = String((args.error as any)?.message ?? args.error ?? "");
  const texts = [errorMessage, ...args.providerEvents.map(extractProviderFailureText)].filter(Boolean).join("\n");
  return /\bbad request\b/i.test(texts)
    || /"detail"\s*:\s*"Bad Request"/i.test(texts)
    || (/remote compact task/i.test(texts) && /unknown parameter:\s*'prompt_cache_retention'/i.test(texts));
}

function extractProviderFailureText(event: ProviderEvent): string {
  if (event.type === "assistant_message") return String(event.text ?? "");
  if (event.type === "status") return String(event.message ?? "");
  if (event.type === "provider_item") {
    const raw = event.raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const result = String(record.result ?? "");
      if (result) return result;
    }
  }
  return "";
}

function extractProviderUserText(raw: Record<string, unknown>): string {
  const message = raw.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object" || Array.isArray(part)) return "";
    const record = part as Record<string, unknown>;
    return String(record.text ?? record.content ?? "");
  }).join("\n");
}

function detectProviderCompaction(events: ProviderEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "provider_item") continue;
    const raw = event.raw;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const type = String(record.type ?? "").trim().toLowerCase();
    const subtype = String(record.subtype ?? "").trim().toLowerCase();
    if (type === "system" && subtype === "compact_boundary") {
      return "provider compact boundary detected";
    }
    if (type === "system" && subtype === "status" && String(record.status ?? "").trim().toLowerCase() === "compacting") {
      return "provider started compacting";
    }
    if (type === "user") {
      const text = extractProviderUserText(record);
      if (/this session is being continued from a previous conversation that ran out of context/i.test(text)) {
        return "provider continued after context compaction";
      }
    }
  }
  return undefined;
}

function isClaudeRateLimited(args: {
  error: unknown;
  provider: string;
  providerEvents: ProviderEvent[];
}): string | null {
  if (args.provider !== "claude") return null;
  const errorMessage = String((args.error as any)?.message ?? args.error ?? "");
  const texts = [errorMessage, ...args.providerEvents.map(extractProviderFailureText)].filter(Boolean).join("\n");
  const hasRateLimitEvent = args.providerEvents.some((event) =>
    event.type === "provider_item"
    && Boolean(event.raw)
    && typeof event.raw === "object"
    && !Array.isArray(event.raw)
    && String((event.raw as Record<string, unknown>).type ?? "") === "rate_limit_event",
  );
  if (!hasRateLimitEvent && !/hit your limit|rate.?limit|overageStatus|org_level_disabled_until/i.test(texts)) {
    return null;
  }
  const detail = texts.match(/You've hit your limit[^\n]*/i)?.[0]
    ?? texts.match(/rate.?limit[^\n]*/i)?.[0]
    ?? "Claude provider rate limited";
  return detail.trim();
}

function extractProviderToolCommand(event: ProviderEvent): string {
  if (event.type !== "provider_item") return "";
  const raw = event.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const message = (raw as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  for (const entry of content) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const toolUse = entry as Record<string, unknown>;
    if (String(toolUse.type ?? "") !== "tool_use") continue;
    if (String(toolUse.name ?? "") !== "Bash") continue;
    const input = toolUse.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string" && command.trim()) return command;
  }
  return "";
}

function detectSolverPolicyViolation(providerEvents: ProviderEvent[]): string | undefined {
  for (const event of providerEvents) {
    const command = extractProviderToolCommand(event);
    if (!command) continue;
    if (/\b(?:bfs|dfs)(?:\b|[_-])/i.test(command)
      || /\breachability\b/i.test(command)
      || /\bbreadth[- ]first\b/i.test(command)
      || /\bdepth[- ]first\b/i.test(command)
      || /\bitertools\.product\b/i.test(command)
      || /\bpermutations\s*\(/i.test(command)
      || /\bproduct\s*\(/i.test(command) && /\bitertools\b/i.test(command)
      || /\bdeque\s*\(/i.test(command)
      || /\bfrom\s+collections\s+import\s+deque\b/i.test(command)) {
      return `prohibited solver search in Bash command: ${command.slice(0, 200)}`;
    }
    if (/\bobs\s*,\s*reward\s*,\s*done\s*,\s*info\s*=\s*env\.step\s*\(/i.test(command)
      || /\benv\.step\s*\([^)]*\)\s*\[/i.test(command)) {
      return `invalid env.step usage in Bash command: ${command.slice(0, 200)}`;
    }
  }
  return undefined;
}

export async function runFluxProviderTurn(args: {
  workspaceRoot: string;
  config: FluxConfig;
  session: FluxSessionRecord;
  sessionType: FluxSessionType;
  invocationId?: string;
  promptText: string;
  promptImages?: string[];
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  outputSchema?: Record<string, unknown>;
  workingDirectory: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<FluxProviderTurnResult> {
  const prompt: PromptContent = promptContentFromText(args.promptText);
  for (const imagePath of args.promptImages ?? []) {
    const part = imagePart(imagePath);
    if (part) prompt.push(part);
  }
  const turnIndex = Date.now();
  if (args.config.observability.capturePrompts) {
    await writeFluxPromptPayload(args.workspaceRoot, args.config, args.sessionType, args.session.sessionId, turnIndex, {
      invocationId: args.invocationId ?? null,
      promptText: args.promptText,
      promptImages: args.promptImages ?? [],
      outputSchema: args.outputSchema ?? null,
      workingDirectory: args.workingDirectory,
    });
  }
  const filesystemPolicy: ProviderFilesystemPolicy = {
    read: { allow: [args.workingDirectory] },
    write: { allow: [args.workingDirectory] },
    create: { allow: [args.workingDirectory] },
    allowNewFiles: true,
  };
  const providerEvents: ProviderEvent[] = [];
  let assistantText = "";
  let providerThreadId = args.session.providerThreadId;
  let interrupted = false;
  let policyViolation: string | undefined;
  let compactionRetryUsed = false;
  const runOnce = async (threadId: string | undefined): Promise<void> => {
    const providerConfig: ProviderConfig = {
      provider: args.session.provider as any,
      model: args.session.model,
      workingDirectory: args.workingDirectory,
      threadId,
      modelReasoningEffort: args.reasoningEffort,
      sandboxMode: args.config.runtimeDefaults.sandboxMode,
      approvalPolicy: args.config.runtimeDefaults.approvalPolicy,
      permissionProfile: "workspace_no_network",
      providerFilesystemPolicy: filesystemPolicy,
      providerOptions: {
        allowedTools: ["Bash"],
      },
      env: {
        ...args.config.runtimeDefaults.env,
        ...(args.env ?? {}),
      },
      skipGitRepoCheck: true,
    };
    const provider = createProvider(providerConfig);
    try {
      for await (const event of provider.runStreamed(prompt, { outputSchema: args.outputSchema, signal: args.signal })) {
        providerEvents.push(event);
        if (args.config.observability.captureRawProviderEvents) {
          await appendProviderRawEvent(args.workspaceRoot, args.config, args.sessionType, args.session.sessionId, {
            id: newId("raw"),
            ts: new Date().toISOString(),
            event,
          });
        }
        if (event.type === "assistant_delta") assistantText += event.delta;
        if (event.type === "assistant_message") assistantText = event.text;
        if (event.type === "done" && event.threadId) providerThreadId = event.threadId;
      }
    } finally {
      await provider.close?.();
    }
  };
  try {
    await runOnce(args.session.providerThreadId);
  } catch (err: any) {
    const message = String(err?.message ?? err ?? "");
    const abortLike = err?.name === "AbortError" || /aborted by user/i.test(message) || /interrupt/i.test(message);
    if (abortLike) {
      interrupted = true;
    } else if (
      args.session.providerThreadId
      && (
        isMissingRolloutPathFailure(err)
        || isRetryableThreadBadRequest({
          error: err,
          providerEvents,
        })
      )
    ) {
      args.session.providerThreadId = undefined;
      args.session.updatedAt = new Date().toISOString();
      await saveFluxSession(args.workspaceRoot, args.config, args.session);
      assistantText = "";
      providerThreadId = undefined;
      await runOnce(undefined);
    } else {
      const rateLimitedDetail = isClaudeRateLimited({
        error: err,
        provider: args.session.provider,
        providerEvents,
      });
      if (rateLimitedDetail) {
        throw new Error(`provider_rate_limited: ${rateLimitedDetail}`);
      }
      throw err;
    }
  }
  const compactionDetail = detectProviderCompaction(providerEvents);
  if (
    !interrupted
    && !compactionRetryUsed
    && args.session.provider === "claude"
    && args.session.providerThreadId
    && compactionDetail
  ) {
    compactionRetryUsed = true;
    args.session.providerThreadId = undefined;
    args.session.updatedAt = new Date().toISOString();
    await saveFluxSession(args.workspaceRoot, args.config, args.session);
    assistantText = "";
    providerThreadId = undefined;
    await runOnce(undefined);
  }
  args.session.providerThreadId = providerThreadId;
  args.session.updatedAt = new Date().toISOString();
  args.session.latestAssistantText = capSessionText(assistantText);
  await saveFluxSession(args.workspaceRoot, args.config, args.session);
  if (args.sessionType === "solver") {
    policyViolation = detectSolverPolicyViolation(providerEvents);
  }
  return { assistantText, providerThreadId, providerEvents, interrupted, policyViolation };
}
