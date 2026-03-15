import path from "node:path";
import { promises as fs } from "node:fs";
import { createProvider } from "../../../providers/factory.js";
import { getProviderOverflowRecovery } from "../../../providers/provider_overflow_recovery.js";
import type { SupervisorOverflowRecoveryResult } from "../../../providers/provider_overflow_recovery_helpers.js";
import type { ProviderConfig, ProviderName, ProviderPermissionProfile } from "../../../providers/types.js";
import {
  compileSupervisorReview,
  compileSupervisorRecoverySummary,
  type SupervisorRecoveryPacket,
} from "../../../supervisor/compile.js";
import type { SkillInstruction, SkillMetadata } from "../../../skills/types.js";
import type { PromptMessageOverride, TaggedFileContext, UtilityStatus } from "../../../supervisor/compile.js";
import type { RenderedRunConfigSupervisorTriggers } from "../../../supervisor/run_config.js";
import {
  buildSupervisorResponseSchema,
  decisionFieldName,
  type ModeAssessment,
  type SupervisorReviewResult,
  type SupervisorTriggerKind,
} from "../../../supervisor/review_schema.js";
import { newId } from "../../../utils/ids.js";
import { type PromptContent } from "../../../utils/prompt_content.js";
import { parseJsonSafe } from "../helpers.js";
import {
  failedRuleNames,
  fallbackReview,
  normalizeReview,
  validateReviewSemantic,
} from "./review_utils.js";
import { buildManagedSupervisorReviewContext } from "./review_context.js";
import {
  buildSupervisorRunHistoryContext,
  persistSupervisorRunHistoryWatermark,
} from "./run_history.js";
import { type JsonSchemaNode, validateSchemaValue } from "./schema_validation.js";
import { buildSchemaRetryPrompt, looksLikeContextWindowError } from "./supervisor_run_helpers.js";
import { resolveSupervisorConfiguredSystemMessage } from "./supervisor_prompt_overrides.js";
import { messageTemplateSpecsForReview } from "./supervisor_interjections.js";
import { claimSupervisorReviewLane } from "./supervisor_review_lane.js";
export { formatSupervisorCheckOutput } from "./supervisor_check_output.js";
export { buildSupervisorReviewDocument } from "./review_context.js";

export type SupervisorReviewInputs = {
  workspaceRoot: string;
  conversationId: string;
  documentText: string;
  agentRules?: string[];
  agentRuleViolations?: string[];
  supervisorInstructions?: string[];
  assistantText?: string;
  mode?: "hard" | "soft";
  trigger: SupervisorTriggerKind;
  stopReasons?: string[];
  providerName: string;
  model: string;
  agentModel?: string;
  supervisorModel?: string;
  agentModelReasoningEffort?: string;
  supervisorModelReasoningEffort?: string;
  modelReasoningEffort?: string;
  threadId?: string;
  providerOptions?: Record<string, unknown>;
  permissionProfile?: ProviderPermissionProfile;
  agentsText?: string;
  workspaceListingText?: string;
  taggedFiles?: TaggedFileContext[];
  openFiles?: TaggedFileContext[];
  utilities?: UtilityStatus[];
  skills?: SkillMetadata[];
  skillsToInvoke?: SkillMetadata[];
  skillInstructions?: SkillInstruction[];
  configuredSystemMessage?: PromptMessageOverride;
  supervisorTriggers?: RenderedRunConfigSupervisorTriggers;
  stopCondition?: string;
  currentMode?: string;
  allowedNextModes?: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  modeGuidanceByMode?: Record<string, { description?: string; startWhen?: string[]; stopWhen?: string[] }>;
  supervisorCarryover?: string;
  supervisorWorkspaceRoot?: string;
  timeoutMs?: number;
  disableSyntheticCheckSupervisorOnRuleFailure?: boolean;
};

type SupervisorReviewErrorKind =
  | "provider_execution_error"
  | "schema_validation_error"
  | "execution_error";

export type SupervisorReviewOutcome = {
  review: SupervisorReviewResult;
  raw: string;
  promptLogRel: string;
  responseLogRel: string;
  parsedOk: boolean;
  traceLogRel: string;
  threadId?: string;
  error?: {
    kind: SupervisorReviewErrorKind;
    message: string;
    stack?: string;
    timeoutMs?: number;
    providerThreadId?: string;
    providerTurnId?: string;
  };
};

export type SupervisorRecoverySummaryInputs = {
  workspaceRoot: string;
  conversationId: string;
  documentText: string;
  providerName: string;
  model: string;
  supervisorModel?: string;
  supervisorModelReasoningEffort?: string;
  providerOptions?: Record<string, unknown>;
  permissionProfile?: ProviderPermissionProfile;
  agentsText?: string;
  workspaceListingText?: string;
  taggedFiles?: TaggedFileContext[];
  openFiles?: TaggedFileContext[];
  utilities?: UtilityStatus[];
  skills?: SkillMetadata[];
  skillsToInvoke?: SkillMetadata[];
  skillInstructions?: SkillInstruction[];
  configuredSystemMessage?: PromptMessageOverride;
  supervisorInstructions?: string[];
  currentMode?: string;
  currentInstruction?: string;
  stopCondition?: string;
  supervisorWorkspaceRoot?: string;
  timeoutMs?: number;
};

const PRECOMPACT_SKELETON_BYTES = 128 * 1024;
const CLAUDE_CONTEXT_RETRY_OPTIONS = {
  maxSourceBytes: 192 * 1024,
  maxTailBlocks: 12,
  maxInlineBytes: 96,
  kindsToOffload: ["tool_result", "tool_call", "chat"],
};

type ReviewPromptBundle = {
  prompt: ReturnType<typeof compileSupervisorReview>;
  managedContext: Awaited<ReturnType<typeof buildManagedSupervisorReviewContext>>;
  runHistory: Awaited<ReturnType<typeof buildSupervisorRunHistoryContext>>;
  reviewContextText: string;
};

const SUPERVISOR_RECOVERY_PACKET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["relevant_facts", "current_execution_state", "do_this_next", "focus", "avoid", "stop_condition"],
  properties: {
    relevant_facts: {
      type: "array",
      items: { type: "string" },
    },
    current_execution_state: {
      type: "array",
      items: { type: "string" },
    },
    do_this_next: { type: "string" },
    focus: { type: "string" },
    avoid: {
      type: "array",
      items: { type: "string" },
    },
    stop_condition: {
      type: ["string", "null"],
    },
  },
} as const;

export async function runSupervisorRecoverySummary(
  input: SupervisorRecoverySummaryInputs,
): Promise<{
  packet: SupervisorRecoveryPacket;
  raw: string;
  promptLogRel: string;
  responseLogRel: string;
  traceLogRel: string;
}> {
  const supervisorWorkspaceRoot =
    input.supervisorWorkspaceRoot ??
    path.join(input.workspaceRoot, ".ai-supervisor", "supervisor", input.conversationId);
  await fs.mkdir(supervisorWorkspaceRoot, { recursive: true });
  const managedContext = await buildManagedSupervisorReviewContext({
    documentText: input.documentText,
    workspaceRoot: input.workspaceRoot,
    conversationId: input.conversationId,
    blobDir: path.join(supervisorWorkspaceRoot, "review_blobs"),
    blobPathBase: "review_blobs",
  });
  const runHistory = await buildSupervisorRunHistoryContext({
    workspaceRoot: input.workspaceRoot,
    currentConversationId: input.conversationId,
    currentSupervisorThreadId: undefined,
  });
  const recoveryContextText = [
    "## Active Conversation Tail Skeleton",
    managedContext.skeletonText,
    "",
    "## Latest Review Priorities",
    runHistory.priorityText,
    "",
    "## Incremental Changes Since Last Supervisor Review",
    runHistory.deltaText,
    "",
    "## Run-Wide Supervisor View",
    runHistory.overviewText,
  ].join("\n").trim();
  const prompt = compileSupervisorRecoverySummary({
    documentText: recoveryContextText,
    workspaceRoot: input.workspaceRoot,
    provider: input.providerName as ProviderName,
    supervisorInstructions: input.supervisorInstructions,
    model: input.supervisorModel ?? input.model,
    agentsMd: input.agentsText,
    workspaceListing: input.workspaceListingText,
    taggedFiles: input.taggedFiles,
    openFiles: input.openFiles,
    utilities: input.utilities,
    skills: input.skills,
    skillsToInvoke: input.skillsToInvoke,
    skillInstructions: input.skillInstructions,
    configuredSystemMessage: input.configuredSystemMessage,
    currentMode: input.currentMode,
    currentInstruction: input.currentInstruction,
    stopCondition: input.stopCondition,
    responseSchema: SUPERVISOR_RECOVERY_PACKET_SCHEMA,
  });

  const logId = newId("recovery");
  const logDirName = "recovery_packets";
  const baseDir = path.join(input.workspaceRoot, ".ai-supervisor", "conversations", input.conversationId, logDirName);
  const promptLogRel = path.join(".ai-supervisor", "conversations", input.conversationId, logDirName, `${logId}_prompt.txt`);
  const responseLogRel = path.join(".ai-supervisor", "conversations", input.conversationId, logDirName, `${logId}_response.txt`);
  const traceLogRel = path.join(".ai-supervisor", "conversations", input.conversationId, logDirName, `${logId}_trace.log`);
  const traceAbs = path.join(input.workspaceRoot, traceLogRel);
  const trace = async (line: string) => {
    try {
      await fs.appendFile(traceAbs, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch {
      // ignore trace failures
    }
  };

  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(path.join(input.workspaceRoot, promptLogRel), prompt.promptText, "utf8");
  await trace(`start current_mode=${input.currentMode ?? "(unknown)"} model=${input.supervisorModel ?? input.model}`);
  await trace(`prompt_bytes=${Buffer.byteLength(prompt.promptText, "utf8")} prompt_log=${promptLogRel}`);

  const reviewer = createProvider({
    provider: input.providerName as any,
    model: input.supervisorModel ?? input.model,
    workingDirectory: supervisorWorkspaceRoot,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    permissionProfile: input.permissionProfile ?? "workspace_no_network",
    skipGitRepoCheck: true,
    modelReasoningEffort: input.supervisorModelReasoningEffort,
    providerOptions: input.providerOptions,
  } as ProviderConfig);

  try {
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? 120000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Supervisor recovery summary timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    });
    await trace(`run_once timeout_ms=${timeoutMs}`);
    const review = await Promise.race([
      reviewer.runOnce(prompt.prompt, { outputSchema: SUPERVISOR_RECOVERY_PACKET_SCHEMA, signal: controller.signal }),
      timeoutPromise,
    ]) as { text?: string };
    const raw = String(review?.text ?? "");
    await fs.writeFile(path.join(input.workspaceRoot, responseLogRel), raw, "utf8");
    const parsed = parseJsonSafe(raw);
    if (!parsed.ok) {
      throw new Error("Supervisor recovery summary is not valid JSON");
    }
    const schemaError = validateSchemaValue(parsed.value, SUPERVISOR_RECOVERY_PACKET_SCHEMA as unknown as JsonSchemaNode);
    if (schemaError) {
      throw new Error(`Supervisor recovery summary failed schema validation: ${schemaError}`);
    }
    const packet = parsed.value as SupervisorRecoveryPacket;
    return { packet, raw, promptLogRel, responseLogRel, traceLogRel };
  } finally {
    try {
      await reviewer.close?.();
    } catch {
      // best-effort cleanup
    }
  }
}

export async function runSupervisorReview(input: SupervisorReviewInputs): Promise<SupervisorReviewOutcome> {
  const stopReasons = input.stopReasons && input.stopReasons.length ? input.stopReasons : ["manual"];
  const agentRules = input.agentRules ?? [];
  const agentRuleViolations = input.agentRuleViolations ?? [];
  const allowedNextModes = input.allowedNextModes ?? [];
  const configuredSystemMessage = resolveSupervisorConfiguredSystemMessage({
    configuredSystemMessage: input.configuredSystemMessage,
    supervisorTriggers: input.supervisorTriggers,
    mode: input.mode ?? "hard",
    trigger: input.trigger,
  });
  const appendMessageTemplates = messageTemplateSpecsForReview({
    supervisorMode: input.mode ?? "hard",
    reviewTrigger: input.trigger,
    supervisorTriggers: input.supervisorTriggers,
  });
  const responseSchema = buildSupervisorResponseSchema({
    trigger: input.trigger,
    mode: input.mode ?? "hard",
    allowedNextModes,
    modePayloadFieldsByMode: input.modePayloadFieldsByMode,
    appendMessageTemplates,
    agentViolationRules: agentRuleViolations,
  });
  const supervisorWorkspaceRoot =
    input.supervisorWorkspaceRoot ??
    path.join(input.workspaceRoot, ".ai-supervisor", "supervisor", input.conversationId);
  await fs.mkdir(supervisorWorkspaceRoot, { recursive: true });
  const buildPromptBundle = async (
    contextOptions?: {
      maxSourceBytes?: number;
      maxTailBlocks?: number;
      maxInlineBytes?: number;
      kindsToOffload?: string[];
    },
  ): Promise<ReviewPromptBundle> => {
    const managedContext = await buildManagedSupervisorReviewContext({
      documentText: input.documentText,
      workspaceRoot: input.workspaceRoot,
      conversationId: input.conversationId,
      blobDir: path.join(supervisorWorkspaceRoot, "review_blobs"),
      blobPathBase: "review_blobs",
      ...contextOptions,
    });
    const runHistory = await buildSupervisorRunHistoryContext({
      workspaceRoot: input.workspaceRoot,
      currentConversationId: input.conversationId,
      currentSupervisorThreadId: input.threadId,
    });
    const reviewContextText = [
      "## Active Conversation Tail Skeleton",
      managedContext.skeletonText,
      "",
      "## Latest Review Priorities",
      runHistory.priorityText,
      "",
      "## Incremental Changes Since Last Supervisor Review",
      runHistory.deltaText,
      "",
      "## Run-Wide Supervisor View",
      runHistory.overviewText,
    ]
      .join("\n")
      .trim();
    const prompt = compileSupervisorReview({
      documentText: reviewContextText,
      workspaceRoot: input.workspaceRoot,
      provider: input.providerName as ProviderName,
      agentRules: input.agentRules,
      agentRuleViolations,
      supervisorInstructions: input.supervisorInstructions,
      assistantText: input.assistantText ?? "",
      stopReasons,
      model: input.model,
      agentsMd: input.agentsText,
      workspaceListing: input.workspaceListingText,
      taggedFiles: input.taggedFiles,
      openFiles: input.openFiles,
      utilities: input.utilities,
      skills: input.skills,
      skillsToInvoke: input.skillsToInvoke,
      skillInstructions: input.skillInstructions,
      configuredSystemMessage,
      stopCondition: input.stopCondition,
      currentMode: input.currentMode,
      allowedNextModes,
      trigger: input.trigger,
      modePayloadFieldsByMode: input.modePayloadFieldsByMode,
      modeGuidanceByMode: input.modeGuidanceByMode,
      responseSchema,
      supervisorCarryover: input.supervisorCarryover,
      mode: input.mode ?? "hard",
      agentModel: input.agentModel ?? input.model,
      supervisorModel: input.supervisorModel ?? input.model,
      disableSyntheticCheckSupervisorOnRuleFailure: input.disableSyntheticCheckSupervisorOnRuleFailure,
    });
    return {
      prompt,
      managedContext,
      runHistory,
      reviewContextText,
    };
  };
  let promptBundle = await buildPromptBundle();
  let prompt = promptBundle.prompt;
  let managedContext = promptBundle.managedContext;
  let runHistory = promptBundle.runHistory;
  const logDirName = "reviews";
  const logId = newId("review");
  const baseDir = path.join(input.workspaceRoot, ".ai-supervisor", "conversations", input.conversationId, logDirName);
  const promptLogRel = path.join(".ai-supervisor", "conversations", input.conversationId, logDirName, `${logId}_prompt.txt`);
  const responseLogRel = path.join(".ai-supervisor", "conversations", input.conversationId, logDirName, `${logId}_response.txt`);
  const traceLogRel = path.join(".ai-supervisor", "conversations", input.conversationId, logDirName, `${logId}_trace.log`);
  const traceAbs = path.join(input.workspaceRoot, traceLogRel);
  const trace = async (line: string) => {
    try {
      await fs.appendFile(traceAbs, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch {
      // ignore trace failures
    }
  };
  try {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(path.join(input.workspaceRoot, promptLogRel), prompt.promptText, "utf8");
    await trace(
      `start mode=${input.mode ?? "hard"} current_mode=${input.currentMode ?? "(unknown)"} model=${input.supervisorModel ?? input.model} agent_reasoning=${input.agentModelReasoningEffort ?? "(default)"} supervisor_reasoning=${input.supervisorModelReasoningEffort ?? input.modelReasoningEffort ?? "(default)"}`,
    );
    await trace(`prompt_bytes=${Buffer.byteLength(prompt.promptText, "utf8")} prompt_log=${promptLogRel}`);
    await trace(
        `managed_context original_bytes=${managedContext.originalBytes} managed_bytes=${managedContext.managedBytes} skeleton_bytes=${managedContext.skeletonBytes} dropped_blocks=${managedContext.droppedBlocks} offloaded_blocks=${managedContext.offloadedBlocks} offloaded_bytes=${managedContext.offloadedBytes} run_history_forks=${runHistory.index.forks.length} run_history_new_forks=${runHistory.newForkCount}`,
      );
  } catch {
    // Best-effort logging; continue if filesystem write fails.
  }
  const reviewLane = await claimSupervisorReviewLane({
    workspaceRoot: input.workspaceRoot,
    conversationId: input.conversationId,
    threadId: input.threadId,
  });
  const supervisorThreadSeed = reviewLane.threadId;

  const reviewer = createProvider({
    provider: input.providerName as any,
    model: input.supervisorModel ?? input.model,
    workingDirectory: supervisorWorkspaceRoot,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    permissionProfile: input.permissionProfile ?? "workspace_no_network",
    skipGitRepoCheck: true,
    threadId: supervisorThreadSeed,
    modelReasoningEffort: input.supervisorModelReasoningEffort ?? input.modelReasoningEffort,
    providerOptions: input.providerOptions,
  } as ProviderConfig);
  const activeReviewPromise = (async () => {
  try {
    const timeoutMs = input.timeoutMs ?? 120000;
    const maxSchemaRetries = 1;
    let reviewPrompt: PromptContent = prompt.prompt;
    let reviewText = "";
    let supervisorThreadId = supervisorThreadSeed;
    let errorInfo: SupervisorReviewOutcome["error"] | undefined, parsedOk = false, parsedReview = parseJsonSafe(reviewText);
    let providerCompactionRetryUsed = false;
    let localPromptRetryUsed = false;
    const overflowRecovery = getProviderOverflowRecovery(input.providerName as ProviderName);
    if (managedContext.skeletonBytes >= PRECOMPACT_SKELETON_BYTES) {
      const preflight = await overflowRecovery.prepareSupervisorReview<ReviewPromptBundle>({
        reason: `preflight_large_skeleton_bytes_${managedContext.skeletonBytes}`,
        skeletonBytes: managedContext.skeletonBytes,
        compactThread: reviewer.compactThread?.bind(reviewer),
        rebuildPrompt: () => buildPromptBundle(CLAUDE_CONTEXT_RETRY_OPTIONS),
      });
      if (preflight.mode === "local_prompt_rebuild" && preflight.nextPromptState) {
        promptBundle = preflight.nextPromptState;
        prompt = promptBundle.prompt;
        managedContext = promptBundle.managedContext;
        runHistory = promptBundle.runHistory;
        reviewPrompt = prompt.prompt;
        localPromptRetryUsed = true;
        await trace(
          `preflight_local_compaction skeleton_bytes=${managedContext.skeletonBytes} managed_bytes=${managedContext.managedBytes} dropped_blocks=${managedContext.droppedBlocks} offloaded_blocks=${managedContext.offloadedBlocks}`,
        );
      } else if (preflight.mode === "provider_compaction") {
        if (preflight.threadId) supervisorThreadId = preflight.threadId;
        await trace(
          `compaction_result reason=preflight_large_skeleton_bytes_${managedContext.skeletonBytes} compacted=${String(preflight.applied)} thread_id=${preflight.threadId ?? "(none)"} detail=${preflight.details ?? "(none)"}`,
        );
      }
    }
    for (let attempt = 0; attempt <= maxSchemaRetries; attempt += 1) {
      const controller = new AbortController();
      let timeout: NodeJS.Timeout | undefined;
      let runPromise: Promise<{ text?: string; threadId?: string }> | undefined;
      const abortReviewRun = () => controller.abort();
      if (reviewLane.controller.signal.aborted) {
        abortReviewRun();
      } else {
        reviewLane.controller.signal.addEventListener("abort", abortReviewRun, { once: true });
      }
      try {
        await trace(`run_once attempt=${attempt + 1} timeout_ms=${timeoutMs}`);
        runPromise = reviewer.runOnce(reviewPrompt, { outputSchema: responseSchema, signal: controller.signal });
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`Supervisor review timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        const review = (await Promise.race([runPromise, timeoutPromise])) as { text?: string; threadId?: string };
        reviewText = String(review?.text ?? "");
        supervisorThreadId = review?.threadId ?? supervisorThreadId;
        reviewLane.updateThreadId(supervisorThreadId);
        await trace(`response_bytes attempt=${attempt + 1} value=${Buffer.byteLength(reviewText, "utf8")}`);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        const timedOut = message.includes("timed out after") || err?.name === "AbortError";
        const providerThreadId = typeof err?.threadId === "string" ? String(err.threadId) : supervisorThreadId;
        const providerTurnId = typeof err?.turnId === "string" ? String(err.turnId) : undefined;
        if (providerThreadId) {
          supervisorThreadId = providerThreadId;
          reviewLane.updateThreadId(providerThreadId);
        }
        const errorKind: SupervisorReviewErrorKind =
          err?.name === "ProviderExecutionError" ? "provider_execution_error" : "execution_error";
        if (looksLikeContextWindowError(message)) {
          const recovery: SupervisorOverflowRecoveryResult<ReviewPromptBundle> =
            await overflowRecovery.recoverSupervisorReview<ReviewPromptBundle>({
            retryUsed: localPromptRetryUsed || providerCompactionRetryUsed,
            reason: `context_overflow_attempt_${attempt + 1}`,
            compactThread: reviewer.compactThread?.bind(reviewer),
            rebuildPrompt: () => buildPromptBundle(CLAUDE_CONTEXT_RETRY_OPTIONS),
            });
          if (recovery.mode === "local_prompt_rebuild" && recovery.nextPromptState) {
            localPromptRetryUsed = recovery.retryUsed;
            promptBundle = recovery.nextPromptState;
            prompt = promptBundle.prompt;
            managedContext = promptBundle.managedContext;
            runHistory = promptBundle.runHistory;
            reviewPrompt = prompt.prompt;
            await trace(
              `context_overflow_detected attempt=${attempt + 1} retrying_with_local_compaction=true managed_bytes=${managedContext.managedBytes} skeleton_bytes=${managedContext.skeletonBytes} dropped_blocks=${managedContext.droppedBlocks} offloaded_blocks=${managedContext.offloadedBlocks}`,
            );
            attempt -= 1;
            continue;
          }
          if (recovery.mode === "provider_compaction") {
            providerCompactionRetryUsed = recovery.retryUsed;
            if (recovery.threadId) {
              supervisorThreadId = recovery.threadId;
              reviewLane.updateThreadId(recovery.threadId);
            }
            await trace(`context_overflow_detected attempt=${attempt + 1} retrying_with_compaction=true`);
            await trace(
              `compaction_result reason=context_overflow_attempt_${attempt + 1} compacted=${String(recovery.retry)} thread_id=${recovery.threadId ?? "(none)"} detail=${recovery.details ?? "(none)"}`,
            );
            if (recovery.retry) {
              attempt -= 1;
              continue;
            }
          }
        }
        if (timedOut) {
          try {
            runPromise?.catch(() => {});
          } catch {
            // ignore
          }
        }
        errorInfo = {
          kind: errorKind,
          message,
          stack: err?.stack ? String(err.stack) : undefined,
          timeoutMs: timedOut ? timeoutMs : undefined,
          providerThreadId,
          providerTurnId,
        };
        reviewText = JSON.stringify({
          error_type: errorKind,
          error: message,
          provider_thread_id: providerThreadId ?? null,
          provider_turn_id: providerTurnId ?? null,
        }, null, 2);
        await trace(
          `provider_failure attempt=${attempt + 1} kind=${errorKind} thread_id=${providerThreadId ?? "(none)"} turn_id=${providerTurnId ?? "(none)"} message=${message.replace(/\s+/g, " ").trim()}`,
        );
        if (errorInfo?.stack) {
          await trace(errorInfo.stack);
        }
        break;
      } finally {
        if (timeout) clearTimeout(timeout);
        reviewLane.controller.signal.removeEventListener("abort", abortReviewRun);
      }
      const rawTrimmed = reviewText.trim();
      parsedReview = parseJsonSafe(reviewText);
      let schemaError: string | undefined;
      if (!rawTrimmed) {
        schemaError = "empty supervisor response";
      } else if (!parsedReview.ok) {
        schemaError = "supervisor response is not valid JSON";
      } else {
        schemaError = validateSchemaValue(parsedReview.value, responseSchema as unknown as JsonSchemaNode);
        if (!schemaError) {
          const normalizedCandidate = normalizeReview({
            raw: parsedReview.value,
            trigger: input.trigger,
            mode: input.mode ?? "hard",
            agentRules,
            agentRuleViolations,
          });
          const semanticError = validateReviewSemantic({
            review: normalizedCandidate,
            trigger: input.trigger,
            mode: input.mode ?? "hard",
            agentRules,
            agentRuleViolations,
            allowedNextModes,
            modePayloadFieldsByMode: input.modePayloadFieldsByMode,
            appendMessageTemplates,
          });
          if (semanticError) schemaError = semanticError;
        }
      }
      if (!schemaError) {
        parsedOk = true;
        break;
      }
      await trace(`schema_error attempt=${attempt + 1} detail=${schemaError}`);
      if (attempt < maxSchemaRetries) {
        reviewPrompt = buildSchemaRetryPrompt(reviewPrompt, schemaError, rawTrimmed);
        await trace(`schema_retry scheduled next_attempt=${attempt + 2}`);
        continue;
      }
      const message = `Supervisor response failed schema validation: ${schemaError}`;
      if (!errorInfo) errorInfo = { kind: "schema_validation_error", message };
      reviewText = JSON.stringify(
        {
          error_type: "schema_validation_error",
          error: message,
          response_excerpt: rawTrimmed.slice(0, 2000),
        },
        null,
        2,
      );
      parsedReview = parseJsonSafe(reviewText);
      parsedOk = false;
      break;
    }
    if (reviewText) {
      try {
        await fs.writeFile(path.join(input.workspaceRoot, responseLogRel), reviewText, "utf8");
      } catch {
        // Best-effort logging; continue if filesystem write fails.
      }
    }
    let normalized =
      parsedOk && parsedReview.ok
        ? normalizeReview({
            raw: parsedReview.value,
            trigger: input.trigger,
            mode: input.mode ?? "hard",
            agentRules,
            agentRuleViolations,
          })
        : fallbackReview({
            trigger: input.trigger,
            mode: input.mode ?? "hard",
            agentRules,
            agentRuleViolations,
            reason: "Supervisor response was invalid. Returning control safely.",
          });
    if (parsedOk) {
      const semanticError = validateReviewSemantic({
        review: normalized,
        trigger: input.trigger,
        mode: input.mode ?? "hard",
        agentRules,
        agentRuleViolations,
        allowedNextModes,
        modePayloadFieldsByMode: input.modePayloadFieldsByMode,
        appendMessageTemplates,
      });
      if (semanticError) {
        errorInfo = errorInfo ?? {
          kind: "schema_validation_error",
          message: `Supervisor response failed schema validation: ${semanticError}`,
        };
        parsedOk = false;
        normalized = fallbackReview({
          trigger: input.trigger,
          mode: input.mode ?? "hard",
          agentRules,
          agentRuleViolations,
          reason: "Supervisor response failed semantic validation. Returning control safely.",
        });
      }
    }
    await persistSupervisorRunHistoryWatermark({
      workspaceRoot: input.workspaceRoot,
      currentConversationId: input.conversationId,
      priorSupervisorThreadId: input.threadId,
      nextSupervisorThreadId: supervisorThreadId,
      seenForkKeys: runHistory.seenForkKeys,
    });
    return {
      review: normalized,
      raw: reviewText,
      promptLogRel,
      responseLogRel,
      parsedOk,
      traceLogRel,
      threadId: supervisorThreadId,
      error: errorInfo,
    };
  } finally {
    try {
      await reviewer.close?.();
    } catch {
      // best-effort cleanup
    }
  }
  })();
  reviewLane.setPromise(activeReviewPromise);
  try {
    return await activeReviewPromise;
  } finally {
    reviewLane.release();
  }
}
