import { parseChatMarkdown } from "../markdown/parse.js";
import type { ProviderName } from "../providers/types.js";
import { systemMessageForProvider } from "./system_message.js";
import {
  extractPromptImagePartsFromMarkdown,
  promptContentToMarkdown,
  type PromptContent,
  type PromptImagePart,
} from "../utils/prompt_content.js";

export const CONFIG_SYSTEM_APPEND_BEGIN = "<ai-supervisor-system-append id=\"config\">";
export const CONFIG_SYSTEM_APPEND_END = "</ai-supervisor-system-append>";
export const AGENT_RULES_SYSTEM_BEGIN = "<ai-supervisor-agent-rules id=\"rules\">";
export const AGENT_RULES_SYSTEM_END = "</ai-supervisor-agent-rules>";

type SystemMessageOverrideLike = {
  operation?: "append" | "replace";
  text?: string;
  content?: PromptContent;
};

function normalizeList(values?: string[]): string[] {
  if (!values || values.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripConfigSystemAppendBlock(text: string): string {
  const blockPattern = new RegExp(
    `${escapeRegex(CONFIG_SYSTEM_APPEND_BEGIN)}[\\s\\S]*?${escapeRegex(CONFIG_SYSTEM_APPEND_END)}\\n?`,
    "g",
  );
  return text.replace(blockPattern, "").trimEnd();
}

function stripAgentRulesSystemBlock(text: string): string {
  const blockPattern = new RegExp(
    `${escapeRegex(AGENT_RULES_SYSTEM_BEGIN)}[\\s\\S]*?${escapeRegex(AGENT_RULES_SYSTEM_END)}\\n?`,
    "g",
  );
  return text.replace(blockPattern, "").trimEnd();
}

function normalizeOverrideMode(raw: "append" | "replace" | undefined): "append" | "replace" {
  return raw === "replace" ? "replace" : "append";
}

function configuredSystemText(configured?: SystemMessageOverrideLike): string | undefined {
  if (!configured) return undefined;
  if (Array.isArray(configured.content) && configured.content.length > 0) {
    return promptContentToMarkdown(configured.content).trim();
  }
  return String(configured.text ?? "");
}

export function resolveSystemMessage(
  baseMessage: string,
  configured?: { operation?: "append" | "replace"; text?: string },
): string {
  if (!configured) return baseMessage;
  const mode = normalizeOverrideMode(configured.operation);
  const custom = String(configured.text ?? "");
  if (mode === "replace") return custom;
  const baseWithoutConfigAppend = stripConfigSystemAppendBlock(baseMessage);
  const trimmed = custom.trim();
  if (!trimmed) return baseWithoutConfigAppend;
  return [baseWithoutConfigAppend, "", CONFIG_SYSTEM_APPEND_BEGIN, trimmed, CONFIG_SYSTEM_APPEND_END].join("\n");
}

export function injectAgentRulesIntoSystemMessage(systemMessage: string, rules: string[]): string {
  const cleaned = stripAgentRulesSystemBlock(systemMessage);
  const normalizedRules = normalizeList(rules);
  if (!normalizedRules.length) return cleaned;
  return [
    cleaned,
    "",
    AGENT_RULES_SYSTEM_BEGIN,
    ["Agent Rules:", ...normalizedRules.map((rule) => `- ${rule}`)].join("\n"),
    AGENT_RULES_SYSTEM_END,
  ].join("\n");
}

export function buildDurableAgentSystemPrompt(args: {
  provider?: ProviderName;
  model?: string;
  defaultSystemMessage?: string;
  configuredSystemMessage?: SystemMessageOverrideLike;
  agentRules?: string[];
}): string {
  const providerBase = systemMessageForProvider(args.provider, args.model).message.trim();
  const defaultText = String(args.defaultSystemMessage ?? "").trim();
  const configuredText = String(configuredSystemText(args.configuredSystemMessage) ?? "").trim();
  const configuredMode = normalizeOverrideMode(args.configuredSystemMessage?.operation);
  const configurableLayer = configuredText
    ? (configuredMode === "replace"
      ? configuredText
      : [defaultText, configuredText].filter(Boolean).join("\n\n"))
    : defaultText;
  const combinedBase = [providerBase, configurableLayer].filter(Boolean).join("\n\n");
  return injectAgentRulesIntoSystemMessage(
    combinedBase,
    normalizeList(args.agentRules),
  );
}

export function extractLeadingSystemPromptFromTranscript(args: {
  documentText: string;
  workspaceRoot?: string;
}): {
  systemText?: string;
  transcriptText: string;
  systemImages: PromptImagePart[];
} {
  const parsed = parseChatMarkdown(args.documentText);
  const leadingSystemBlocks: any[] = [];
  for (const block of parsed.blocks as any[]) {
    if (block.kind === "chat" && block.role === "system") {
      leadingSystemBlocks.push(block);
      continue;
    }
    break;
  }
  if (leadingSystemBlocks.length === 0) {
    return { systemText: undefined, transcriptText: args.documentText, systemImages: [] };
  }

  const lines = args.documentText.split(/\r?\n/);
  const firstStart = leadingSystemBlocks[0]?.startLine;
  const lastEnd = leadingSystemBlocks[leadingSystemBlocks.length - 1]?.endLine;
  if (!Number.isFinite(firstStart) || !Number.isFinite(lastEnd)) {
    return { systemText: undefined, transcriptText: args.documentText, systemImages: [] };
  }

  const systemText = leadingSystemBlocks
    .map((block) => String(block.content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  const transcriptText = lines
    .slice(0, firstStart)
    .concat(lines.slice(lastEnd + 1))
    .join("\n")
    .trim();
  return {
    systemText,
    transcriptText,
    systemImages: extractPromptImagePartsFromMarkdown(systemText, args.workspaceRoot),
  };
}
