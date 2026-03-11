import type { SupervisorConfig } from "./types.js";
import { systemMessageForModel } from "../../supervisor/system_message.js";
import { toolDefinitionsMarkdown } from "../../tools/definitions.js";

export function normalizeRules(raw: any): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x)).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === "string") {
    return raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*+]\s+/, "").trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeFileContexts(raw: any) {
  if (!Array.isArray(raw)) return [];
  const out: { path: string; kind: "file" | "dir" | "missing" | "error"; content: string; truncated?: boolean; error?: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = String((item as any).path ?? "");
    if (!p) continue;
    const kindRaw = String((item as any).kind ?? "file");
    const kind = kindRaw === "dir" || kindRaw === "missing" || kindRaw === "error" ? kindRaw : "file";
    const content = String((item as any).content ?? "");
    const truncated = Boolean((item as any).truncated ?? false);
    const err = (item as any).error;
    const error = err != null ? String(err) : undefined;
    out.push({
      path: p,
      kind: kind as "file" | "dir" | "missing" | "error",
      content,
      truncated: truncated || undefined,
      error,
    });
  }
  return out;
}

export function combineTranscript(documentText: string, appended: string[]): string {
  const parts: string[] = [];
  if (documentText.trim()) parts.push(documentText.trim(), "");
  for (const md of appended) {
    const trimmed = md.trim();
    if (trimmed) parts.push(trimmed, "");
  }
  return parts.join("\n").trim();
}

export function summarizeProviderItem(item: any): string {
  if (!item || typeof item !== "object") return "event";
  if (typeof item.summary === "string" && item.summary.trim()) return item.summary.trim();
  const type = item.type ?? item.kind ?? "event";
  const name = item.name ?? item.tool_name ?? item.tool ?? item.command;
  const status = item.status ? `status=${item.status}` : "";
  return [String(type), name ? String(name) : "", status].filter(Boolean).join(" ");
}

export function providerItemId(item: any, fallback?: string): string | undefined {
  const raw = fallback ?? item?.id ?? item?.item_id ?? item?.itemId ?? item?.itemID ?? item?.item?.id;
  if (!raw) return undefined;
  return String(raw);
}

export const summarizeCodexItem = summarizeProviderItem;
export const codexItemId = providerItemId;

export function parseJsonSafe(input: string): { ok: boolean; value: any } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false, value: undefined };
  }
}

export function detectStopReasons(args: {
  assistantText: string;
  usage: any;
  startedAt: number;
  supervisor: SupervisorConfig;
  hadError: boolean;
  timeBudgetHit?: boolean;
  tokenBudgetHit?: boolean;
  adjustedTokensUsed?: number;
  elapsedMs?: number;
}): string[] {
  const reasons: string[] = [];
  const elapsed = args.elapsedMs ?? Date.now() - args.startedAt;
  const usage = args.usage ?? {};

  if (args.timeBudgetHit || (args.supervisor.timeBudgetMs && elapsed >= args.supervisor.timeBudgetMs)) {
    reasons.push("time_budget");
  }
  if (
    args.tokenBudgetHit ||
    (args.supervisor.tokenBudgetAdjusted &&
      args.adjustedTokensUsed != null &&
      args.adjustedTokensUsed >= args.supervisor.tokenBudgetAdjusted)
  ) {
    reasons.push("token_budget");
  }
  if (args.hadError) reasons.push("error");
  if (args.supervisor.returnControlPattern) {
    const re = new RegExp(args.supervisor.returnControlPattern, "i");
    if (re.test(args.assistantText)) reasons.push("return_control");
  }
  return reasons;
}

export function describeStopReasons(args: {
  reasons: string[];
  usage: any;
  startedAt: number;
  supervisor: SupervisorConfig;
  hadError: boolean;
}): string[] {
  const out: string[] = [];
  const elapsed = Date.now() - args.startedAt;
  const usage = args.usage ?? {};
  for (const r of args.reasons) {
    if (r === "time_budget") {
      const ms = args.supervisor.timeBudgetMs ?? elapsed;
      const mins = Math.round(ms / 60000);
      out.push(`Time budget reached: ${mins} minutes`);
    } else if (r === "cadence_time") {
      const ms = args.supervisor.cadenceTimeMs ?? elapsed;
      const mins = Math.round(ms / 60000);
      out.push(`Cadence reached: ${mins} minutes`);
    } else if (r === "token_budget") {
      const limit = args.supervisor.tokenBudgetAdjusted ?? 0;
      out.push(`Token budget reached: ${limit} adjusted tokens`);
    } else if (r === "cadence_tokens") {
      const limit = args.supervisor.cadenceTokensAdjusted ?? 0;
      out.push(`Cadence reached: ${limit} adjusted tokens`);
    } else if (r === "error") {
      out.push("Error during run");
    } else if (r === "interrupted") {
      out.push("Run interrupted");
    } else if (r === "return_control") {
      out.push("Return control pattern matched");
    } else if (r === "agent_stop") {
      out.push("Agent stopped");
    } else {
      out.push(r);
    }
  }
  return out;
}

export function systemMessage(model?: string): { message: string; source: string } {
  return systemMessageForModel(model);
}

export function adjustedTokenUsage(args: {
  outputTokens: number;
  model?: string;
  pricing?: SupervisorConfig["pricing"];
}): {
  adjustedTokens: number;
  multiplier: number;
  modelCost?: number;
  minCost?: number;
  cheapestModel?: string;
} {
  const outputTokens = Math.max(0, args.outputTokens || 0);
  const pricing = args.pricing?.outputUsdPerMillion ?? {};
  const entries = Object.entries(pricing).filter(([, v]) => typeof v === "number" && v > 0);
  if (entries.length === 0) {
    return { adjustedTokens: outputTokens, multiplier: 1 };
  }
  let minCost = Number.POSITIVE_INFINITY;
  let cheapestModel: string | undefined = undefined;
  for (const [name, cost] of entries) {
    if (cost < minCost) {
      minCost = cost;
      cheapestModel = name;
    }
  }
  const modelKey = (args.model ?? "").trim();
  const modelCost = pricing[modelKey];
  if (!modelCost || !minCost || !isFinite(minCost)) {
    return { adjustedTokens: outputTokens, multiplier: 1, minCost, cheapestModel };
  }
  const multiplier = modelCost / minCost;
  return { adjustedTokens: outputTokens * multiplier, multiplier, modelCost, minCost, cheapestModel };
}

export { toolDefinitionsMarkdown };
