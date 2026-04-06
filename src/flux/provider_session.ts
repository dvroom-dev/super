import { createProvider } from "../providers/factory.js";
import type { ProviderFilesystemPolicy } from "../providers/filesystem_permissions.js";
import type { ProviderConfig, ProviderEvent } from "../providers/types.js";
import { imagePart, promptContentFromText, type PromptContent } from "../utils/prompt_content.js";
import { newId } from "../utils/ids.js";
import { appendProviderRawEvent, saveFluxSession, writeFluxPromptPayload } from "./session_store.js";
import type { FluxConfig, FluxSessionRecord, FluxSessionType } from "./types.js";

export type FluxProviderTurnResult = {
  assistantText: string;
  providerThreadId?: string;
  providerEvents: ProviderEvent[];
  interrupted: boolean;
};

function isMissingRolloutPathFailure(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? "");
  return /state db missing rollout path/i.test(message) || /missing rollout path for thread/i.test(message);
}

export async function runFluxProviderTurn(args: {
  workspaceRoot: string;
  config: FluxConfig;
  session: FluxSessionRecord;
  sessionType: FluxSessionType;
  promptText: string;
  promptImages?: string[];
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  outputSchema?: Record<string, unknown>;
  workingDirectory: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<FluxProviderTurnResult> {
  const prompt: PromptContent = promptContentFromText(args.promptText);
  for (const imagePath of args.promptImages ?? []) {
    const part = imagePart(imagePath);
    if (part) prompt.push(part);
  }
  const turnIndex = Date.now();
  if (args.config.observability.capturePrompts) {
    await writeFluxPromptPayload(args.workspaceRoot, args.config, args.sessionType, args.session.sessionId, turnIndex, {
      promptText: args.promptText,
      promptImages: args.promptImages ?? [],
      outputSchema: args.outputSchema ?? null,
      workingDirectory: args.workingDirectory,
    });
  }
  const filesystemPolicy: ProviderFilesystemPolicy = {
    read: { allow: [args.workingDirectory] },
    write: { allow: [args.workingDirectory] },
    create: { allow: [args.workingDirectory] },
    allowNewFiles: true,
  };
  const providerEvents: ProviderEvent[] = [];
  let assistantText = "";
  let providerThreadId = args.session.providerThreadId;
  let interrupted = false;
  const runOnce = async (threadId: string | undefined): Promise<void> => {
    const providerConfig: ProviderConfig = {
      provider: args.session.provider as any,
      model: args.session.model,
      workingDirectory: args.workingDirectory,
      threadId,
      modelReasoningEffort: args.reasoningEffort,
      sandboxMode: args.config.runtimeDefaults.sandboxMode,
      approvalPolicy: args.config.runtimeDefaults.approvalPolicy,
      permissionProfile: "workspace_no_network",
      providerFilesystemPolicy: filesystemPolicy,
      providerOptions: {
        allowedTools: ["Bash"],
      },
      env: {
        ...args.config.runtimeDefaults.env,
        ...(args.env ?? {}),
      },
      skipGitRepoCheck: true,
    };
    const provider = createProvider(providerConfig);
    try {
      for await (const event of provider.runStreamed(prompt, { outputSchema: args.outputSchema, signal: args.signal })) {
        providerEvents.push(event);
        if (args.config.observability.captureRawProviderEvents) {
          await appendProviderRawEvent(args.workspaceRoot, args.config, args.sessionType, args.session.sessionId, {
            id: newId("raw"),
            ts: new Date().toISOString(),
            event,
          });
        }
        if (event.type === "assistant_delta") assistantText += event.delta;
        if (event.type === "assistant_message") assistantText = event.text;
        if (event.type === "done" && event.threadId) providerThreadId = event.threadId;
      }
    } finally {
      await provider.close?.();
    }
  };
  try {
    await runOnce(args.session.providerThreadId);
  } catch (err: any) {
    const message = String(err?.message ?? err ?? "");
    const abortLike = err?.name === "AbortError" || /aborted by user/i.test(message) || /interrupt/i.test(message);
    if (abortLike) {
      interrupted = true;
    } else if (args.session.providerThreadId && isMissingRolloutPathFailure(err)) {
      args.session.providerThreadId = undefined;
      args.session.updatedAt = new Date().toISOString();
      await saveFluxSession(args.workspaceRoot, args.config, args.session);
      assistantText = "";
      providerThreadId = undefined;
      await runOnce(undefined);
    } else {
      throw err;
    }
  }
  args.session.providerThreadId = providerThreadId;
  args.session.updatedAt = new Date().toISOString();
  args.session.latestAssistantText = assistantText;
  await saveFluxSession(args.workspaceRoot, args.config, args.session);
  return { assistantText, providerThreadId, providerEvents, interrupted };
}
