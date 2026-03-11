import type { RunConfigTools } from "../../../supervisor/run_config_tools.js";
import {
  findFirstToolInterceptionRule,
  type ToolInterceptionMatch,
  type ToolInterceptionRule,
  type ToolInterceptionTool,
} from "../../../supervisor/tool_interception.js";
import { builtinToolNames, isBuiltinToolName } from "../../../tools/definitions.js";
import type { InlineToolCall } from "../supervisor/inline_tools.js";

export type InlineToolInterceptionContext = {
  tool: ToolInterceptionTool;
  toolName: string;
  argsJson: string;
  invocationText: string;
};

const BUILTIN_TOOL_NAME_ALIASES = new Set([
  ...builtinToolNames(),
  "bash",
  "read",
  "write",
  "edit",
  "multiedit",
  "glob",
  "grep",
  "ls",
  "task",
  "todo_write",
  "todowrite",
  "websearch",
  "web_search",
]);

function toPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function shellCommandFromArgs(args: unknown): string {
  const record = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (command) return command;
  const cmd = Array.isArray(record.cmd)
    ? record.cmd
    : Array.isArray(record.command)
      ? record.command
      : [];
  const parts = cmd.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  return parts.join(" ").trim();
}

export function toolInterceptionContextForTool(args: {
  toolName: string;
  toolArgs: unknown;
  toolConfig?: RunConfigTools;
}): InlineToolInterceptionContext | undefined {
  const toolName = String(args.toolName ?? "").trim();
  if (!toolName) return undefined;
  const argsJson = toPrettyJson(args.toolArgs ?? {});
  const normalizedName = toolName.toLowerCase();
  if (normalizedName === "shell" || normalizedName === "bash") {
    const command = shellCommandFromArgs(args.toolArgs ?? {});
    const invocationText = [command || "(empty command)", argsJson].join("\n\n").trim();
    return {
      tool: "bash",
      toolName,
      argsJson,
      invocationText,
    };
  }
  const customToolNames = new Set(
    (args.toolConfig?.customTools ?? [])
      .map((tool) => String(tool.name ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const builtin = isBuiltinToolName(normalizedName as any) || BUILTIN_TOOL_NAME_ALIASES.has(normalizedName);
  const isMcp = customToolNames.has(normalizedName) || !builtin;
  if (!isMcp) return undefined;
  const invocationText = [`tool_name: ${toolName}`, "tool_args:", argsJson].join("\n");
  return {
    tool: "mcp",
    toolName,
    argsJson,
    invocationText,
  };
}

export function inlineToolInterceptionContext(args: {
  call: InlineToolCall;
  toolConfig?: RunConfigTools;
}): InlineToolInterceptionContext | undefined {
  return toolInterceptionContextForTool({
    toolName: String(args.call.name ?? "").trim(),
    toolArgs: args.call.args ?? {},
    toolConfig: args.toolConfig,
  });
}

function buildMatch(args: {
  rule: ToolInterceptionRule;
  context: InlineToolInterceptionContext;
  when: "invocation" | "response";
  responseText?: string;
}): ToolInterceptionMatch {
  return {
    source: "inline",
    when: args.when,
    tool: args.context.tool,
    rule: args.rule,
    toolName: args.context.toolName,
    toolCall: {
      name: args.context.toolName,
      argsJson: args.context.argsJson,
      invocationText: args.context.invocationText,
    },
    ...(args.responseText != null
      ? { toolResponse: { outputText: args.responseText } }
      : {}),
  };
}

export function matchInlineToolInterceptionInvocation(args: {
  context: InlineToolInterceptionContext | undefined;
  rules: ToolInterceptionRule[] | undefined;
}): ToolInterceptionMatch | undefined {
  if (!args.context) return undefined;
  const rule = findFirstToolInterceptionRule({
    rules: args.rules,
    when: "invocation",
    tool: args.context.tool,
    text: args.context.invocationText,
  });
  if (!rule) return undefined;
  return buildMatch({
    rule,
    context: args.context,
    when: "invocation",
  });
}

export function matchInlineToolInterceptionResponse(args: {
  context: InlineToolInterceptionContext | undefined;
  rules: ToolInterceptionRule[] | undefined;
  outputText: string;
}): ToolInterceptionMatch | undefined {
  if (!args.context) return undefined;
  const responseText = String(args.outputText ?? "");
  const rule = findFirstToolInterceptionRule({
    rules: args.rules,
    when: "response",
    tool: args.context.tool,
    text: responseText,
  });
  if (!rule) return undefined;
  return buildMatch({
    rule,
    context: args.context,
    when: "response",
    responseText,
  });
}

export function buildToolInterceptionReviewMessage(match: ToolInterceptionMatch): string {
  const header = [
    "<agent-tool-intercept>",
    `trigger: agent_tool_intercept`,
    `source: ${match.source}`,
    `phase: ${match.when}`,
    `tool_kind: ${match.tool}`,
    `tool_name: ${match.toolName}`,
    `match_type: ${match.rule.matchType}`,
    `pattern: ${match.rule.pattern}`,
    `case_sensitive: ${String(match.rule.caseSensitive)}`,
    ...(match.rule.name ? [`rule_name: ${match.rule.name}`] : []),
  ];
  const callBlock = [
    "tool_call:",
    "```json",
    JSON.stringify({ name: match.toolCall.name, args: JSON.parse(match.toolCall.argsJson) }, null, 2),
    "```",
  ];
  const invocationBlock = [
    "invocation_text:",
    "```text",
    match.toolCall.invocationText,
    "```",
  ];
  const responseBlock = match.toolResponse
    ? [
        "tool_response_stdout_stderr:",
        "```text",
        match.toolResponse.outputText,
        "```",
      ]
    : [];
  return [
    ...header,
    ...callBlock,
    ...invocationBlock,
    ...responseBlock,
    "</agent-tool-intercept>",
  ].join("\n");
}

export function isReplaceToolInterceptTemplate(templateName: string | undefined): boolean {
  return String(templateName ?? "").trim() === "replace_tool_call_with_guidance";
}
