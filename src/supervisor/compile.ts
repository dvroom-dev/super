import fs from "node:fs";
import path from "node:path";
import { parseChatMarkdown } from "../markdown/parse.js";
import { systemMessageForModel } from "./system_message.js";
import type { SkillInstruction, SkillMetadata } from "../skills/types.js";
import { renderSkillsSection } from "../skills/loader.js";
import type { SupervisorTriggerKind } from "./review_schema.js";
import { loadPromptTemplate, renderPromptTemplate } from "./prompt_templates.js";
import type { ContextManagementStrategy } from "./context_management.js";
import { buildModeContractJson, type SupervisorModeGuidance } from "./compile_mode_contract.js";
import { appendAgentModeContext } from "./compile_agent_mode_context.js";
import type { ProviderFilesystemPolicy } from "../providers/filesystem_permissions.js";
import {
  appendSharedPromptContext,
  formatFileContexts,
  formatSkillInstructions,
  formatSkillsToInvoke,
  formatUtilities,
} from "./compile_context_sections.js";
import {
  dedupePromptImages,
  extractPromptImagePartsFromMarkdown,
  promptContentFromText,
  resolvePromptImagePath,
  type PromptContent,
  type PromptImagePart,
} from "../utils/prompt_content.js";
import {
  buildDurableAgentSystemPrompt,
  extractLeadingSystemPromptFromTranscript,
  resolveSystemMessage,
} from "./agent_system_prompt.js";
import type { ProviderName } from "../providers/types.js";
import { systemMessageForProvider } from "./system_message.js";
export {
  AGENT_RULES_SYSTEM_BEGIN,
  AGENT_RULES_SYSTEM_END,
  CONFIG_SYSTEM_APPEND_BEGIN,
  CONFIG_SYSTEM_APPEND_END,
  injectAgentRulesIntoSystemMessage,
  resolveSystemMessage,
} from "./agent_system_prompt.js";
export type TaggedFileContext = {
  path: string;
  kind: "file" | "dir" | "missing" | "error";
  content: string;
  truncated?: boolean;
  error?: string;
};

export type UtilityStatus = {
  name: string;
  command: string;
  available: boolean;
  path?: string;
};

export type PromptMessageOverride = {
  operation: "append" | "replace";
  text: string;
  images?: string[];
};

export const FULL_PROMPT_POSTLUDE = [
  "Authoritative transcript (Markdown). Continue from the last user message:",
  "",
  "{transcript}",
  "",
  "Return ONLY the next assistant message. If tool use is needed, use tools and then continue.",
].join("\n");

export const INCREMENTAL_PROMPT_PREFIX = "Continue the existing conversation thread.";

export const INCREMENTAL_PROMPT_POSTLUDE = ["User message:", "{last_user_message}"].join("\n");

export type CompileInputs = {
  documentText: string;
  workspaceRoot?: string;
  provider?: ProviderName;
  agentRules?: string[];
  currentMode?: string;
  allowedNextModes?: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  modeGuidanceByMode?: Record<string, SupervisorModeGuidance>;
  availableToolsMarkdown?: string;
  providerFilesystemPolicy?: ProviderFilesystemPolicy;
  model?: string;
  agentsMd?: string;
  workspaceListing?: string;
  taggedFiles?: TaggedFileContext[];
  openFiles?: TaggedFileContext[];
  utilities?: UtilityStatus[];
  skills?: SkillMetadata[];
  skillsToInvoke?: SkillMetadata[];
  skillInstructions?: SkillInstruction[];
  configuredSystemMessage?: PromptMessageOverride;
  defaultSystemMessage?: string;
};

export type SupervisorReviewInputs = {
  documentText: string;
  workspaceRoot?: string;
  provider?: ProviderName;
  agentRules?: string[];
  agentRuleViolations?: string[];
  supervisorInstructions?: string[];
  assistantText: string;
  stopReasons: string[];
  trigger: SupervisorTriggerKind;
  model?: string;
  mode?: "hard" | "soft";
  agentModel?: string;
  supervisorModel?: string;
  disableSyntheticCheckSupervisorOnRuleFailure?: boolean;
  agentsMd?: string;
  workspaceListing?: string;
  taggedFiles?: TaggedFileContext[];
  openFiles?: TaggedFileContext[];
  utilities?: UtilityStatus[];
  skills?: SkillMetadata[];
  skillsToInvoke?: SkillMetadata[];
  skillInstructions?: SkillInstruction[];
  configuredSystemMessage?: PromptMessageOverride;
  stopCondition?: string;
  currentMode?: string;
  allowedNextModes?: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  modeGuidanceByMode?: Record<string, SupervisorModeGuidance>;
  responseSchema: unknown;
  supervisorCarryover?: string;
};

export type GraceAssessmentInputs = {
  documentText: string;
  workspaceRoot?: string;
  provider?: ProviderName;
  agentRules?: string[];
  agentRuleViolations?: string[];
  supervisorInstructions?: string[];
  assistantText: string;
  graceMinutes: number;
  model?: string;
  agentsMd?: string;
  workspaceListing?: string;
  taggedFiles?: TaggedFileContext[];
  openFiles?: TaggedFileContext[];
  utilities?: UtilityStatus[];
  skills?: SkillMetadata[];
  skillsToInvoke?: SkillMetadata[];
  skillInstructions?: SkillInstruction[];
  configuredSystemMessage?: PromptMessageOverride;
  contextManagementStrategy?: ContextManagementStrategy;
};

const MODE_PAYLOAD_FRONTMATTER_KEY = "mode_payload_b64";
const ACTIVE_MODE_CONTRACT_PREVIEW_LIMIT = 4000;

function formatRules(title: string, rules: string[]): string {
  if (!rules.length) return `${title}: (none)`;
  return [title + ":", ...rules.map((r) => `- ${r}`)].join("\n");
}

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

export function resolveAgentRules(input: {
  agentRules?: string[];
}): string[] {
  return normalizeList(input.agentRules ?? []);
}

export function resolveAgentRuleViolations(input: {
  agentRuleViolations?: string[];
}): string[] {
  return normalizeList(input.agentRuleViolations ?? []);
}

export function resolveSupervisorInstructions(instructions?: string[]): string[] {
  return normalizeList(instructions ?? []);
}

function stripSupervisorBlocks(text: string): string {
  // supervisor_* blocks are UI/audit metadata and must never be sent back to the agent model.
  return text.replace(/```supervisor_[\s\S]*?```\n?/g, "").trim();
}

function frontmatterValue(documentText: string, key: string): string | undefined {
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

function resolveModePayloadFromDocument(documentText: string): Record<string, string> {
  const encoded = String(frontmatterValue(documentText, MODE_PAYLOAD_FRONTMATTER_KEY) ?? "").trim();
  if (!encoded) return {};
  try {
    const raw = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedKey = String(key ?? "").trim();
      const normalizedValue = String(value ?? "").trim();
      if (!normalizedKey || !normalizedValue) continue;
      out[normalizedKey] = normalizedValue;
    }
    return out;
  } catch {
    return {};
  }
}

function truncateContractText(text: string | undefined, maxChars = ACTIVE_MODE_CONTRACT_PREVIEW_LIMIT): string | undefined {
  const normalized = String(text ?? "").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 14)).trimEnd()}\n[truncated]`;
}

function hydrateBlobRefContent(text: string | undefined, workspaceRoot?: string): string | undefined {
  const normalized = String(text ?? "").trim();
  if (!normalized) return undefined;
  const blobRefMatch = normalized.match(/^summary:\s*\(see blob\)\s*\nblob_ref:\s*(.+)\s*(?:\nblob_bytes:\s*\d+)?$/m);
  if (!blobRefMatch) return normalized;
  const blobRef = String(blobRefMatch[1] ?? "").trim();
  if (!blobRef || !workspaceRoot) return normalized;
  const blobPath = path.resolve(workspaceRoot, blobRef);
  try {
    const blobText = fs.readFileSync(blobPath, "utf8").trim();
    return blobText || normalized;
  } catch {
    return normalized;
  }
}

function latestChatContentByRole(
  parsed: ReturnType<typeof parseChatMarkdown>,
  role: string,
  workspaceRoot?: string,
): string | undefined {
  for (let i = parsed.blocks.length - 1; i >= 0; i -= 1) {
    const block = parsed.blocks[i] as any;
    if (block?.kind !== "chat") continue;
    if (String(block.role ?? "").trim() !== role) continue;
    return hydrateBlobRefContent(String(block.content ?? "").trim(), workspaceRoot);
  }
  return undefined;
}

function appendActiveModeContract(promptParts: string[], input: CompileInputs, parsed: ReturnType<typeof parseChatMarkdown>): void {
  const currentMode = String(input.currentMode ?? frontmatterValue(input.documentText, "mode") ?? "").trim();
  const modePayload = resolveModePayloadFromDocument(input.documentText);
  const lastUserMessage = truncateContractText(latestChatContentByRole(parsed, "user", input.workspaceRoot));
  const lastSupervisorMessage = truncateContractText(latestChatContentByRole(parsed, "supervisor", input.workspaceRoot));
  const hasModePayload = Object.keys(modePayload).length > 0;
  if (!currentMode && !hasModePayload && !lastUserMessage && !lastSupervisorMessage) return;

  promptParts.push("Active Mode Contract (latest authoritative handoff):", "");
  if (currentMode) promptParts.push(`Current mode: ${currentMode}`);
  if (hasModePayload) {
    promptParts.push("Mode payload:", "```json", JSON.stringify(modePayload, null, 2), "```");
  }
  if (lastSupervisorMessage) {
    promptParts.push("Latest supervisor handoff:", "```text", lastSupervisorMessage, "```");
  }
  if (lastUserMessage) {
    promptParts.push("Latest user-mode handoff:", "```text", lastUserMessage, "```");
  }
  promptParts.push(
    "If older transcript content conflicts with this section, treat this section as the current contract for the next turn.",
    "",
  );
}

function normalizeConfiguredImages(images: string[] | undefined, workspaceRoot?: string): PromptImagePart[] {
  if (!Array.isArray(images) || images.length === 0) return [];
  return dedupePromptImages(
    images
      .map((imagePath) => String(imagePath ?? "").trim())
      .filter(Boolean)
      .map((imagePath) => ({
        type: "image" as const,
        path: resolvePromptImagePath(imagePath, workspaceRoot),
      }))
  );
}

function buildPromptContent(promptText: string, images: PromptImagePart[]): PromptContent {
  return [...promptContentFromText(promptText), ...dedupePromptImages(images)];
}

export function compileFullPrompt(input: CompileInputs): { prompt: PromptContent; promptText: string; lastUserText?: string; parseErrors: string[] } {
  const cleaned = stripSupervisorBlocks(input.documentText);
  const parsed = parseChatMarkdown(cleaned);
  const errs = parsed.errors.map((e) => `L${e.line}: ${e.message}`);
  const agents = input.agentsMd?.trim();
  const extracted = extractLeadingSystemPromptFromTranscript({ documentText: cleaned, workspaceRoot: input.workspaceRoot });
  const transcript = extracted.transcriptText;
  const system = extracted.systemText || buildDurableAgentSystemPrompt({
    provider: input.provider,
    model: input.model,
    defaultSystemMessage: input.defaultSystemMessage,
    configuredSystemMessage: input.configuredSystemMessage,
    agentRules: resolveAgentRules(input),
  });

  // Include the whole document as authoritative transcript (markdown-superset)
  const promptParts = [system, ""];

  if (agents) {
    promptParts.push(agents, "");
  }

  const skillsSection = renderSkillsSection(input.skills ?? []);
  if (skillsSection) {
    promptParts.push(skillsSection, "");
  }
  appendActiveModeContract(promptParts, input, parsed);
  appendAgentModeContext(promptParts, input);
  appendSharedPromptContext(promptParts, input);

  promptParts.push(FULL_PROMPT_POSTLUDE.replace("{transcript}", transcript.trim()));

  // last user message (best effort)
  const chats = parsed.blocks.filter((b) => (b as any).kind === "chat") as any[];
  const lastUser = [...chats].reverse().find((b) => b.role === "user");
  const lastUserText = lastUser?.content as string | undefined;

  const promptText = promptParts.join("\n");
  const transcriptImages = extractPromptImagePartsFromMarkdown(transcript, input.workspaceRoot);
  const configuredImages = extracted.systemText ? [] : normalizeConfiguredImages(input.configuredSystemMessage?.images, input.workspaceRoot);
  const prompt = buildPromptContent(promptText, [...extracted.systemImages, ...configuredImages, ...transcriptImages]);

  return { prompt, promptText, lastUserText, parseErrors: errs };
}

export function compileIncrementalPrompt(input: CompileInputs): { prompt: PromptContent; promptText: string; parseErrors: string[] } {
  const cleaned = stripSupervisorBlocks(input.documentText);
  const transcript = cleaned;
  const parsed = parseChatMarkdown(transcript);
  const errs = parsed.errors.map((e) => `L${e.line}: ${e.message}`);
  const agents = input.agentsMd?.trim();

  const chats = parsed.blocks.filter((b) => (b as any).kind === "chat") as any[];
  const lastUser = [...chats].reverse().find((b) => b.role === "user");
  if (!lastUser) {
    const promptText = "No user message found in document.";
    return { prompt: promptContentFromText(promptText), promptText, parseErrors: errs.concat(["No user message found."]) };
  }

  const promptParts = [INCREMENTAL_PROMPT_PREFIX, ""];

  if (agents) {
    promptParts.push(agents, "");
  }

  const skillsSection = renderSkillsSection(input.skills ?? []);
  if (skillsSection) {
    promptParts.push(skillsSection, "");
  }
  appendAgentModeContext(promptParts, input);
  appendSharedPromptContext(promptParts, input);

  promptParts.push(INCREMENTAL_PROMPT_POSTLUDE.replace("{last_user_message}", lastUser.content.trim()));
  const promptText = promptParts.join("\n");
  const userImages = extractPromptImagePartsFromMarkdown(String(lastUser.content ?? ""), input.workspaceRoot);
  const configuredImages = normalizeConfiguredImages(input.configuredSystemMessage?.images, input.workspaceRoot);
  const prompt = buildPromptContent(promptText, [...configuredImages, ...userImages]);

  return { prompt, promptText, parseErrors: errs };
}

export function compileSupervisorReview(input: SupervisorReviewInputs): { prompt: PromptContent; promptText: string } {
  const cleaned = stripSupervisorBlocks(input.documentText);
  const agents = input.agentsMd?.trim();
  const reasons = input.stopReasons.length ? input.stopReasons.join(", ") : "manual";
  const system = resolveSystemMessage(systemMessageForProvider(input.provider, input.model).message, input.configuredSystemMessage);
  const mode = input.mode ?? "hard";
  const agentModel = input.agentModel ?? input.model ?? "";
  const supervisorModel = input.supervisorModel ?? input.model ?? "";
  const schemaJson = JSON.stringify(input.responseSchema, null, 2);
  const currentMode = (input.currentMode ?? "default").trim() || "default";
  const allowedNextModes = (input.allowedNextModes ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  const allowedDecisions = (() => {
    const schemaRecord = input.responseSchema as Record<string, unknown>;
    const properties = schemaRecord?.properties as Record<string, unknown> | undefined;
    const decisionProperty = properties?.decision as Record<string, unknown> | undefined;
    const values = Array.isArray(decisionProperty?.enum) ? decisionProperty?.enum : [];
    return values.map((value) => String(value ?? "").trim()).filter(Boolean);
  })();
  const modeContractJson = buildModeContractJson({
    currentMode,
    allowedNextModes,
    modePayloadFieldsByMode: input.modePayloadFieldsByMode,
    modeGuidanceByMode: input.modeGuidanceByMode,
  });
  const stopCondition = (input.stopCondition ?? "").trim() || "(none)";
  const supervisorCarryover = (input.supervisorCarryover ?? "").trim();

  const joinSection = (lines: string[]): string => {
    if (!lines || lines.length === 0) return "";
    return lines.join("\n") + "\n\n";
  };

  const skillsSection = renderSkillsSection(input.skills ?? []);
  const workspaceListingSection = input.workspaceListing?.trim()
    ? `Workspace listing (top-level):\n${input.workspaceListing.trim()}\n\n`
    : "";
  const utilSection = joinSection(formatUtilities(input.utilities));
  const taggedSection = joinSection(formatFileContexts("Tagged files (from @path mentions)", input.taggedFiles, "@"));
  const openSection = joinSection(formatFileContexts("Open buffers", input.openFiles));
  const skillInvokeSection = joinSection(formatSkillsToInvoke(input.skillsToInvoke));
  const skillInstructionSection = joinSection(formatSkillInstructions(input.skillInstructions));

  const agentRules = resolveAgentRules(input);
  const agentRuleViolations = resolveAgentRuleViolations(input);
  const supervisorInstructions = resolveSupervisorInstructions(input.supervisorInstructions);
  const agentRulesText = agentRules.length ? agentRules.map((r) => `- ${r}`).join("\n") : "(none)";
  const agentRuleViolationsText = agentRuleViolations.length
    ? agentRuleViolations.map((r) => `- ${r}`).join("\n")
    : "(none)";
  const supervisorInstructionsSection = supervisorInstructions.length
    ? ["Supervisor instructions (supervisor-only):", ...supervisorInstructions.map((r) => `- ${r}`), ""].join("\n")
    : "";
  const syntheticRuleInstruction = input.disableSyntheticCheckSupervisorOnRuleFailure
    ? "Synthetic check_supervisor replacement on hard-rule failure is disabled by config."
    : "Hard-rule failure will trigger synthetic check_supervisor replacement automatically.";
  const nextModesText = allowedNextModes.length ? allowedNextModes.join(", ") : "(none)";

  const templateName = input.trigger === "run_start_bootstrap"
    ? "supervisor_bootstrap.md"
    : "supervisor_review.md";
  const template = loadPromptTemplate(templateName);
  if (!template) {
    const promptText = [
      system,
      "",
      "Supervisor prompt template missing.",
      `Mode: ${mode}`,
      `Stop reasons: ${reasons}`,
      `Current task mode: ${currentMode}`,
      `Allowed next modes: ${nextModesText}`,
      `Stop condition: ${stopCondition}`,
      "",
      ...(input.trigger === "run_start_bootstrap"
        ? []
        : ["Assistant response:", input.assistantText.trim()]),
    ].join("\n");
    const promptImages = dedupePromptImages([
      ...normalizeConfiguredImages(input.configuredSystemMessage?.images, input.workspaceRoot),
      ...extractPromptImagePartsFromMarkdown(cleaned, input.workspaceRoot),
      ...extractPromptImagePartsFromMarkdown(input.assistantText, input.workspaceRoot),
    ]);
    return {
      prompt: buildPromptContent(promptText, promptImages),
      promptText,
    };
  }

  const promptText = renderPromptTemplate(template, {
    SYSTEM_MESSAGE: system,
    MODE: mode,
    KIND: "review",
    AGENTS_MD_SECTION: agents ? agents + "\n\n" : "",
    SKILLS_SECTION: skillsSection ? skillsSection + "\n\n" : "",
    WORKSPACE_LISTING_SECTION: workspaceListingSection,
    UTILITIES_SECTION: utilSection,
    TAGGED_FILES_SECTION: taggedSection,
    OPEN_FILES_SECTION: openSection,
    SKILLS_TO_INVOKE_SECTION: skillInvokeSection,
    SKILL_INSTRUCTIONS_SECTION: skillInstructionSection,
    AGENT_RULES: agentRulesText,
    AGENT_RULE_REQUIREMENTS: agentRulesText,
    AGENT_RULE_VIOLATIONS: agentRuleViolationsText,
    SUPERVISOR_INSTRUCTIONS_SECTION: supervisorInstructionsSection,
    STOP_REASONS: reasons,
    STOP_CONDITION: stopCondition,
    CURRENT_MODE: currentMode,
    ALLOWED_NEXT_MODES: nextModesText,
    TRIGGER: input.trigger,
    ALLOWED_DECISIONS: allowedDecisions.length ? allowedDecisions.join(", ") : "(none)",
    MODE_CONTRACT_JSON: modeContractJson,
    CARRYOVER_SECTION: supervisorCarryover ? `Supervisor carryover history:\n${supervisorCarryover}\n\n` : "",
    SYNTHETIC_RULE_INSTRUCTION: syntheticRuleInstruction,
    AGENT_MODEL: agentModel,
    SUPERVISOR_MODEL: supervisorModel,
    ASSISTANT_RESPONSE: input.assistantText.trim(),
    CONTEXT_SKELETON: cleaned.trim(),
    SCHEMA_JSON: schemaJson,
  });

  const promptImages = dedupePromptImages([
    ...normalizeConfiguredImages(input.configuredSystemMessage?.images, input.workspaceRoot),
    ...extractPromptImagePartsFromMarkdown(cleaned, input.workspaceRoot),
    ...extractPromptImagePartsFromMarkdown(input.assistantText, input.workspaceRoot),
  ]);
  const prompt = buildPromptContent(promptText, promptImages);
  return { prompt, promptText };
}

export function compileGraceAssessment(input: GraceAssessmentInputs): { prompt: PromptContent; promptText: string } {
  const cleaned = stripSupervisorBlocks(input.documentText);
  const agents = input.agentsMd?.trim();
  const system = resolveSystemMessage(systemMessageForProvider(input.provider, input.model).message, input.configuredSystemMessage);
  const supervisorInstructions = resolveSupervisorInstructions(input.supervisorInstructions);

  const promptParts = [
    system,
    "",
    "You are a supervisor assessing a session that hit a time limit.",
    "Determine whether the rules are still satisfied or might now be violated.",
    "If recent changes could have invalidated previously satisfied rules, request a grace period.",
    "",
  ];

  if (agents) {
    promptParts.push(agents, "");
  }

  const skillsSection = renderSkillsSection(input.skills ?? []);
  if (skillsSection) {
    promptParts.push(skillsSection, "");
  }
  appendSharedPromptContext(promptParts, input);

  promptParts.push(
    formatRules("Agent Rules", resolveAgentRules(input)),
    formatRules("Agent Rule Violations", resolveAgentRuleViolations(input)),
    "",
    ...(supervisorInstructions.length
      ? [formatRules("Supervisor instructions (supervisor-only)", supervisorInstructions), ""]
      : []),
    "",
    `Grace period length: ${input.graceMinutes} minutes`,
    "",
    "Latest assistant response (possibly partial):",
    input.assistantText.trim(),
    "",
    "Transcript (for context):",
    cleaned.trim(),
    "",
    "Return ONLY JSON with keys:",
    '{"needs_grace":boolean,"reasoning":string,"progress_summary":string,"last_satisfied_summary":string|null,"grace_prompt":string|null}'
  );

  const promptText = promptParts.join("\n");
  const promptImages = dedupePromptImages([
    ...normalizeConfiguredImages(input.configuredSystemMessage?.images, input.workspaceRoot),
    ...extractPromptImagePartsFromMarkdown(cleaned, input.workspaceRoot),
    ...extractPromptImagePartsFromMarkdown(input.assistantText, input.workspaceRoot),
  ]);
  const prompt = buildPromptContent(promptText, promptImages);
  return { prompt, promptText };
}
