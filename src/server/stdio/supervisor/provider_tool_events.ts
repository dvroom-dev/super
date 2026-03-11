import type { ProviderEvent } from "../../../providers/types.js";
import type { InlineToolCall } from "./inline_tools.js";

export type ProviderToolInterceptionEvent = {
  when: "invocation" | "response";
  toolName: string;
  args: Record<string, unknown>;
  outputText?: string;
};

const RUNTIME_INLINE_PROVIDER_TOOLS = new Set(["switch_mode", "check_supervisor", "check_rules"]);

function normalizeRuntimeInlineToolName(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return "";
  const mcpPrefix = "mcp__super_custom_tools__";
  if (trimmed.startsWith(mcpPrefix)) {
    return trimmed.slice(mcpPrefix.length).trim();
  }
  return trimmed;
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // ignored: fallback to empty args
  }
  return {};
}

type ProviderToolSignal =
  | { kind: "call"; id?: string; name: string; args: Record<string, unknown> }
  | { kind: "result"; id?: string; name?: string; outputText: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function pickText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => pickText(entry)).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["stdout", "stderr", "text", "content", "result", "error", "message", "output"]) {
    const text = pickText(record[key]);
    if (text) return text;
  }
  return "";
}

function extractProviderToolSignals(event: ProviderEvent): ProviderToolSignal[] {
  if (event.type !== "provider_item") return [];
  const out: ProviderToolSignal[] = [];
  const raw = asRecord(event.raw);
  if (raw) {
    const rawType = (asString(raw.type) ?? "").toLowerCase();
    if (rawType === "assistant") {
      const message = asRecord(raw.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        const toolUse = asRecord(block);
        if (!toolUse || String(toolUse.type ?? "").trim() !== "tool_use") continue;
        const name = asString(toolUse.name);
        if (!name) continue;
        out.push({ kind: "call", id: asString(toolUse.id), name, args: parseToolArgs(toolUse.input) });
      }
      if (out.length > 0) return out;
    }
    if (rawType === "user") {
      const message = asRecord(raw.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        const toolResult = asRecord(block);
        if (!toolResult || String(toolResult.type ?? "").trim() !== "tool_result") continue;
        out.push({
          kind: "result",
          id: asString(toolResult.tool_use_id) ?? asString(toolResult.toolUseId),
          outputText: pickText(toolResult.content),
        });
      }
      if (out.length > 0) return out;
    }
    const method = asString(raw.method);
    if (method === "item/started" || method === "item/completed") {
      const params = asRecord(raw.params);
      const rawItem = asRecord(params?.item) ?? asRecord(raw.item);
      if (rawItem) {
        const id = asString(rawItem.id) ?? asString(params?.itemId) ?? asString(params?.item_id);
        const name = asString(rawItem.name) ?? asString(rawItem.tool_name) ?? asString(rawItem.tool) ?? asString(rawItem.command) ?? asString(event.item.name);
        const args = parseToolArgs(rawItem.input ?? rawItem.args ?? rawItem.arguments ?? rawItem.parameters ?? rawItem.params);
        const outputText = pickText(rawItem.output ?? rawItem.result ?? rawItem.content ?? rawItem.error);
        const status = (asString(rawItem.status) ?? "").toLowerCase();
        const started = method === "item/started" || status.includes("progress") || status.includes("inprogress") || status.includes("in_");
        const completed = method === "item/completed" || status.includes("completed") || status.includes("done") || status.includes("failed") || status.includes("declined");
        if (name && started) out.push({ kind: "call", id, name, args });
        if (completed) {
          if (name) out.push({ kind: "call", id, name, args });
          out.push({ kind: "result", id, name, outputText });
        }
      }
      if (out.length > 0) return out;
    }
  }
  if (event.item.kind === "tool_call" && event.item.name) {
    out.push({ kind: "call", id: event.item.id, name: event.item.name, args: {} });
  } else if (event.item.kind === "tool_result" || event.item.kind === "tool_error") {
    out.push({ kind: "result", id: event.item.id, name: event.item.name, outputText: String(event.item.text ?? "") });
  }
  return out;
}

export function extractRuntimeInlineCallsFromProviderEvent(event: ProviderEvent): InlineToolCall[] {
  if (event.type !== "provider_item") return [];
  if (event.item.kind !== "tool_call") return [];
  const toolName = normalizeRuntimeInlineToolName(String(event.item.name ?? "").trim());
  if (!RUNTIME_INLINE_PROVIDER_TOOLS.has(toolName)) return [];
  const raw = event.raw as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return [];
  const type = String(raw.type ?? "").trim().toLowerCase();
  if (type === "assistant") {
    const message = raw.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const out: InlineToolCall[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const toolUse = block as Record<string, unknown>;
      if (String(toolUse.type ?? "").trim() !== "tool_use") continue;
      const name = normalizeRuntimeInlineToolName(String(toolUse.name ?? "").trim());
      if (!RUNTIME_INLINE_PROVIDER_TOOLS.has(name)) continue;
      const args = parseToolArgs(toolUse.input);
      out.push({ name, args, body: JSON.stringify(args, null, 2) });
    }
    if (out.length > 0) return out;
  }
  const params = raw.params && typeof raw.params === "object" ? raw.params as Record<string, unknown> : undefined;
  const rawItem = (params?.item && typeof params.item === "object" ? params.item : raw.item) as Record<string, unknown> | undefined;
  if (!rawItem) return [];
  const rawName = normalizeRuntimeInlineToolName(String(rawItem.name ?? rawItem.tool_name ?? rawItem.tool ?? "").trim());
  const name = rawName || toolName;
  if (!RUNTIME_INLINE_PROVIDER_TOOLS.has(name)) return [];
  const args = parseToolArgs(rawItem.input ?? rawItem.args ?? rawItem.arguments ?? rawItem.parameters ?? rawItem.params);
  return [{ name, args, body: JSON.stringify(args, null, 2) }];
}

type PendingProviderCall = { id?: string; name: string; args: Record<string, unknown> };

export function createProviderToolInterceptionEventCollector() {
  const pendingById = new Map<string, PendingProviderCall>();
  const pendingQueue: PendingProviderCall[] = [];
  const consumePending = (id?: string): PendingProviderCall | undefined => {
    if (id) {
      const call = pendingById.get(id);
      if (!call) return undefined;
      pendingById.delete(id);
      const idx = pendingQueue.findIndex((entry) => entry === call || (entry.id && entry.id === id));
      if (idx >= 0) pendingQueue.splice(idx, 1);
      return call;
    }
    const next = pendingQueue.shift();
    if (next?.id) pendingById.delete(next.id);
    return next;
  };

  return {
    collect(event: ProviderEvent): ProviderToolInterceptionEvent[] {
      const out: ProviderToolInterceptionEvent[] = [];
      for (const signal of extractProviderToolSignals(event)) {
        if (signal.kind === "call") {
          const name = String(signal.name ?? "").trim();
          if (!name) continue;
          const call: PendingProviderCall = { id: signal.id, name, args: signal.args ?? {} };
          out.push({ when: "invocation", toolName: call.name, args: call.args });
          if (call.id) pendingById.set(call.id, call);
          pendingQueue.push(call);
          continue;
        }
        const paired = consumePending(signal.id);
        const name = String(signal.name ?? paired?.name ?? "").trim();
        if (!name) continue;
        out.push({
          when: "response",
          toolName: name,
          args: paired?.args ?? {},
          outputText: String(signal.outputText ?? ""),
        });
      }
      return out;
    },
  };
}
