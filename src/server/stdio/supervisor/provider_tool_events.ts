import type { ProviderEvent } from "../../../providers/types.js";
import type { InlineToolCall } from "./inline_tools.js";
import { extractShellCommandText } from "../../../tools/shell_invocation_policy.js";

export type ProviderToolInterceptionEvent = {
  when: "invocation" | "response";
  toolName: string;
  args: Record<string, unknown>;
  outputText?: string;
};

const RUNTIME_INLINE_PROVIDER_TOOLS = new Set(["switch_mode", "check_supervisor", "check_rules", "certify_wrapup", "report_process_result"]);
const SWITCH_MODE_BASH_TOOL_NAMES = new Set(["bash", "shell"]);

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

function tokenizeShellCommand(commandText: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escape = false;
  for (const ch of String(commandText ?? "")) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch as "'" | "\"";
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function parseSwitchModeShellArgs(commandText: string): Record<string, unknown> | null {
  const tokens = tokenizeShellCommand(commandText);
  if (!tokens.length || tokens[0] !== "switch_mode") return null;
  const args: Record<string, unknown> = {};
  const modePayload: Record<string, unknown> = {};
  let positionalTarget: string | undefined;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token === "--target-mode" || token === "--target") {
      if (next) {
        args.target_mode = next;
        i += 1;
      }
      continue;
    }
    if (token === "--reason") {
      if (next) {
        args.reason = next;
        i += 1;
      }
      continue;
    }
    if (token === "--user-message") {
      if (next) {
        modePayload.user_message = next;
        i += 1;
      }
      continue;
    }
    if (token === "--mode-payload") {
      if (next) {
        const separator = next.indexOf("=");
        if (separator > 0) {
          const key = next.slice(0, separator).trim();
          const value = next.slice(separator + 1).trim();
          if (key && value) modePayload[key] = value;
        }
        i += 1;
      }
      continue;
    }
    if (token === "--terminal") {
      args.terminal = true;
      continue;
    }
    if (!token.startsWith("-") && !positionalTarget) {
      positionalTarget = token;
    }
  }
  if (!args.target_mode && positionalTarget) args.target_mode = positionalTarget;
  if (Object.keys(modePayload).length > 0) args.mode_payload = modePayload;
  args.terminal = true;
  return args;
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
        const fallbackName = asString(rawItem.name) ?? asString(rawItem.tool_name) ?? asString(rawItem.tool) ?? asString(rawItem.command) ?? asString(event.item.name);
        const commandText = extractShellCommandText(rawItem) ?? extractShellCommandText(params) ?? "";
        const switchModeArgs = fallbackName && SWITCH_MODE_BASH_TOOL_NAMES.has(fallbackName.toLowerCase())
          ? parseSwitchModeShellArgs(commandText)
          : null;
        const name = switchModeArgs ? "switch_mode" : fallbackName;
        const args = switchModeArgs ?? parseToolArgs(rawItem.input ?? rawItem.args ?? rawItem.arguments ?? rawItem.parameters ?? rawItem.params);
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
    const fallbackName = String(event.item.name ?? "");
    const commandText = extractShellCommandText((event.raw && typeof event.raw === "object") ? event.raw : undefined) ?? "";
    const switchModeArgs = SWITCH_MODE_BASH_TOOL_NAMES.has(fallbackName.toLowerCase())
      ? parseSwitchModeShellArgs(commandText)
      : null;
    out.push({ kind: "call", id: event.item.id, name: switchModeArgs ? "switch_mode" : fallbackName, args: switchModeArgs ?? {} });
  } else if (event.item.kind === "tool_result" || event.item.kind === "tool_error") {
    out.push({ kind: "result", id: event.item.id, name: event.item.name, outputText: String(event.item.text ?? "") });
  }
  return out;
}

export function extractRuntimeInlineCallsFromProviderEvent(event: ProviderEvent): InlineToolCall[] {
  if (event.type !== "provider_item") return [];
  if (event.item.kind !== "tool_call") return [];
  const toolName = normalizeRuntimeInlineToolName(String(event.item.name ?? "").trim());
  const raw = event.raw as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return [];
  if (SWITCH_MODE_BASH_TOOL_NAMES.has(toolName.toLowerCase())) {
    const type = String(raw.type ?? "").trim().toLowerCase();
    if (type === "assistant") {
      const message = raw.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      const out: InlineToolCall[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const toolUse = block as Record<string, unknown>;
        if (String(toolUse.type ?? "").trim() !== "tool_use") continue;
        const blockName = normalizeRuntimeInlineToolName(String(toolUse.name ?? "").trim());
        if (!SWITCH_MODE_BASH_TOOL_NAMES.has(blockName.toLowerCase())) continue;
        const commandText = extractShellCommandText(toolUse.input) ?? "";
        const args = parseSwitchModeShellArgs(commandText);
        if (!args) continue;
        const topLevelUserMessage =
          typeof (args.mode_payload as Record<string, unknown> | undefined)?.user_message === "string"
            ? String((args.mode_payload as Record<string, unknown>).user_message)
            : undefined;
        if (topLevelUserMessage) args.user_message = topLevelUserMessage;
        out.push({ name: "switch_mode", args, body: JSON.stringify(args, null, 2), source: "runtime_provider" });
      }
      if (out.length > 0) return out;
    }
    const params = raw.params && typeof raw.params === "object" ? raw.params as Record<string, unknown> : undefined;
    const rawItem = (params?.item && typeof params.item === "object" ? params.item : raw.item) as Record<string, unknown> | undefined;
    const commandText = extractShellCommandText(rawItem) ?? extractShellCommandText(params) ?? "";
    const args = parseSwitchModeShellArgs(commandText);
    if (args) {
      const topLevelUserMessage =
        typeof (args.mode_payload as Record<string, unknown> | undefined)?.user_message === "string"
          ? String((args.mode_payload as Record<string, unknown>).user_message)
          : undefined;
      if (topLevelUserMessage) args.user_message = topLevelUserMessage;
      return [{ name: "switch_mode", args, body: JSON.stringify(args, null, 2), source: "runtime_provider" }];
    }
    return [];
  }
  if (!RUNTIME_INLINE_PROVIDER_TOOLS.has(toolName)) return [];
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
      out.push({ name, args, body: JSON.stringify(args, null, 2), source: "runtime_provider" });
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
  return [{ name, args, body: JSON.stringify(args, null, 2), source: "runtime_provider" }];
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
