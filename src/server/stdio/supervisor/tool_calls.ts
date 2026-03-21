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
    if (toolName === "switch_mode") {
      if (args.call.source === "runtime_provider") {
        throw new Error(
          "BUG: runtime-captured switch_mode reached generic inline tool execution instead of the dedicated mode-switch handler.",
        );
      }
      throw new Error(
        "Inline/custom switch_mode tool calls are unsupported. Run the runtime `switch_mode` CLI path instead.",
      );
    }
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
    } else if (toolName === "report_process_result") {
      if (!args.rulesCheck) {
        throw new Error("report_process_result requires rulesCheck context");
      }
      const outcomeText = typeof args.call.args?.outcome === "string" ? String(args.call.args.outcome).trim() : "";
      const summary = typeof args.call.args?.summary === "string" ? String(args.call.args.summary).trim() : "";
      const evidence = typeof args.call.args?.evidence === "string" ? String(args.call.args.evidence).trim() : "";
      const blocker = typeof args.call.args?.blocker === "string" ? String(args.call.args.blocker).trim() : "";
      const requestedProfile = typeof args.call.args?.requested_profile === "string" ? String(args.call.args.requested_profile).trim() : "";
      const userMessage = typeof args.call.args?.user_message === "string" ? String(args.call.args.user_message).trim() : "";
      if (!outcomeText) throw new Error("report_process_result requires outcome");
      if (!summary) throw new Error("report_process_result requires summary");
      const requestText = [
        "<agent-process-result-report>",
        `outcome: ${outcomeText}`,
        `summary: ${summary}`,
        evidence ? `evidence: ${evidence}` : "",
        blocker ? `blocker: ${blocker}` : "",
        requestedProfile ? `requested_profile: ${requestedProfile}` : "",
        userMessage ? `user_message: ${userMessage}` : "",
        "</agent-process-result-report>",
        "Decide the next process step. Use supervisor-owned progression; do not assume the worker chose correctly.",
      ].filter(Boolean).join("\n");
      const outcome = await runSupervisorReview({
        ...args.rulesCheck,
        assistantText: requestText,
        trigger: "agent_process_result_report",
        mode: "hard",
      });
      output = formatSupervisorCheckOutput({
        review: outcome.review,
        promptLogRel: outcome.promptLogRel,
        responseLogRel: outcome.responseLogRel,
        source: "report_process_result",
        trigger: "agent_process_result_report",
        mode: "hard",
        reasons: ["report_process_result"],
      });
      ok = true;
      supervisorReview = outcome.review;
      supervisorThreadId = outcome.threadId;
    } else if (toolName === "certify_wrapup") {
      if (!args.rulesCheck) {
        throw new Error("certify_wrapup requires rulesCheck context");
      }
      const wrapupLevelRaw = args.call.args?.wrapup_level;
      const wrapupLevel = Number(wrapupLevelRaw);
      if (!Number.isFinite(wrapupLevel) || wrapupLevel <= 0) {
        throw new Error("certify_wrapup requires a positive numeric wrapup_level");
      }
      const reason = typeof args.call.args?.reason === "string" ? String(args.call.args.reason).trim() : "";
      if (!reason) {
        throw new Error("certify_wrapup requires reason");
      }
      const userMessage = typeof args.call.args?.user_message === "string"
        ? String(args.call.args.user_message).trim()
        : "";
      const requestText = [
        "<agent-wrapup-certification-request>",
        `wrapup_level: ${Math.floor(wrapupLevel)}`,
        `reason: ${reason}`,
        userMessage ? `user_message: ${userMessage}` : "",
        "</agent-wrapup-certification-request>",
        "Decide whether to certify wrap-up, reject it with guidance, continue, or route to another mode.",
      ].filter(Boolean).join("\n");
      const outcome = await runSupervisorReview({
        ...args.rulesCheck,
        assistantText: requestText,
        trigger: "agent_wrapup_certification_request",
        mode: "hard",
      });
      output = formatSupervisorCheckOutput({
        review: outcome.review,
        promptLogRel: outcome.promptLogRel,
        responseLogRel: outcome.responseLogRel,
        source: "certify_wrapup",
        trigger: "agent_wrapup_certification_request",
        mode: "hard",
        reasons: ["certify_wrapup"],
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
