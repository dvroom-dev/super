import { AnyBlock } from "./ast.js";

function attrsToInfo(kind: string, attrs: Record<string, string>): string {
  const parts: string[] = [kind];
  for (const [k, v] of Object.entries(attrs)) {
    parts.push(`${k}=${v}`);
  }
  return parts.join(" ");
}

function fenceMarkerForContent(content: string): string {
  const raw = String(content ?? "");
  const matches = raw.match(/`+/g) ?? [];
  let longest = 0;
  for (const run of matches) {
    if (run.length > longest) longest = run.length;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

export function renderFence(kind: string, attrs: Record<string, string>, content: string): string {
  const info = attrsToInfo(kind, attrs);
  const marker = fenceMarkerForContent(content ?? "");
  return [marker + info, content ?? "", marker, ""].join("\n");
}

export function renderChat(role: string, content: string, extraAttrs: Record<string, string> = {}): string {
  return renderFence("chat", { role, ...extraAttrs }, content);
}

export function renderToolCall(name: string, jsonBody: string, extraAttrs: Record<string, string> = {}): string {
  return renderFence("tool_call", { name, ...extraAttrs }, jsonBody);
}

export function renderToolResult(content: string, extraAttrs: Record<string, string> = {}): string {
  return renderFence("tool_result", { ...extraAttrs }, content);
}

export function renderCandidates(models: string[], content: string, extraAttrs: Record<string, string> = {}): string {
  return renderFence("assistant_candidates", { models: models.join(","), ...extraAttrs }, content);
}

export function renderSupervisorReview(content: string, extraAttrs: Record<string, string> = {}): string {
  return renderFence("supervisor_review", { ...extraAttrs }, content);
}

export function renderSupervisorSummary(content: string, extraAttrs: Record<string, string> = {}): string {
  return renderFence("supervisor_summary", { ...extraAttrs }, content);
}

export function renderSupervisorWarning(content: string, extraAttrs: Record<string, string> = {}): string {
  return renderFence("supervisor_warning", { ...extraAttrs }, content);
}

export function renderSupervisorAction(content: string, extraAttrs: Record<string, string> = {}): string {
  return renderFence("supervisor_action", { ...extraAttrs }, content);
}

export function renderBlocks(blocks: AnyBlock[]): string {
  return blocks.map((b) => renderFence(b.kind, b.attrs, b.content)).join("\n");
}
