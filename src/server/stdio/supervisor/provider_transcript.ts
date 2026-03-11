import { renderToolCall, renderToolResult } from "../../../markdown/render.js";
import type { NormalizedProviderItem } from "../../../providers/types.js";
import { renderOffloadedToolOutputReference } from "../tool_output.js";

function safeName(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "tool";
  const safe = value.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.:-]/g, "_");
  return safe || "tool";
}

function firstLine(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const line = input
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line || undefined;
}

function detailsValue(details: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!details) return undefined;
  const value = details[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function detailsNumber(details: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!details) return undefined;
  const value = Number(details[key]);
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function renderToolResultBody(item: NormalizedProviderItem): string {
  const details = item.details && typeof item.details === "object" ? (item.details as Record<string, unknown>) : undefined;
  const summary = item.summary.trim();
  const command = detailsValue(details, "command");
  const status = item.status ?? detailsValue(details, "status");
  const exitCode = detailsNumber(details, "exit_code");
  const output = (item.text ?? "").trim();
  const refs = Array.isArray(item.outputRefs) ? item.outputRefs : [];

  const lines: string[] = [];
  lines.push(`summary: ${summary}`);
  if (command) lines.push(`command: ${command}`);
  if (status) lines.push(`status: ${status}`);
  if (Number.isFinite(exitCode)) lines.push(`exit_code: ${String(exitCode)}`);

  if (output) {
    lines.push("");
    lines.push(output);
  } else {
    const hint = firstLine(detailsValue(details, "error"));
    if (hint && item.kind === "tool_error") {
      lines.push("");
      lines.push(`error: ${hint}`);
    }
  }

  if (refs.length > 0) {
    lines.push("");
    for (const ref of refs) {
      lines.push(renderOffloadedToolOutputReference(ref));
    }
  }

  return lines.join("\n");
}

function renderToolCallBody(item: NormalizedProviderItem): string {
  const details = item.details && typeof item.details === "object" ? (item.details as Record<string, unknown>) : undefined;
  const payload: Record<string, unknown> = {
    provider: item.provider,
    type: item.type ?? item.kind,
    summary: item.summary,
  };
  if (item.id) payload.id = item.id;
  if (item.status) payload.status = item.status;
  if (details && Object.keys(details).length > 0) payload.details = details;
  return JSON.stringify(payload, null, 2);
}

export function renderProviderItemForTranscript(item: NormalizedProviderItem): string | null {
  if (item.includeInTranscript === false) return null;
  if (item.kind === "assistant_meta") {
    const content = (item.text ?? "").trim();
    if (!content) return null;
    const callBody = JSON.stringify(
      {
        provider: item.provider,
        type: item.type ?? item.kind,
        id: item.id ?? null,
      },
      null,
      2,
    );
    const call = renderToolCall("reasoning_snapshot", callBody, { source: "provider", provider: item.provider });
    const result = renderToolResult([`(ok=true)`, content].join("\n"), { source: "provider", provider: item.provider });
    return [call, result].join("\n\n");
  }
  if (item.kind === "tool_call") {
    const name = safeName(item.name ?? item.type ?? "tool");
    return renderToolCall(name, renderToolCallBody(item), { source: "provider", provider: item.provider });
  }
  if (item.kind === "tool_result" || item.kind === "tool_error") {
    return renderToolResult(renderToolResultBody(item), { source: "provider", provider: item.provider });
  }
  return null;
}
