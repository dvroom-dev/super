import { createProvider } from "../../../providers/factory.js";
import type { ProviderPermissionProfile, ProviderConfig } from "../../../providers/types.js";
import { buildSupervisorResponseSchema, type SupervisorTriggerKind } from "../../../supervisor/review_schema.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import { promptContentFromText } from "../../../utils/prompt_content.js";
import { messageTemplateSpecsForReview } from "./supervisor_interjections.js";

function collectPreflightTemplateSpecs(args: {
  supervisorTriggers?: NonNullable<Awaited<ReturnType<typeof renderRunConfig>>>["supervisorTriggers"];
}): Array<{ name: string; acceptsMessage: boolean }> {
  const variants: Array<{ reviewTrigger: SupervisorTriggerKind; supervisorMode: "hard" | "soft" }> = [
    { reviewTrigger: "agent_yield", supervisorMode: "hard" },
    { reviewTrigger: "agent_yield", supervisorMode: "soft" },
    { reviewTrigger: "agent_error", supervisorMode: "hard" },
    { reviewTrigger: "agent_check_supervisor", supervisorMode: "hard" },
    { reviewTrigger: "agent_tool_intercept", supervisorMode: "hard" },
    { reviewTrigger: "agent_switch_mode_request", supervisorMode: "hard" },
  ];
  const byName = new Map<string, { name: string; acceptsMessage: boolean }>();
  for (const variant of variants) {
    for (const spec of messageTemplateSpecsForReview({
      supervisorMode: variant.supervisorMode,
      reviewTrigger: variant.reviewTrigger,
      supervisorTriggers: args.supervisorTriggers,
    })) {
      const name = String(spec.name ?? "").trim();
      if (!name) continue;
      const existing = byName.get(name);
      if (!existing) {
        byName.set(name, { name, acceptsMessage: Boolean(spec.acceptsMessage) });
        continue;
      }
      existing.acceptsMessage = existing.acceptsMessage || Boolean(spec.acceptsMessage);
    }
  }
  return [...byName.values()];
}

export async function runSupervisorSchemaPreflight(args: {
  supervisorWorkspaceRoot: string;
  providerName: "mock" | "codex" | "claude" | "gemini";
  supervisorModel: string;
  supervisorModelReasoningEffort?: string;
  permissionProfile: ProviderPermissionProfile;
  supervisorProviderOptions?: Record<string, unknown>;
  allowedNextModes: string[];
  modePayloadFieldsByMode: Record<string, string[]>;
  supervisorTriggers?: NonNullable<Awaited<ReturnType<typeof renderRunConfig>>>["supervisorTriggers"];
  timeoutMs?: number;
  providerFactory?: (config: ProviderConfig) => ReturnType<typeof createProvider>;
}): Promise<void> {
  if (args.providerName === "mock") return;
  const schema = buildSupervisorResponseSchema({
    trigger: "agent_yield",
    mode: "hard",
    allowedNextModes: args.allowedNextModes,
    modePayloadFieldsByMode: args.modePayloadFieldsByMode,
    appendMessageTemplates: collectPreflightTemplateSpecs({ supervisorTriggers: args.supervisorTriggers }),
  });
  const provider = (args.providerFactory ?? createProvider)({
    provider: args.providerName,
    model: args.supervisorModel,
    workingDirectory: args.supervisorWorkspaceRoot,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    permissionProfile: args.permissionProfile,
    skipGitRepoCheck: true,
    modelReasoningEffort: args.supervisorModelReasoningEffort,
    providerOptions: args.supervisorProviderOptions,
  } as ProviderConfig);
  const timeoutMsRaw = Number(args.timeoutMs ?? 30000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? Math.floor(timeoutMsRaw)
    : 30000;
  try {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    let runPromise: Promise<{ text: string; threadId?: string; items?: any[] }> | undefined;
    try {
      runPromise = provider.runOnce(
        promptContentFromText(
          "Schema preflight: return any valid JSON object that matches the provided response schema.",
        ),
        { outputSchema: schema, signal: controller.signal },
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`supervisor schema preflight timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      await Promise.race([runPromise, timeoutPromise]);
    } catch (err: any) {
      const detail = err?.message ?? String(err);
      throw new Error(`supervisor schema preflight failed: ${detail}`);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (controller.signal.aborted && runPromise) {
        runPromise.catch(() => {});
      }
    }
  } catch (err: any) {
    throw err;
  } finally {
    await provider.close?.();
  }
}
