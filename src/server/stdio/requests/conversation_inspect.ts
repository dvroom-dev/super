import { compileFullPrompt, compileIncrementalPrompt } from "../../../supervisor/compile.js";
import { normalizeRules, normalizeFileContexts } from "../helpers.js";
import { loadAgentsInstructions, workspaceListing, taggedFileContexts } from "../workspace.js";
import { getUtilities } from "../utilities.js";
import { loadSkills } from "../../../skills/loader.js";
import { loadForkSafe, selectBaseForkId } from "./common.js";
import type { RuntimeContext } from "./context.js";
import { loadRunConfigForDirectory, renderRunConfig } from "../../../supervisor/run_config.js";
import { prepareManagedAgentContext } from "../../../supervisor/context_management.js";

export async function handleConversationInspect(ctx: RuntimeContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  const docPath = String((params as any)?.docPath ?? "untitled");

  const documentText = String((params as any)?.documentText ?? "");
  const conversationId = await ctx.store.conversationIdFromDocument(docPath, documentText);
  const models = Array.isArray((params as any)?.models) ? (params as any).models.map((m: any) => String(m)) : [];
  const model = models[0];
  const agentRules = normalizeRules((params as any)?.agentRules);
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
  const agentsText = agentsMd;

  if (!documentText.trim()) throw new Error("documentText required");

  const idx = await ctx.store.loadIndex(workspaceRoot, conversationId);
  const docForkId = ctx.store.forkIdFromDocument(documentText);
  const explicitBaseForkId = typeof (params as any)?.baseForkId === "string"
    ? String((params as any).baseForkId)
    : undefined;
  const baseForkId = selectBaseForkId({
    explicitBaseForkId,
    docForkId,
    indexHeadId: idx.headId,
    knownForkIds: idx.forks.map((fork) => fork.id),
  });

  let base = undefined;
  if (baseForkId) {
    base = await loadForkSafe(ctx, workspaceRoot, conversationId, baseForkId);
  }
  if (!base && idx.headId && idx.headId !== baseForkId) {
    base = await loadForkSafe(ctx, workspaceRoot, conversationId, idx.headId);
  }

  const historyEdited = base ? ctx.store.isHistoryEdited(base.documentText ?? "", documentText) : true;
  const managedContext = await prepareManagedAgentContext({
    documentText,
    workspaceRoot,
    conversationId,
    strategy: renderedRunConfig?.contextManagementStrategy,
  });
  const compile =
    historyEdited || !base?.providerThreadId
      ? compileFullPrompt({
          documentText: managedContext.documentText,
          workspaceRoot,
          agentRules: [...agentRules, ...(renderedRunConfig?.agentRules.requirements ?? [])],
          model,
          agentsMd: agentsText,
          workspaceListing: workspaceListingText,
          taggedFiles,
          openFiles,
          utilities,
          skills,
          skillsToInvoke,
          skillInstructions,
          configuredSystemMessage: renderedRunConfig?.systemMessage,
        })
      : compileIncrementalPrompt({
          documentText: managedContext.documentText,
          workspaceRoot,
          agentRules: [...agentRules, ...(renderedRunConfig?.agentRules.requirements ?? [])],
          model,
          agentsMd: agentsText,
          workspaceListing: workspaceListingText,
          taggedFiles,
          openFiles,
          utilities,
          skills,
          skillsToInvoke,
          skillInstructions,
          configuredSystemMessage: renderedRunConfig?.systemMessage,
        });

  return {
    mode: historyEdited ? "full" : "incremental",
    prompt: compile.promptText,
    parseErrors: compile.parseErrors,
    agentsMdIncluded: Boolean(agentsText?.trim()),
  };
}
