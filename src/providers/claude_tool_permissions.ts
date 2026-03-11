import { looksLikeNetworkTool } from "./claude_provider_helpers.js";
import { firstFilesystemPolicyViolation, firstOutsideWorkspacePath } from "./filesystem_permissions.js";
import { extractShellCommandText, shellInvocationPolicyViolation, type ShellInvocationPolicy } from "../tools/shell_invocation_policy.js";
import type { ProviderConfig } from "./types.js";

export type ClaudePermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[]; toolUseID?: string }
  | { behavior: "deny"; message: string; interrupt?: boolean; toolUseID?: string };

export function makeClaudeCanUseToolWithShellPolicy(
  workspaceRoot: string,
  denyNetwork: boolean,
  shellInvocationPolicy: ShellInvocationPolicy | undefined,
  providerFilesystemPolicy: ProviderConfig["providerFilesystemPolicy"],
  toolPolicy?: { allow?: string[]; deny?: string[] },
): (
  toolName: string,
  input: Record<string, unknown>,
  options: { blockedPath?: string; toolUseID: string },
) => Promise<ClaudePermissionResult> {
  return async (toolName, input, options) => {
    const normalizedToolName = toolName.trim();
    const isCustomMcpTool = normalizedToolName.startsWith("mcp__");
    if (!isCustomMcpTool && toolPolicy?.allow?.length && !toolPolicy.allow.includes(normalizedToolName)) {
      return {
        behavior: "deny",
        message: `Tool usage is not allowed by provider builtin tool policy: ${normalizedToolName}`,
        toolUseID: options.toolUseID,
      };
    }
    if (!isCustomMcpTool && toolPolicy?.deny?.includes(normalizedToolName)) {
      return {
        behavior: "deny",
        message: `Tool usage is not allowed by provider builtin tool policy: ${normalizedToolName}`,
        toolUseID: options.toolUseID,
      };
    }
    if (denyNetwork && looksLikeNetworkTool(toolName)) {
      return { behavior: "deny", message: `Network tool usage is not allowed: ${toolName}`, toolUseID: options.toolUseID };
    }
    const outsidePath = firstOutsideWorkspacePath({
      workspaceRoot,
      toolName,
      input,
      blockedPath: options?.blockedPath,
    });
    if (outsidePath) {
      return {
        behavior: "deny",
        message: `Filesystem access outside workspace is not allowed: ${outsidePath}`,
        toolUseID: options.toolUseID,
      };
    }
    if (toolName.trim().toLowerCase() === "bash" && shellInvocationPolicy) {
      const commandText = extractShellCommandText(input);
      if (commandText) {
        const violation = shellInvocationPolicyViolation({
          policy: shellInvocationPolicy,
          commandText,
        });
        if (violation) {
          return { behavior: "deny", message: violation, toolUseID: options.toolUseID };
        }
      }
    }
    const violation = firstFilesystemPolicyViolation({
      provider: "claude",
      workspaceRoot,
      toolName,
      input,
      blockedPath: options?.blockedPath,
      policy: providerFilesystemPolicy,
    });
    if (violation) {
      return { behavior: "deny", message: violation, toolUseID: options.toolUseID };
    }
    return { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID };
  };
}
