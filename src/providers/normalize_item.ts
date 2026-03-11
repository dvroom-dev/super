import type { NormalizedProviderItem, ProviderName } from "./types.js";

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function clip(text: string, max = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 1))}…`;
}

function pickText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const merged = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const obj = entry as Record<string, unknown>;
          return (
            pickText(obj.text) ??
            pickText(obj.content) ??
            pickText(obj.output) ??
            pickText(obj.result) ??
            ""
          );
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return merged.trim() ? merged : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const preferredKeys = [
    "aggregatedOutput",
    "aggregated_output",
    "output",
    "content",
    "result",
    "review",
    "stderr",
    "stdout",
    "text",
    "delta",
    "summary",
    "message",
    "error",
  ];
  for (const key of preferredKeys) {
    const text = pickText(obj[key]);
    if (text) return text;
  }
  return undefined;
}

function compactDetails(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      out[key] = clip(trimmed, 240);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const compact = value
        .map((entry) => (typeof entry === "string" ? clip(entry, 80) : ""))
        .filter(Boolean);
      if (compact.length > 0) out[key] = compact.slice(0, 12);
      continue;
    }
    if (typeof value === "object") {
      try {
        out[key] = clip(JSON.stringify(value), 240);
      } catch {
        // ignore unserializable details
      }
    }
  }
  return out;
}

function summaryFromParts(parts: Array<string | undefined>, fallback: string): string {
  const value = parts.map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
  return value || fallback;
}

function normalizeCodexKind(item: any): NormalizedProviderItem["kind"] {
  const type = String(item?.type ?? item?.kind ?? "").toLowerCase();
  const status = String(item?.status ?? "").toLowerCase();
  if (type.includes("error") || item?.error) return "tool_error";
  if (type.includes("reasoning")) return "assistant_meta";
  if (type.includes("agentmessage") || type.includes("agent_message")) return "assistant_meta";
  if (type.includes("toolcall") || type.includes("tool_call")) {
    if (status.includes("fail")) return "tool_error";
    if (status.includes("progress") || status.includes("in_")) return "tool_call";
    return "tool_result";
  }
  if (type.includes("commandexecution") || type.includes("command")) {
    if (status.includes("progress") || status.includes("in_")) return "tool_call";
    if (status.includes("declined") || status.includes("fail")) return "tool_error";
    return "tool_result";
  }
  if (type.includes("filechange") || type.includes("file_change")) {
    if (status.includes("progress") || status.includes("in_")) return "tool_call";
    if (status.includes("declined") || status.includes("fail")) return "tool_error";
    return "tool_result";
  }
  if (type.includes("tool_result")) return "tool_result";
  if (type.includes("item.started")) return "tool_call";
  if (type.includes("status")) return "status";
  return "other";
}

export function normalizeCodexItem(item: any): NormalizedProviderItem {
  const type = asString(item?.type) ?? asString(item?.kind) ?? "event";
  const id = asString(item?.id) ?? asString(item?.item_id) ?? asString(item?.itemId);
  const name = asString(item?.name) ?? asString(item?.tool_name) ?? asString(item?.tool) ?? asString(item?.command);
  const status = asString(item?.status);
  const text = pickText(item);
  const kind = normalizeCodexKind(item);
  const isReasoning = kind === "assistant_meta" && type.toLowerCase().includes("reasoning");
  const includeInTranscript = kind === "tool_result" || kind === "tool_error" || kind === "tool_call" || isReasoning;
  const details = compactDetails({
    command: item?.command,
    exit_code: item?.exit_code ?? item?.exitCode,
    status,
    error: item?.error?.message ?? item?.error,
    tool_name: item?.tool_name ?? item?.tool,
    duration_ms: item?.duration_ms ?? item?.durationMs,
    server: item?.server,
    query: item?.query,
  });
  return {
    id,
    provider: "codex",
    kind,
    type,
    name,
    status,
    summary: summaryFromParts([kind, type, name, status], "event"),
    text,
    details: Object.keys(details).length ? details : undefined,
    includeInTranscript,
  };
}

function normalizeClaudeToolInput(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const keys = Object.keys(input as Record<string, unknown>);
  if (keys.length === 0) return undefined;
  return { keys: keys.slice(0, 16) };
}

export function normalizeClaudeAssistantMessage(message: any): NormalizedProviderItem | null {
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolUses = content.filter((block: any) => block?.type === "tool_use");
  if (toolUses.length === 0) return null;
  const names = toolUses.map((block: any) => String(block?.name ?? "tool")).filter(Boolean);
  const details = compactDetails({
    tools: names,
    first_tool_input: normalizeClaudeToolInput(toolUses[0]?.input),
    model: message?.model,
  });
  return {
    id: asString(message?.id),
    provider: "claude",
    kind: "tool_call",
    type: "assistant.tool_use",
    name: names[0],
    status: "emitted",
    summary: summaryFromParts(["tool_call", names[0], names.length > 1 ? `(+${names.length - 1})` : undefined], "tool_call"),
    details: Object.keys(details).length ? details : undefined,
    includeInTranscript: true,
  };
}

export function normalizeClaudeReasoningMessage(message: any): NormalizedProviderItem | null {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts: string[] = [];
  let redacted = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = String((block as any).type ?? "");
    if (type === "redacted_thinking") {
      redacted = true;
      continue;
    }
    if (type !== "thinking" && type !== "reasoning") continue;
    const text = asString((block as any).thinking) ?? asString((block as any).text);
    if (text) parts.push(text);
  }
  if (parts.length === 0 && !redacted) return null;
  const text = parts.join("\n\n").trim() || (redacted ? "[redacted_thinking]" : "");
  const details = compactDetails({ redacted_thinking: redacted || undefined });
  return {
    id: asString(message?.id),
    provider: "claude",
    kind: "assistant_meta",
    type: "assistant.reasoning",
    summary: summaryFromParts(["assistant_reasoning", redacted ? "redacted" : undefined], "assistant_reasoning"),
    text,
    details: Object.keys(details).length ? details : undefined,
    includeInTranscript: true,
  };
}

export function normalizeClaudeUserMessage(message: any): NormalizedProviderItem[] {
  const out: NormalizedProviderItem[] = [];
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "tool_result") continue;
    const toolUseId = asString((block as any).tool_use_id) ?? asString((block as any).toolUseId);
    const isError = Boolean((block as any).is_error ?? false);
    const text = pickText((block as any).content) ?? "";
    out.push({
      id: toolUseId,
      provider: "claude",
      kind: isError ? "tool_error" : "tool_result",
      type: "tool_result",
      name: "tool_result",
      status: isError ? "error" : "completed",
      summary: summaryFromParts(
        [isError ? "tool_error" : "tool_result", toolUseId, text ? clip(text.split(/\r?\n/, 1)[0] ?? "", 120) : undefined],
        isError ? "tool_error" : "tool_result",
      ),
      text: text || undefined,
      details: compactDetails({
        tool_use_id: toolUseId,
        is_error: isError || undefined,
        numLines: (block as any).numLines,
        totalLines: (block as any).totalLines,
      }),
      includeInTranscript: true,
    });
  }
  return out;
}

export function normalizeClaudeGenericEvent(message: any): NormalizedProviderItem | null {
  const type = asString(message?.type) ?? "event";
  if (type === "system" || type === "auth_status") {
    const details = compactDetails({
      subtype: message?.subtype,
      status: message?.status,
      output: message?.output,
    });
    return {
      id: asString(message?.uuid),
      provider: "claude",
      kind: "system",
      type,
      summary: summaryFromParts(["system", asString(message?.subtype), asString(message?.status)], "system"),
      details: Object.keys(details).length ? details : undefined,
      includeInTranscript: false,
    };
  }
  const details = compactDetails({
    subtype: message?.subtype,
    status: message?.status,
  });
  return {
    id: asString(message?.uuid),
    provider: "claude",
    kind: "other",
    type,
    summary: summaryFromParts(["claude", type, asString(message?.subtype)], "claude event"),
    details: Object.keys(details).length ? details : undefined,
    includeInTranscript: false,
  };
}

export function normalizeProviderFallback(provider: ProviderName, item: any, reason = "event"): NormalizedProviderItem {
  const text = pickText(item);
  return {
    id: asString(item?.id) ?? undefined,
    provider,
    kind: "other",
    type: reason,
    summary: summaryFromParts([provider, reason], "event"),
    text,
    includeInTranscript: false,
  };
}
