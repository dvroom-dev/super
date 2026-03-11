import { normalizeRules, normalizeFileContexts, systemMessage, toolDefinitionsMarkdown } from "../helpers.js";
import { loadAgentsInstructions, workspaceListing, taggedFileContexts } from "../workspace.js";
import { getUtilities } from "../utilities.js";
import { loadSkills, renderSkillsSection } from "../../../skills/loader.js";
import {
  FULL_PROMPT_POSTLUDE,
  INCREMENTAL_PROMPT_PREFIX,
  INCREMENTAL_PROMPT_POSTLUDE,
  resolveSystemMessage,
  resolveAgentRules,
  resolveAgentRuleViolations,
} from "../../../supervisor/compile.js";
import type { StdioContext } from "./context.js";
import { loadRunConfigForDirectory, renderRunConfig } from "../../../supervisor/run_config.js";

export async function handleConversationContext(ctx: StdioContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  const docPath = String((params as any)?.docPath ?? "untitled");
  const documentText = String((params as any)?.documentText ?? "");
  const models = Array.isArray((params as any)?.models) ? (params as any).models.map((m: any) => String(m)) : [];
  const model = models[0];
  const agentRulesFromRequest = normalizeRules((params as any)?.agentRules);
  const runConfigPath = typeof (params as any)?.runConfigPath === "string" ? String((params as any).runConfigPath) : undefined;
  const agentsMd = await loadAgentsInstructions(workspaceRoot);
  const workspaceListingText = await workspaceListing(workspaceRoot);
  const taggedFiles = await taggedFileContexts(workspaceRoot, documentText);
  const openFiles = normalizeFileContexts((params as any)?.openFiles);
  const utilities = await getUtilities(ctx.state);
  const runConfig = await loadRunConfigForDirectory(workspaceRoot, { explicitConfigPath: runConfigPath });
  const renderedRunConfig = await renderRunConfig(runConfig);
  const skillsOutcome = await loadSkills(workspaceRoot);
  const skills = skillsOutcome.skills;
  const skillsToInvoke: typeof skills = [];
  const skillInstructions: any[] = [];

  const agentsContent = agentsMd;

  const taggedContent =
    taggedFiles.length === 0
      ? "(none)"
      : taggedFiles
          .map((t) => {
            const meta = [t.kind, t.truncated ? "truncated" : "", t.error ? "error" : ""].filter(Boolean).join(", ");
            const header = `@${t.path}${meta ? ` (${meta})` : ""}`;
            const body = t.error ? `error: ${t.error}` : t.content;
            return [header, body].join("\n");
          })
          .join("\n\n");

  const openContent =
    openFiles.length === 0
      ? "(none)"
      : openFiles
          .map((t) => {
            const meta = [t.kind, t.truncated ? "truncated" : "", t.error ? "error" : ""].filter(Boolean).join(", ");
            const header = `${t.path}${meta ? ` (${meta})` : ""}`;
            const body = t.error ? `error: ${t.error}` : t.content;
            return [header, body].join("\n");
          })
          .join("\n\n");

  const utilitiesContent =
    utilities.length === 0
      ? "(none)"
      : utilities
          .map((u) => {
            const detail = u.available ? `available (${u.command}${u.path ? ` @ ${u.path}` : ""})` : `missing (${u.command})`;
            return `${u.name}: ${detail}`;
          })
          .join("\n");

  const skillsSection = renderSkillsSection(skills);
  const skillsToInvokeSection =
    skillsToInvoke.length > 0 ? skillsToInvoke.map((s) => `- ${s.name}`).join("\n") : "(none)";
  const skillInstructionsSection =
    skillInstructions.length > 0
      ? skillInstructions
          .map((item) => [`<skill>`, `<name>${item.name}</name>`, `<path>${item.path}</path>`, item.contents, `</skill>`].join("\n"))
          .join("\n\n")
      : "(none)";
  const promptFullSection = FULL_PROMPT_POSTLUDE;
  const promptIncrementalSection = [INCREMENTAL_PROMPT_PREFIX, "", INCREMENTAL_PROMPT_POSTLUDE].join("\n");

  const system = systemMessage(model);
  const systemContent = resolveSystemMessage(system.message, renderedRunConfig?.systemMessage);
  const systemSource = renderedRunConfig?.systemMessage
    ? `${system.source} + run_config(${renderedRunConfig.systemMessage.operation})`
    : system.source;
  const runConfigSources = renderedRunConfig?.sources?.length ? renderedRunConfig.sources.join("\n") : "";
  const configuredUserMessage = renderedRunConfig?.userMessage?.text ?? "";
  const agentRules = resolveAgentRules({
    agentRules: [...agentRulesFromRequest, ...(renderedRunConfig?.agentRules.requirements ?? [])],
  });
  const agentRuleViolations = resolveAgentRuleViolations({
    agentRuleViolations: renderedRunConfig?.agentRules.violations ?? [],
  });
  const supervisorInstructions = renderedRunConfig?.supervisorInstructions ?? [];
  const sections = [
    { id: "system", title: "System message", role: "system", content: systemContent },
    { id: "system_source", title: "System message source", role: "system", content: systemSource },
    ...(runConfigSources ? [{ id: "run_config_sources", title: "Run config sources", role: "system", content: runConfigSources }] : []),
    ...(configuredUserMessage
      ? [{ id: "configured_user_message", title: "Configured user message (new sessions only)", role: "user", content: configuredUserMessage }]
      : []),
    ...(renderedRunConfig?.contextManagementStrategy
      ? [{
          id: "context_management_strategy",
          title: "Context management strategy",
          role: "system",
          content: renderedRunConfig.contextManagementStrategy,
        }]
      : []),
    ...(typeof renderedRunConfig?.reviewTimeoutMs === "number"
      ? [{
          id: "review_timeout_ms",
          title: "Supervisor review timeout (ms)",
          role: "system",
          content: String(renderedRunConfig.reviewTimeoutMs),
        }]
      : []),
    ...(agentsContent ? [{ id: "agents_md", title: "AGENTS.md", role: "system", content: agentsContent }] : []),
    { id: "skills", title: "Skills", role: "system", content: skillsSection ?? "(none)" },
    { id: "skills_to_invoke", title: "Skills to invoke", role: "system", content: skillsToInvokeSection },
    { id: "skill_instructions", title: "Skill instructions", role: "system", content: skillInstructionsSection },
    { id: "prompt_full", title: "Prompt framing (full)", role: "system", content: promptFullSection },
    { id: "prompt_incremental", title: "Prompt framing (incremental)", role: "system", content: promptIncrementalSection },
    { id: "workspace_listing", title: "Workspace listing", role: "system", content: workspaceListingText || "(none)" },
    { id: "utilities", title: "Utilities", role: "system", content: utilitiesContent },
    { id: "tagged_files", title: "Tagged files", role: "system", content: taggedContent },
    { id: "open_buffers", title: "Open buffers", role: "system", content: openContent },
    {
      id: "agent_requirements",
      title: "Agent Requirements",
      role: "system",
      content: agentRules.length ? agentRules.map((r) => `- ${r}`).join("\n") : "(none)",
    },
    {
      id: "agent_rule_violations",
      title: "Agent Rule Violations",
      role: "system",
      content: agentRuleViolations.length ? agentRuleViolations.map((r) => `- ${r}`).join("\n") : "(none)",
    },
    {
      id: "supervisor_instructions",
      title: "Supervisor Instructions",
      role: "system",
      content: supervisorInstructions.length ? supervisorInstructions.map((r) => `- ${r}`).join("\n") : "(none)",
    },
    { id: "tools", title: "Tool definitions", role: "system", content: toolDefinitionsMarkdown(renderedRunConfig?.tools) },
  ];

  return { sections };
}
