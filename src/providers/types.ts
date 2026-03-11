import type { PromptContent } from "../utils/prompt_content.js";
import type { CustomToolDefinition } from "../tools/definitions.js";
import type { ShellInvocationPolicy } from "../tools/shell_invocation_policy.js";
import type { ProviderFilesystemPolicy } from "./filesystem_permissions.js";

export type ProviderName = "codex" | "claude" | "gemini" | "mock";
export type ProviderPermissionProfile = "workspace_no_network" | "yolo";

export type ProviderItemKind =
  | "tool_result"
  | "tool_call"
  | "tool_error"
  | "assistant_meta"
  | "status"
  | "system"
  | "other";

export type NormalizedProviderItem = {
  id?: string;
  provider: ProviderName | "unknown";
  kind: ProviderItemKind;
  type?: string;
  name?: string;
  status?: string;
  summary: string;
  text?: string;
  details?: Record<string, unknown>;
  includeInTranscript?: boolean;
  outputRefs?: Array<{
    path: string;
    responseId: string;
    page: number;
    totalPages: number;
    totalLines: number;
    totalBytes: number;
    filePath: string;
  }>;
};

export type ProviderConfig = {
  provider: ProviderName;
  model: string;
  workingDirectory: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  permissionProfile?: ProviderPermissionProfile;
  skipGitRepoCheck?: boolean;
  env?: Record<string, string>;
  // If present, resume an existing provider thread/session
  threadId?: string;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  providerOptions?: Record<string, unknown>;
  customTools?: CustomToolDefinition[];
  shellInvocationPolicy?: ShellInvocationPolicy;
  providerFilesystemPolicy?: ProviderFilesystemPolicy;
};

export type ProviderEvent =
  | { type: "assistant_message"; text: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "provider_item"; item: NormalizedProviderItem; raw?: unknown }
  | { type: "provider_item_delta"; item: NormalizedProviderItem; delta: string; id?: string; raw?: unknown }
  | { type: "status"; message: string }
  | { type: "usage"; usage: any }
  | { type: "done"; finalText?: string; threadId?: string };

export type ProviderCompactionResult = {
  compacted: boolean;
  threadId?: string;
  details?: string;
};

export type ProviderSteerResult = {
  applied: boolean;
  deferred: boolean;
  reason?: string;
  threadId?: string;
  turnId?: string;
};

export type ProviderInterruptResult = {
  interrupted: boolean;
  reason?: string;
  threadId?: string;
  turnId?: string;
};

export interface AgentProvider {
  runStreamed(
    prompt: PromptContent,
    options?: { outputSchema?: any; signal?: AbortSignal }
  ): AsyncGenerator<ProviderEvent, void, void>;
  runOnce(prompt: PromptContent, options?: { outputSchema?: any; signal?: AbortSignal }): Promise<{ text: string; threadId?: string; items?: any[] }>;
  compactThread?(
    options?: { signal?: AbortSignal; reason?: string }
  ): Promise<ProviderCompactionResult>;
  steerActiveTurn?(
    prompt: PromptContent,
    options?: { signal?: AbortSignal; expectedTurnId?: string }
  ): Promise<ProviderSteerResult>;
  interruptActiveTurn?(
    options?: { signal?: AbortSignal; reason?: string }
  ): Promise<ProviderInterruptResult>;
  close?(): Promise<void> | void;
}
