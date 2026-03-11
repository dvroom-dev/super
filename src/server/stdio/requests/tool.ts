import { executeTool } from "../../../tools/tools.js";
import { renderToolResult } from "../../../markdown/render.js";
import { normalizeToolOutputConfig, shouldTruncateOutput, storeToolOutput } from "../../../tools/tool_output.js";
import { normalizeRules, normalizeFileContexts } from "../helpers.js";
import { isBuiltinToolName, isToolAllowedByPolicy } from "../../../tools/definitions.js";
import { loadAgentsInstructions, workspaceListing, taggedFileContexts } from "../workspace.js";
import { getUtilities } from "../utilities.js";
import { loadSkills } from "../../../skills/loader.js";
import { runSupervisorReview, formatSupervisorCheckOutput } from "../supervisor/supervisor_run.js";
import type { StdioContext } from "./context.js";
import { loadRunConfigForDirectory, renderRunConfig } from "../../../supervisor/run_config.js";
import { mergeAgentRuleSet, modePayloadFieldsByMode, resolveModeConfig } from "../supervisor/mode_runtime.js";
import { renderOffloadedToolOutputReference } from "../tool_output.js";

export async function handleToolExecute(ctx: StdioContext, params: any) {
  const workspaceRoot = ctx.requireWorkspaceRoot(params);
  const conversationId = typeof (params as any)?.conversationId === "string" ? String((params as any).conversationId) : "";
  const toolOutput = normalizeToolOutputConfig((params as any)?.toolOutput);
  const call = (params as any)?.call;
  if (!call || typeof call.name !== "string") throw new Error("tool.execute requires params.call with name");

  const callName = call.name === "check_rules" ? "check_supervisor" : call.name;
  const runConfig = await loadRunConfigForDirectory(workspaceRoot);
  const renderedRunConfig = await renderRunConfig(runConfig);
  const builtinToolPolicy = renderedRunConfig?.tools?.builtinPolicy;
  if (isBuiltinToolName(callName) && !isToolAllowedByPolicy(builtinToolPolicy, callName)) {
    throw new Error(`Tool disabled by config: ${callName}`);
  }
  if (callName === "check_supervisor") {
    if (!conversationId) throw new Error("check_supervisor requires conversationId");
    const documentText = String((params as any)?.documentText ?? "");
    if (!documentText.trim()) throw new Error("check_supervisor requires documentText");
    const agentRules = normalizeRules((params as any)?.agentRules);
    const models = Array.isArray((params as any)?.models) ? (params as any).models.map((m: any) => String(m)) : [];
    const providerName = String((params as any)?.provider ?? "codex") as any;
    const providerOptionsRaw =
      (params as any)?.providerOptions && typeof (params as any).providerOptions === "object"
        ? ((params as any).providerOptions as Record<string, unknown>)
        : undefined;
    const providerOptions = providerOptionsRaw;
    const modelReasoningEffort = (params as any)?.modelReasoningEffort ? String((params as any).modelReasoningEffort) : undefined;
    const supervisorModelReasoningEffort = (params as any)?.supervisorModelReasoningEffort
      ? String((params as any).supervisorModelReasoningEffort)
      : modelReasoningEffort;
    const model = String((params as any)?.model ?? (params as any)?.supervisorModel ?? models[0] ?? "");
    if (!model) throw new Error("check_supervisor requires model");
    const agentsText = await loadAgentsInstructions(workspaceRoot);
    const workspaceListingText = await workspaceListing(workspaceRoot);
    const taggedFiles = await taggedFileContexts(workspaceRoot, documentText);
    const openFiles = normalizeFileContexts((params as any)?.openFiles);
    const utilities = await getUtilities(ctx.state);
    const skillsOutcome = await loadSkills(workspaceRoot);
    const skills = skillsOutcome.skills;

    const modeArg = typeof call.args?.mode === "string" ? String(call.args.mode) : "hard";
    const mode = modeArg === "soft" ? "soft" : "hard";
    const currentMode = typeof call.args?.current_mode === "string" ? String(call.args.current_mode).trim() : "default";
    const explicitAllowedModes = Array.isArray(call.args?.allowed_next_modes)
      ? call.args.allowed_next_modes.map((value: any) => String(value).trim()).filter(Boolean)
      : undefined;
    const modeConfig = resolveModeConfig(renderedRunConfig, currentMode);
    const effectiveAgentRuleSet = mergeAgentRuleSet({
      requestRequirements: agentRules,
      configured: modeConfig?.agentRules ?? renderedRunConfig?.agentRules,
    });
    const modesEnabled = renderedRunConfig?.modesEnabled ?? true;
    const allowedNextModes = explicitAllowedModes && explicitAllowedModes.length
      ? explicitAllowedModes
      : (() => {
          if (!modesEnabled) return [];
          const transitions = renderedRunConfig?.modeStateMachine?.transitions?.[currentMode];
          if (Array.isArray(transitions) && transitions.length) return [...transitions];
          const configuredModes = Object.keys(renderedRunConfig?.modes ?? {});
          return configuredModes.length ? configuredModes : [];
        })();
    const outcome = await runSupervisorReview({
      workspaceRoot,
      conversationId,
      documentText,
      agentRules: effectiveAgentRuleSet.requirements,
      agentRuleViolations: effectiveAgentRuleSet.violations,
      supervisorInstructions: modeConfig?.supervisorInstructions ?? renderedRunConfig?.supervisorInstructions,
      trigger: "agent_check_supervisor",
      mode,
      providerName,
      model,
      agentModel: model,
      supervisorModel: model,
      supervisorModelReasoningEffort,
      providerOptions,
      agentsText,
      workspaceListingText,
      taggedFiles,
      openFiles,
      utilities,
      skills,
      skillsToInvoke: [],
      skillInstructions: [],
      configuredSystemMessage: renderedRunConfig?.supervisorSystemMessage,
      supervisorTriggers: renderedRunConfig?.supervisorTriggers,
      stopCondition: renderedRunConfig?.stopCondition ?? renderedRunConfig?.supervisor?.stopCondition,
      currentMode,
      allowedNextModes,
      modePayloadFieldsByMode: modePayloadFieldsByMode(renderedRunConfig, allowedNextModes),
    });

    let output = formatSupervisorCheckOutput({
      review: outcome.review,
      promptLogRel: outcome.promptLogRel,
      responseLogRel: outcome.responseLogRel,
      source: "check_supervisor",
      trigger: "agent_check_supervisor",
      mode,
      reasons: ["check_supervisor"],
    });

    if (conversationId && output && shouldTruncateOutput(output, toolOutput)) {
      const stored = await storeToolOutput({
        workspaceRoot,
        conversationId,
        output,
        config: toolOutput,
      });
      output = renderOffloadedToolOutputReference(stored);
    }

    const md = renderToolResult([`(ok=true)`, output].join("\n"));
    return { result: { ok: true, output }, markdown: md };
  }

  const result = await executeTool(
    workspaceRoot,
    { name: call.name, args: call.args },
    {
      builtinToolPolicy,
      customTools: renderedRunConfig?.tools?.customTools,
      shellInvocationPolicy: renderedRunConfig?.tools?.shellInvocationPolicy,
    },
  );
  let output = result.output ?? "";
  if (conversationId && output && shouldTruncateOutput(output, toolOutput)) {
    const stored = await storeToolOutput({
      workspaceRoot,
      conversationId,
      output,
      config: toolOutput,
    });
    output = renderOffloadedToolOutputReference(stored);
  }
  const md = renderToolResult(
    [`(ok=${result.ok}) (exit=${result.exitCode ?? ""})`, output, result.error ? `\n[error]\n${result.error}` : ""].join("\n")
  );
  return { result, markdown: md };
}
