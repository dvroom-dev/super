import { renderChat } from "../markdown/render.ts";
import { buildSessionSystemPromptForMode } from "../server/stdio/supervisor/session_system_prompt.ts";
import { appendAgentRulesToInitialUserMessage } from "../server/stdio/supervisor/mode_runtime.ts";
import type { RenderedRunConfig } from "../supervisor/run_config.ts";

export function buildInitialDocument(args: {
  conversationId: string;
  forkId: string;
  renderedRunConfig: RenderedRunConfig | null;
  mode: string;
  processStage?: string;
  taskProfile?: string;
  provider: string;
  model: string;
  userMessage: string;
  agentRuleRequirements: string[];
  agentRuleViolations: string[];
  disableSupervision: boolean;
}): string {
  const initialUserMessage = appendAgentRulesToInitialUserMessage({
    userMessage: args.userMessage,
    requirements: args.agentRuleRequirements,
    violations: args.agentRuleViolations,
  });
  const systemMessage = buildSessionSystemPromptForMode({
    renderedRunConfig: args.renderedRunConfig,
    mode: args.mode,
    provider: args.provider as any,
    model: args.model,
    agentRules: args.agentRuleRequirements,
    disableSupervision: args.disableSupervision,
  });
  return [
    "---",
    `conversation_id: ${args.conversationId}`,
    `fork_id: ${args.forkId}`,
    `mode: ${args.mode}`,
    ...(args.processStage ? [`process_stage: ${args.processStage}`] : []),
    ...(args.taskProfile ? [`task_profile: ${args.taskProfile}`] : []),
    "---",
    "",
    renderChat("system", systemMessage, { scope: "agent_base" }),
    "",
    renderChat("user", initialUserMessage),
  ].join("\n");
}

export function frontmatterValue(documentText: string, key: string): string | undefined {
  const lines = documentText.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "---") break;
    const match = line.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)\\s*$`));
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

export function normalizeExportedDocumentFrontmatter(
  documentText: string,
  args: { conversationId: string; forkId: string; mode?: string },
): string {
  const lines = documentText.split(/\r?\n/);
  if (lines[0] !== "---") return documentText;
  const frontmatterEnd = lines.findIndex((line, index) => index > 0 && line === "---");
  if (frontmatterEnd <= 0) return documentText;

  const body = lines.slice(frontmatterEnd + 1);
  const entries = new Map<string, string>();
  for (let index = 1; index < frontmatterEnd; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    entries.set(match[1], match[2]);
  }
  entries.set("conversation_id", args.conversationId);
  entries.set("fork_id", args.forkId);
  if (args.mode) entries.set("mode", args.mode);

  const normalizedFrontmatter = [
    "---",
    ...Array.from(entries.entries()).map(([key, value]) => `${key}: ${value}`),
    "---",
  ];
  return `${normalizedFrontmatter.join("\n")}\n${body.join("\n")}`;
}
