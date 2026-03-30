import { createProvider } from "../providers/factory.js";
import type { ProviderConfig, ProviderEvent } from "../providers/types.js";
import { promptContentFromText } from "../utils/prompt_content.js";
import { newId } from "../utils/ids.js";
import { appendProviderRawEvent, saveFluxSession, writeFluxPromptPayload } from "./session_store.js";
import type { FluxConfig, FluxSessionRecord, FluxSessionType } from "./types.js";

export type FluxProviderTurnResult = {
  assistantText: string;
  providerThreadId?: string;
  providerEvents: ProviderEvent[];
  interrupted: boolean;
};

export async function runFluxProviderTurn(args: {
  workspaceRoot: string;
  config: FluxConfig;
  session: FluxSessionRecord;
  sessionType: FluxSessionType;
  promptText: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  outputSchema?: Record<string, unknown>;
  workingDirectory: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<FluxProviderTurnResult> {
  const providerConfig: ProviderConfig = {
    provider: args.session.provider as any,
    model: args.session.model,
    workingDirectory: args.workingDirectory,
    threadId: args.session.providerThreadId,
    modelReasoningEffort: args.reasoningEffort,
    sandboxMode: args.config.runtimeDefaults.sandboxMode,
    approvalPolicy: args.config.runtimeDefaults.approvalPolicy,
    permissionProfile: "workspace_no_network",
    env: {
      ...args.config.runtimeDefaults.env,
      ...(args.env ?? {}),
    },
    skipGitRepoCheck: true,
  };
  const provider = createProvider(providerConfig);
  const prompt = promptContentFromText(args.promptText);
  const turnIndex = Date.now();
  if (args.config.observability.capturePrompts) {
    await writeFluxPromptPayload(args.workspaceRoot, args.config, args.sessionType, args.session.sessionId, turnIndex, {
      promptText: args.promptText,
      outputSchema: args.outputSchema ?? null,
      workingDirectory: args.workingDirectory,
    });
  }
  const providerEvents: ProviderEvent[] = [];
  let assistantText = "";
  let providerThreadId = args.session.providerThreadId;
  let interrupted = false;
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
  } catch (err: any) {
    const message = String(err?.message ?? err ?? "");
    const abortLike = err?.name === "AbortError" || /aborted by user/i.test(message) || /interrupt/i.test(message);
    if (!abortLike) throw err;
    interrupted = true;
  } finally {
    await provider.close?.();
  }
  args.session.providerThreadId = providerThreadId;
  args.session.updatedAt = new Date().toISOString();
  args.session.latestAssistantText = assistantText;
  await saveFluxSession(args.workspaceRoot, args.config, args.session);
  return { assistantText, providerThreadId, providerEvents, interrupted };
}
