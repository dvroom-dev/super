import type { AgentProvider, ProviderEvent } from "../../../providers/types.js";
import type { SupervisorConfig } from "../types.js";
import type { RuntimeContext } from "../requests/context.js";
import { renderChat, renderToolCall } from "../../../markdown/render.js";
import { adjustedTokenUsage } from "../helpers.js";
import { maybeCompactProviderItem } from "../tool_output.js";
import { extractInlineToolCalls, type InlineToolCall } from "./inline_tools.js";
import { appendRawProviderEvent } from "../raw_event_store.js";
import { renderProviderItemForTranscript } from "./provider_transcript.js";
import { promptContentFromText, type PromptContent } from "../../../utils/prompt_content.js";
import {
  createProviderToolInterceptionEventCollector,
  extractRuntimeInlineCallsFromProviderEvent,
  type ProviderToolInterceptionEvent,
} from "./provider_tool_events.js";
export type { ProviderToolInterceptionEvent } from "./provider_tool_events.js";

export type BudgetState = {
  startedAt: number;
  timeBudgetMs: number;
  tokenBudgetAdjusted: number;
  cadenceTimeMs: number;
  cadenceTokensAdjusted: number;
  adjustedTokensUsed: number;
  budgetMultiplier: number;
  modelCost?: number;
  minCost?: number;
  cheapestModel?: string;
  cadenceAnchorAt: number;
  cadenceTokensAnchor: number;
  timeBudgetHit: boolean;
  tokenBudgetHit: boolean;
};

export type TurnResult = {
  appended: string[];
  assistantText: string;
  errorMessage: string | null;
  assistantFinal: boolean;
  toolCalls?: InlineToolCall[];
  providerToolEvents?: ProviderToolInterceptionEvent[];
  hadError: boolean;
  interrupted: boolean;
  interruptionReason: string | null;
  abortedBySupervisor: boolean;
  abortError: boolean;
  streamEnded: boolean;
  usage: any;
  newThreadId?: string;
  cadenceHit: boolean;
  cadenceReason: "cadence_time" | "cadence_tokens" | null;
  compactionDetected: boolean;
  compactionDetails: string | null;
};

export type CadenceHitEvent = {
  reason: "cadence_time" | "cadence_tokens";
  requestInterrupt: (reason: string) => void;
  requestSteer: (
    message: string,
    options?: { expectedTurnId?: string },
  ) => Promise<{
    applied: boolean;
    deferred: boolean;
    reason?: string;
    threadId?: string;
    turnId?: string;
  }>;
};

function isSuccessfulSwitchModeResponse(event: ProviderToolInterceptionEvent): boolean {
  if (event.when !== "response") return false;
  if (String(event.toolName ?? "").trim() !== "switch_mode") return false;
  const text = String(event.outputText ?? "").trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).ok === true;
  } catch {
    return /\(ok\s*=\s*true\)/i.test(text) || /"ok"\s*:\s*true/i.test(text);
  }
}

export async function runAgentTurn(args: {
  ctx: RuntimeContext;
  docPath: string;
  provider: AgentProvider;
  prompt: PromptContent;
  outputSchema?: any;
  supervisor: SupervisorConfig;
  budget: BudgetState;
  currentModel: string;
  pricing?: SupervisorConfig["pricing"];
  controller: AbortController;
  sendBudgetUpdate: () => void;
  workspaceRoot: string;
  conversationId: string;
  toolOutput?: any;
  onCadenceHit?: (event: CadenceHitEvent) => void | Promise<void>;
  onToolBoundary?: () => void | Promise<void>;
  onAppendMarkdown?: (markdown: string) => void;
  onAssistantText?: (text: string) => void;
}): Promise<TurnResult> {
  const { ctx, docPath, provider, prompt, outputSchema, budget, currentModel, pricing, controller, sendBudgetUpdate, workspaceRoot, conversationId, toolOutput } = args;

  const appended: string[] = [];
  const appendMarkdown = (md: string, track = true) => {
    ctx.sendNotification({ method: "conversation.append", params: { docPath, markdown: md } });
    try {
      args.onAppendMarkdown?.(md);
    } catch {
      // best-effort stream callback
    }
    if (track) appended.push(md);
  };

  let newThreadId: string | undefined;
  let assistantText = "";
  let assistantFinal = false;
  let toolCalls: InlineToolCall[] | null = null;
  let providerToolEvents: ProviderToolInterceptionEvent[] | null = null;
  let cadenceHit = false;
  let cadenceReason: "cadence_time" | "cadence_tokens" | null = null;
  let compactionDetected = false;
  let compactionDetails: string | null = null;
  let interrupted = false;
  let interruptionReason: string | null = null;
  let abortedBySupervisor = false;
  let abortError = false;
  let streamEnded = false;
  let usage: any = undefined;
  let lastOutputTokens = 0;
  const providerToolCollector = createProviderToolInterceptionEventCollector();

  const requestInterrupt = (reason: string) => {
    void provider.interruptActiveTurn?.({ reason }).catch(() => {});
    if (!interrupted) {
      interrupted = true;
      interruptionReason = reason;
    }
    if (!controller.signal.aborted) {
      abortedBySupervisor = true;
      controller.abort();
    }
  };

  let hadError = false;
  let errorMessage: string | null = null;

  const extractThreadIdFromProviderEvent = (event: ProviderEvent): string | undefined => {
    if (event.type === "done") {
      return typeof event.threadId === "string" && event.threadId.trim()
        ? event.threadId.trim()
        : undefined;
    }
    if (event.type !== "provider_item" && event.type !== "provider_item_delta") return undefined;
    const raw = event.raw;
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    const directThreadId = typeof record.threadId === "string" ? record.threadId.trim() : "";
    if (directThreadId) return directThreadId;
    const directSessionId = typeof record.session_id === "string" ? record.session_id.trim() : "";
    if (directSessionId) return directSessionId;
    const params = record.params;
    if (!params || typeof params !== "object") return undefined;
    const paramsRecord = params as Record<string, unknown>;
    const paramsThreadId = typeof paramsRecord.threadId === "string" ? paramsRecord.threadId.trim() : "";
    if (paramsThreadId) return paramsThreadId;
    const item = paramsRecord.item;
    if (!item || typeof item !== "object") return undefined;
    const itemRecord = item as Record<string, unknown>;
    const itemThreadId = typeof itemRecord.threadId === "string" ? itemRecord.threadId.trim() : "";
    return itemThreadId || undefined;
  };

  const detectProviderCompaction = (event: ProviderEvent): { detected: boolean; detail?: string } => {
    if (event.type !== "provider_item" && event.type !== "provider_item_delta") return { detected: false };
    const raw = event.raw;
    if (!raw || typeof raw !== "object") return { detected: false };
    const record = raw as Record<string, unknown>;
    const type = String(record.type ?? "").trim().toLowerCase();
    const subtype = String(record.subtype ?? "").trim().toLowerCase();
    if (type === "system" && subtype === "compact_boundary") {
      return { detected: true, detail: "provider compact boundary detected" };
    }
    if (type === "system" && subtype === "status" && String(record.status ?? "").trim().toLowerCase() === "compacting") {
      return { detected: true, detail: "provider started compacting" };
    }
    if (type === "user") {
      const message = record.message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => {
                if (typeof part === "string") return part;
                if (!part || typeof part !== "object") return "";
                return String((part as Record<string, unknown>).text ?? (part as Record<string, unknown>).content ?? "");
              }).join("\n")
            : "";
        if (/this session is being continued from a previous conversation that ran out of context/i.test(text)) {
          return { detected: true, detail: "provider continued after context compaction" };
        }
      }
    }
    return { detected: false };
  };

  const notifyToolBoundary = async () => {
    try {
      const maybe = args.onToolBoundary?.();
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        await maybe;
      }
    } catch {
      // best-effort boundary callback
    }
  };

  const isToolBoundaryItem = (item: any): boolean => {
    const kind = String(item?.kind ?? item?.item_kind ?? "").toLowerCase();
    const type = String(item?.type ?? item?.item_type ?? "").toLowerCase();
    const summary = String(item?.summary ?? item?.item_summary ?? "").toLowerCase();
    return (
      kind.includes("tool_result") ||
      type === "tool_result" ||
      summary.startsWith("tool_result")
    );
  };

  try {
    for await (const ev of provider.runStreamed(prompt, { signal: controller.signal, outputSchema })) {
      const compaction = detectProviderCompaction(ev);
      if (compaction.detected) {
        compactionDetected = true;
        compactionDetails = compaction.detail ?? "provider compaction detected";
        requestInterrupt("provider_compaction");
      }
      const streamedThreadId = extractThreadIdFromProviderEvent(ev);
      if (streamedThreadId) newThreadId = streamedThreadId;
      const elapsed = Date.now() - budget.startedAt;
      if (budget.timeBudgetMs && elapsed >= budget.timeBudgetMs) {
        budget.timeBudgetHit = true;
        requestInterrupt("time_budget");
        break;
      }
      if (budget.cadenceTimeMs && !cadenceHit && Date.now() - budget.cadenceAnchorAt >= budget.cadenceTimeMs) {
        cadenceHit = true;
        cadenceReason = "cadence_time";
        try {
          const maybe = args.onCadenceHit?.({
            reason: "cadence_time",
            requestInterrupt,
            requestSteer: async (message, steerOptions) => {
              if (!provider.steerActiveTurn) {
                return { applied: false, deferred: true, reason: "provider does not support steering" };
              }
              return provider.steerActiveTurn(promptContentFromText(message), {
                signal: controller.signal,
                expectedTurnId: steerOptions?.expectedTurnId,
              });
            },
          });
          if (maybe && typeof (maybe as Promise<void>).then === "function") {
            void (maybe as Promise<void>).catch(() => {});
          }
        } catch {
          // best-effort cadence callback
        }
        if (interrupted) {
          break;
        }
      }

      if (ev.type === "assistant_message") {
        assistantText = ev.text;
        await appendRawProviderEvent({
          workspaceRoot,
          conversationId,
          provider: "unknown",
          item: {
            provider: "unknown",
            kind: "other",
            type: "assistant_message",
            summary: "assistant_message",
            includeInTranscript: true,
          },
          raw: {
            type: "assistant_message",
            text: ev.text,
          },
        });
        try {
          args.onAssistantText?.(assistantText);
        } catch {
          // best-effort stream callback
        }
        const inlineCalls = extractInlineToolCalls(ev.text);
        if (inlineCalls) {
          toolCalls = [...(toolCalls ?? []), ...inlineCalls];
          assistantFinal = true;
          for (const call of inlineCalls) {
            appendMarkdown(renderToolCall(call.name, call.body));
          }
        } else {
          const md = renderChat("assistant", ev.text.trim());
          assistantFinal = true;
          appendMarkdown(md);
        }
      } else if (ev.type === "assistant_delta") {
        assistantText += ev.delta;
        try {
          args.onAssistantText?.(assistantText);
        } catch {
          // best-effort stream callback
        }
        ctx.sendNotification({ method: "conversation.assistant_delta", params: { docPath, delta: ev.delta } });
      } else if (ev.type === "provider_item_delta") {
        const compacted = await maybeCompactProviderItem({ item: ev.item, workspaceRoot, conversationId, toolOutput });
        if (ev.raw !== undefined) {
          await appendRawProviderEvent({
            workspaceRoot,
            conversationId,
            provider: compacted.item.provider,
            item: compacted.item,
            raw: ev.raw,
          });
        }
        if (compacted.item.includeInTranscript === false) continue;
        const id = typeof ev.id === "string" ? ev.id.trim() : "";
        const delta = typeof ev.delta === "string" ? ev.delta.trim() : "";
        if (!id || !delta) {
          const md = renderProviderItemForTranscript(compacted.item);
          if (md) appendMarkdown(md);
        }
      } else if (ev.type === "provider_item") {
        const runtimeInlineCalls = extractRuntimeInlineCallsFromProviderEvent(ev);
        if (runtimeInlineCalls.length > 0) {
          toolCalls = [...(toolCalls ?? []), ...runtimeInlineCalls];
        }
        const capturedProviderToolEvents = providerToolCollector.collect(ev);
        if (capturedProviderToolEvents.length > 0) {
          providerToolEvents = [...(providerToolEvents ?? []), ...capturedProviderToolEvents];
          if (capturedProviderToolEvents.some(isSuccessfulSwitchModeResponse)) {
            requestInterrupt("agent_switch_mode_request");
          }
        }
        const compacted = await maybeCompactProviderItem({ item: ev.item, workspaceRoot, conversationId, toolOutput });
        if (ev.raw !== undefined) {
          await appendRawProviderEvent({
            workspaceRoot,
            conversationId,
            provider: compacted.item.provider,
            item: compacted.item,
            raw: ev.raw,
          });
        }
        if (compacted.item.includeInTranscript === false) continue;
        const md = renderProviderItemForTranscript(compacted.item);
        if (md) appendMarkdown(md);
        if (isToolBoundaryItem(compacted.item)) await notifyToolBoundary();
        if (interrupted) break;
      } else if (ev.type === "status") {
        if ((ev.message || "").includes("turn.failed") || (ev.message || "").includes("error")) {
          hadError = true;
        }
        ctx.sendNotification({ method: "conversation.status", params: { message: ev.message } });
        ctx.sendNotification({ method: "log", params: { level: "info", message: ev.message } });
      } else if (ev.type === "usage") {
        usage = ev.usage;
        const outputTokens = Number(ev.usage?.output_tokens ?? 0);
        const delta = Math.max(0, outputTokens - lastOutputTokens);
        lastOutputTokens = outputTokens;
        const adjusted = adjustedTokenUsage({ outputTokens: delta, model: currentModel, pricing });
        budget.adjustedTokensUsed += adjusted.adjustedTokens;
        budget.budgetMultiplier = adjusted.multiplier;
        budget.modelCost = adjusted.modelCost ?? budget.modelCost;
        budget.minCost = adjusted.minCost ?? budget.minCost;
        budget.cheapestModel = adjusted.cheapestModel ?? budget.cheapestModel;
        sendBudgetUpdate();
        ctx.sendNotification({ method: "conversation.usage", params: { usage: ev.usage } });
        ctx.sendNotification({ method: "log", params: { level: "info", message: `usage: ${JSON.stringify(ev.usage)}` } });
        if (budget.tokenBudgetAdjusted && budget.adjustedTokensUsed >= budget.tokenBudgetAdjusted) {
          budget.tokenBudgetHit = true;
          requestInterrupt("token_budget");
          break;
        }
        const cadenceTokensUsed = budget.adjustedTokensUsed - budget.cadenceTokensAnchor;
        if (budget.cadenceTokensAdjusted && !cadenceHit && cadenceTokensUsed >= budget.cadenceTokensAdjusted) {
          cadenceHit = true;
          cadenceReason = "cadence_tokens";
          try {
            const maybe = args.onCadenceHit?.({
              reason: "cadence_tokens",
              requestInterrupt,
              requestSteer: async (message, steerOptions) => {
                if (!provider.steerActiveTurn) {
                  return { applied: false, deferred: true, reason: "provider does not support steering" };
                }
                return provider.steerActiveTurn(promptContentFromText(message), {
                  signal: controller.signal,
                  expectedTurnId: steerOptions?.expectedTurnId,
                });
              },
            });
            if (maybe && typeof (maybe as Promise<void>).then === "function") {
              void (maybe as Promise<void>).catch(() => {});
            }
          } catch {
            // best-effort cadence callback
          }
          if (interrupted) {
            break;
          }
        }
      } else if (ev.type === "done") {
        newThreadId = ev.threadId ?? newThreadId;
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      abortError = true;
      if (!interrupted) {
        interrupted = true;
      }
      if (!interruptionReason) {
        interruptionReason = abortedBySupervisor ? "interrupted" : "stop_requested";
      }
      ctx.sendNotification({
        method: "conversation.status",
        params: { message: abortedBySupervisor ? "agent interrupted" : "agent stopped" },
      });
    } else {
      const msg = `agent error: ${err?.message ?? String(err)}`;
      ctx.sendNotification({ method: "conversation.status", params: { message: msg } });
      hadError = true;
      errorMessage = msg;
    }
  }

  if (abortError) {
    hadError = false;
  }

  if (!assistantFinal && assistantText.trim()) {
    const inlineCalls = extractInlineToolCalls(assistantText);
    if (inlineCalls) {
      toolCalls = inlineCalls;
      assistantFinal = true;
      for (const call of inlineCalls) {
        appendMarkdown(renderToolCall(call.name, call.body));
      }
    } else if (interrupted || hadError) {
      const md = renderChat("assistant", assistantText.trim(), { partial: "1" });
      appendMarkdown(md);
    } else {
      const md = renderChat("assistant", assistantText.trim());
      assistantFinal = true;
      appendMarkdown(md);
    }
  }

  if (interrupted && !assistantFinal && assistantText.trim()) {
    const reasonLabel =
      interruptionReason === "time_budget"
        ? "time budget reached"
        : interruptionReason === "token_budget"
          ? "token budget reached"
          : interruptionReason === "cadence_time"
            ? "cadence time reached"
          : interruptionReason === "cadence_tokens"
            ? "cadence token limit reached"
            : interruptionReason === "cadence_supervisor"
              ? "supervisor cadence decision"
              : interruptionReason === "stop_requested"
                ? "stop requested"
                : "interrupted";
    const note = `Reasoning: The previous response was interrupted (${reasonLabel}). Continue from the partial response above and resume the task.`;
    const md = renderChat("assistant", note, { interrupted: "1" });
    appendMarkdown(md);
  }

  const naturalEnd = !interrupted && !hadError;
  if (naturalEnd) {
    streamEnded = toolCalls && toolCalls.length ? false : true;
  }

  if (budget.timeBudgetMs && !budget.timeBudgetHit && Date.now() - budget.startedAt >= budget.timeBudgetMs) {
    budget.timeBudgetHit = true;
  }

  return {
    appended,
    assistantText,
    errorMessage,
    assistantFinal,
    toolCalls: toolCalls ?? undefined,
    providerToolEvents: providerToolEvents ?? undefined,
    hadError,
    interrupted,
    interruptionReason,
    abortedBySupervisor,
    abortError,
    streamEnded,
    usage,
    newThreadId,
    cadenceHit,
    cadenceReason,
    compactionDetected,
    compactionDetails,
  };
}
