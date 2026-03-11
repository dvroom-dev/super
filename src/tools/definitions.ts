import type { ShellInvocationPolicy } from "./shell_invocation_policy.js";

export type BuiltinToolName =
  | "shell"
  | "read_file"
  | "write_file"
  | "list_dir"
  | "apply_patch"
  | "paginate_tool_response"
  | "check_supervisor"
  | "switch_mode";

export type ToolPolicyMode = "allow" | "deny";
export type ToolNamePolicy<T extends string> = {
  mode: ToolPolicyMode;
  names: T[];
};

export type CustomToolDefinition = {
  name: string;
  description: string;
  command: string[];
  cwd?: string;
};

export type ToolDefinitionsConfig = {
  builtinPolicy?: ToolNamePolicy<BuiltinToolName>;
  customTools?: CustomToolDefinition[];
  shellInvocationPolicy?: ShellInvocationPolicy;
};

const BUILTIN_DEFINITIONS: Record<BuiltinToolName, string> = {
  shell: "{ cmd: string[], cwd?: string }",
  read_file: "{ path: string }",
  write_file: "{ path: string, content: string }",
  list_dir: "{ path?: string }",
  apply_patch: "{ command: string[] }",
  paginate_tool_response: "{ id: string, page?: number }",
  check_supervisor: "{ mode?: \"hard\" | \"soft\" }",
  switch_mode: "{ target_mode: string, reason: string, mode_payload?: object, terminal?: boolean }",
};

const BUILTIN_TOOL_ORDER: BuiltinToolName[] = [
  "shell",
  "read_file",
  "write_file",
  "list_dir",
  "apply_patch",
  "paginate_tool_response",
  "check_supervisor",
  "switch_mode",
];

export function builtinToolNames(): BuiltinToolName[] {
  return [...BUILTIN_TOOL_ORDER];
}

export function isBuiltinToolName(value: string): value is BuiltinToolName {
  return BUILTIN_TOOL_ORDER.includes(value as BuiltinToolName);
}

export function isToolAllowedByPolicy<T extends string>(policy: ToolNamePolicy<T> | undefined, toolName: T): boolean {
  if (!policy) return true;
  const names = new Set(policy.names);
  if (policy.mode === "allow") return names.has(toolName);
  return !names.has(toolName);
}

export function toolDefinitionsMarkdown(config?: ToolDefinitionsConfig): string {
  const builtinPolicy = config?.builtinPolicy;
  const customTools = config?.customTools ?? [];
  const lines: string[] = [];
  for (const toolName of BUILTIN_TOOL_ORDER) {
    if (!isToolAllowedByPolicy(builtinPolicy, toolName)) continue;
    lines.push(`- ${toolName}: ${BUILTIN_DEFINITIONS[toolName]}`);
  }
  for (const tool of customTools) {
    lines.push(`- ${tool.name}: { args: object } // ${tool.description}`);
  }
  return lines.length ? lines.join("\n") : "(none)";
}
