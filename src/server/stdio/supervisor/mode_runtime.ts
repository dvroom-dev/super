import { renderChat } from "../../../markdown/render.js";
import type { ChatRole } from "../../../markdown/ast.js";
import { parseChatMarkdown } from "../../../markdown/parse.js";
import { promptContentToPlainText } from "../../../utils/prompt_content.js";
import type {
  RenderedRunConfigAgentRules,
  RenderedRunConfig,
  RenderedRunConfigMessage,
  RenderedRunConfigModeDefinition,
} from "../../../supervisor/run_config.js";

const SUPERVISOR_FIELD_TOKEN = /\{\{\s*supervisor\.([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g;
const MODE_PAYLOAD_FRONTMATTER_KEY = "mode_payload_b64";
const AGENT_RULE_SECTION_BEGIN = "<ai-supervisor-agent-rules id=\"initial-user-prompt\">";
const AGENT_RULE_SECTION_END = "</ai-supervisor-agent-rules>";
const AGENT_SYSTEM_SCOPE = "agent_base";

export function frontmatterValue(documentText: string, key: string): string | undefined {
  const lines = String(documentText ?? "").split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "---") break;
    const match = line.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)\\s*$`));
    if (!match) continue;
    return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

export function updateFrontmatterField(documentText: string, key: string, value: string): string {
  const lines = String(documentText ?? "").split(/\r?\n/);
  if (lines[0] !== "---") {
    return ["---", `${key}: ${value}`, "---", "", documentText.trim()].join("\n");
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    return ["---", `${key}: ${value}`, "---", "", documentText.trim()].join("\n");
  }
  const out: string[] = ["---"];
  let found = false;
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (line.match(new RegExp(`^\\s*${key}\\s*:`))) {
      out.push(`${key}: ${value}`);
      found = true;
      continue;
    }
    out.push(line);
  }
  if (!found) out.push(`${key}: ${value}`);
  out.push("---", ...lines.slice(end + 1));
  return out.join("\n");
}

export function resolveInitialMode(config: RenderedRunConfig | null): string {
  if (config?.modesEnabled === false) return "base";
  const configured = config?.modeStateMachine?.initialMode?.trim();
  if (configured) return configured;
  const firstMode = Object.keys(config?.modes ?? {})[0];
  if (firstMode) return firstMode;
  return "default";
}

export function resolveActiveMode(documentText: string, config: RenderedRunConfig | null): string {
  const fromDocument = frontmatterValue(documentText, "mode")?.trim();
  if (fromDocument) return fromDocument;
  return resolveInitialMode(config);
}

export function resolveModeConfig(config: RenderedRunConfig | null, mode: string): RenderedRunConfigModeDefinition | undefined {
  if (config?.modesEnabled === false) return undefined;
  if (!config?.modes) return undefined;
  return config.modes[mode];
}

export function resolveModeReasoningEfforts(args: {
  modeConfig?: RenderedRunConfigModeDefinition;
  defaultAgentReasoningEffort?: string;
  defaultSupervisorReasoningEffort?: string;
}): { agentModelReasoningEffort?: string; supervisorModelReasoningEffort?: string } {
  return {
    agentModelReasoningEffort: args.modeConfig?.agentModelReasoningEffort ?? args.defaultAgentReasoningEffort,
    supervisorModelReasoningEffort:
      args.modeConfig?.supervisorModelReasoningEffort ?? args.defaultSupervisorReasoningEffort,
  };
}

export function extractSupervisorTemplateFields(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of String(text ?? "").matchAll(SUPERVISOR_FIELD_TOKEN)) {
    const field = String(match[1] ?? "").trim();
    if (!field || seen.has(field)) continue;
    seen.add(field);
    out.push(field);
  }
  return out;
}

export function modePayloadFieldsForMode(
  config: RenderedRunConfig | null,
  mode: string,
): string[] {
  const definition = resolveModeConfig(config, mode);
  if (!definition) return [];
  const out = [
    ...extractSupervisorTemplateFields(definition.systemMessage?.text ?? ""),
    ...extractSupervisorTemplateFields(definition.userMessage?.text ?? ""),
  ];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of out) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

export function modePayloadFieldsByMode(
  config: RenderedRunConfig | null,
  modes: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const mode of modes) {
    out[mode] = modePayloadFieldsForMode(config, mode);
  }
  return out;
}

export type ModeCriteria = {
  description?: string;
  startWhen?: string[];
  stopWhen?: string[];
};

export function modeGuidanceByMode(
  config: RenderedRunConfig | null,
  modes: string[],
  currentMode?: string,
): Record<string, ModeCriteria> {
  const modeSet = new Set<string>(modes);
  if (currentMode) modeSet.add(currentMode);
  const out: Record<string, ModeCriteria> = {};
  for (const mode of modeSet) {
    const definition = resolveModeConfig(config, mode);
    out[mode] = {
      description: definition?.description?.trim() || undefined,
      startWhen: definition?.startWhen?.map((entry) => String(entry ?? "").trim()).filter(Boolean) ?? [],
      stopWhen: definition?.stopWhen?.map((entry) => String(entry ?? "").trim()).filter(Boolean) ?? [],
    };
  }
  return out;
}

export function applySupervisorTemplateFields(
  text: string,
  payload?: Record<string, string>,
): string {
  const values = payload ?? {};
  return String(text ?? "").replaceAll(SUPERVISOR_FIELD_TOKEN, (_match, rawField) => {
    const field = String(rawField ?? "").trim();
    if (!field) return "";
    return values[field] ?? "";
  });
}

export function applySupervisorTemplateFieldsToMessage(
  message: RenderedRunConfigMessage | undefined,
  payload?: Record<string, string>,
): RenderedRunConfigMessage | undefined {
  if (!message) return undefined;
  const content = message.content.map((part) =>
    part.type === "text"
      ? { ...part, text: applySupervisorTemplateFields(part.text, payload) }
      : part
  );
  return {
    ...message,
    text: promptContentToPlainText(content),
    content,
  };
}

export function modeTransitionAllowed(args: {
  config: RenderedRunConfig | null;
  fromMode: string;
  toMode: string;
}): boolean {
  if (args.fromMode === args.toMode) return true;
  const transitions = args.config?.modeStateMachine?.transitions;
  if (!transitions) return true;
  const allowed = transitions[args.fromMode];
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return allowed.includes(args.toMode);
}

export function mergeRuleLists(globalRules: string[], modeRules: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rule of [...globalRules, ...(modeRules ?? [])]) {
    const normalized = String(rule ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeList(values?: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function mergeAgentRuleSet(args: {
  requestRequirements?: string[];
  configured?: RenderedRunConfigAgentRules;
}): RenderedRunConfigAgentRules {
  return {
    requirements: normalizeList([...(args.requestRequirements ?? []), ...(args.configured?.requirements ?? [])]),
    violations: normalizeList(args.configured?.violations),
  };
}

export function appendAgentRulesToInitialUserMessage(args: {
  userMessage: string;
  requirements?: string[];
  violations?: string[];
}): string {
  const message = String(args.userMessage ?? "").trim();
  const requirements = normalizeList(args.requirements);
  const violations = normalizeList(args.violations);
  if (!requirements.length && !violations.length) return message;
  const section = [
    AGENT_RULE_SECTION_BEGIN,
    requirements.length
      ? ["Requirements (must always be followed):", ...requirements.map((rule) => `- ${rule}`)].join("\n")
      : "Requirements (must always be followed): (none)",
    "",
    violations.length
      ? [
          "Violation triggers (if violated, supervisor should fork a new conversation and steer away from the violated behavior):",
          ...violations.map((rule) => `- ${rule}`),
        ].join("\n")
      : "Violation triggers: (none)",
    AGENT_RULE_SECTION_END,
  ].join("\n");
  return [message, section].filter(Boolean).join("\n\n");
}

export function mergeInstructionLists(globalInstructions: string[], modeInstructions: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const instruction of [...globalInstructions, ...(modeInstructions ?? [])]) {
    const normalized = String(instruction ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function appendChatMessage(
  documentText: string,
  role: ChatRole,
  message: string,
): string {
  const content = String(message ?? "").trim();
  if (!content) return documentText;
  const block = renderChat(role, content);
  const trimmed = String(documentText ?? "").trimEnd();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

export function appendUserMessage(documentText: string, userMessage: string): string {
  return appendChatMessage(documentText, "user", userMessage);
}

export function hasLeadingSystemMessage(documentText: string): boolean {
  const parsed = parseChatMarkdown(String(documentText ?? ""));
  const first = parsed.blocks[0] as any;
  return first?.kind === "chat" && first?.role === "system";
}

function encodeModePayload(payload: Record<string, string> | undefined): string {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    const k = String(key ?? "").trim();
    const v = String(value ?? "").trim();
    if (!k || !v) continue;
    cleaned[k] = v;
  }
  const json = JSON.stringify(cleaned);
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeModePayload(encoded: string | undefined): Record<string, string> {
  const value = String(encoded ?? "").trim();
  if (!value) return {};
  try {
    const raw = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const k = String(key ?? "").trim();
      const v = String(entry ?? "").trim();
      if (!k || !v) continue;
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveModePayload(documentText: string): Record<string, string> {
  return decodeModePayload(frontmatterValue(documentText, MODE_PAYLOAD_FRONTMATTER_KEY));
}

export function updateFrontmatterModePayload(
  documentText: string,
  payload?: Record<string, string>,
): string {
  const encoded = encodeModePayload(payload);
  if (!encoded) return documentText;
  return updateFrontmatterField(
    documentText,
    MODE_PAYLOAD_FRONTMATTER_KEY,
    encoded,
  );
}

export function buildFreshModeDocument(args: {
  conversationId: string;
  forkId: string;
  mode: string;
  processStage?: string;
  taskProfile?: string;
  systemMessage?: string;
  userMessage: string;
  modePayload?: Record<string, string>;
  agentRuleRequirements?: string[];
  agentRuleViolations?: string[];
}): string {
  const encodedPayload = encodeModePayload(args.modePayload);
  const userMessage = appendAgentRulesToInitialUserMessage({
    userMessage: args.userMessage,
    requirements: args.agentRuleRequirements,
    violations: args.agentRuleViolations,
  });
  return [
    "---",
    `conversation_id: ${args.conversationId}`,
    `fork_id: ${args.forkId}`,
    `mode: ${args.mode}`,
    ...(String(args.processStage ?? "").trim() ? [`process_stage: ${String(args.processStage).trim()}`] : []),
    ...(String(args.taskProfile ?? "").trim() ? [`task_profile: ${String(args.taskProfile).trim()}`] : []),
    ...(encodedPayload ? [`${MODE_PAYLOAD_FRONTMATTER_KEY}: ${encodedPayload}`] : []),
    "---",
    "",
    ...(String(args.systemMessage ?? "").trim() ? [renderChat("system", String(args.systemMessage).trim(), { scope: AGENT_SYSTEM_SCOPE }), ""] : []),
    renderChat("user", userMessage),
  ].join("\n");
}
