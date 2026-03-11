import { renderToolResult } from "../../../markdown/render.js";
import { executeTool } from "../../../tools/tools.js";
import { normalizeToolOutputConfig, shouldTruncateOutput, storeToolOutput } from "../../../tools/tool_output.js";
import type { InlineToolCall } from "./inline_tools.js";
import { runSupervisorReview, formatSupervisorCheckOutput, type SupervisorReviewInputs } from "./supervisor_run.js";
import type { RunConfigTools } from "../../../supervisor/run_config_tools.js";
import { isBuiltinToolName, isToolAllowedByPolicy } from "../../../tools/definitions.js";
import type { SupervisorReviewResult } from "../../../supervisor/review_schema.js";
import { renderOffloadedToolOutputReference } from "../tool_output.js";

export type InlineToolExecution = {
  call: InlineToolCall;
  ok: boolean;
  output: string;
  error?: string;
  exitCode?: number;
  markdown: string;
  supervisorReview?: SupervisorReviewResult;
  supervisorThreadId?: string;
};

export type RulesCheckContext = Omit<SupervisorReviewInputs, "assistantText"> & {
  assistantText?: string;
};

export async function executeInlineToolCall(args: {
  call: InlineToolCall;
  workspaceRoot: string;
  toolWorkspaceRoot?: string;
  conversationId: string;
  toolOutput?: any;
  toolConfig?: RunConfigTools;
  rulesCheck?: RulesCheckContext;
}): Promise<InlineToolExecution> {
  const toolOutputConfig = normalizeToolOutputConfig(args.toolOutput);
  const builtinToolPolicy = args.toolConfig?.builtinPolicy;
  let ok = false;
  let output = "";
  let error: string | undefined = undefined;
  let exitCode: number | undefined = undefined;
  let supervisorReview: SupervisorReviewResult | undefined = undefined;
  let supervisorThreadId: string | undefined = undefined;

  try {
    const toolName = args.call.name === "check_rules" ? "check_supervisor" : args.call.name;
    if (isBuiltinToolName(toolName) && !isToolAllowedByPolicy(builtinToolPolicy, toolName)) {
      throw new Error(`Tool disabled by config: ${toolName}`);
    }
    if (toolName === "check_supervisor") {
      if (!args.rulesCheck) {
        throw new Error("check_supervisor requires rulesCheck context");
      }
      const modeArg = typeof args.call.args?.mode === "string" ? String(args.call.args.mode) : "hard";
      const mode = modeArg === "soft" ? "soft" : "hard";
      const outcome = await runSupervisorReview({
        ...args.rulesCheck,
        assistantText: args.rulesCheck.assistantText,
        trigger: "agent_check_supervisor",
        mode,
      });
      output = formatSupervisorCheckOutput({
        review: outcome.review,
        promptLogRel: outcome.promptLogRel,
        responseLogRel: outcome.responseLogRel,
        source: "check_supervisor",
        trigger: "agent_check_supervisor",
        mode,
        reasons: ["check_supervisor"],
      });
      ok = true;
      supervisorReview = outcome.review;
      supervisorThreadId = outcome.threadId;
    } else {
      const result = await executeTool(
        args.toolWorkspaceRoot ?? args.workspaceRoot,
        { name: args.call.name, args: args.call.args },
        {
          builtinToolPolicy,
          customTools: args.toolConfig?.customTools,
          shellInvocationPolicy: args.toolConfig?.shellInvocationPolicy,
        },
      );
      ok = result.ok;
      output = result.output ?? "";
      error = result.error;
      exitCode = result.exitCode;
    }
  } catch (err: any) {
    ok = false;
    output = "";
    error = err?.message ?? String(err);
  }

  if (args.conversationId && output && shouldTruncateOutput(output, toolOutputConfig)) {
    const stored = await storeToolOutput({
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      output,
      config: toolOutputConfig,
    });
    output = renderOffloadedToolOutputReference(stored);
  }

  const header = exitCode != null ? `(ok=${ok}) (exit=${exitCode})` : `(ok=${ok})`;
  const markdown = renderToolResult([header, output, error ? `\n[error]\n${error}` : ""].join("\n"));
  return { call: args.call, ok, output, error, exitCode, markdown, supervisorReview, supervisorThreadId };
}
