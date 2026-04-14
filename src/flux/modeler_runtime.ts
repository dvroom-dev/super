import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { markFluxInvocationStatus, persistFluxInvocationInput, saveFluxInvocationResult } from "./invocations.js";
import { appendProjectionEventsAndRebuild } from "./projections.js";
import { parseJsonObjectFromAssistantText, schemaForName } from "./json_session_format.js";
import { runModelAcceptance } from "./model_acceptance.js";
import { buildCoverageSummary, computeModelProgress, preferCoverageSummary } from "./model_coverage.js";
import { modelRevisionWorkspaceSource, persistModelRevisionWorkspace, publishCurrentModelWorkspace, saveCurrentModelHead, saveModelCoverageSummary } from "./model_revision_store.js";
import { loadFluxPromptTemplate } from "./prompt_templates.js";
import { runFluxProblemCommand } from "./problem_shell.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { loadSeedMeta } from "./seed_meta.js";
import { appendFluxMessage, loadFluxSession, saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxQueueItem, FluxRunState, FluxSessionRecord } from "./types.js";
import { fluxModelRoot } from "./paths.js";
import {
  buildFeatureLabelPrompt,
  buildModelerContinuePrompt,
  buildSolverTheoryInterjection,
  coverageSummaryFromSeedMeta,
  consumeSupersedingModelerInput,
  deriveFeatureLabelTargetLevel,
  deriveAcceptanceTargetLevelFromState,
  deriveContinuationAcceptanceTarget,
  deriveInvocationAcceptanceTargetLevel,
  fallbackModelOutput,
  firstFailingReport,
  hasConcreteAcceptanceMismatch,
  hasModelerTheoryMarkdown,
  inferAcceptanceInfrastructureFailure,
  isBlockedModelOutput,
  loadFeatureBoxes,
  loadBestProgress,
  loadCurrentModelCoverageSummary,
  loadCurrentModelRevisionId,
  modelSessionId,
  modelerTheoryMarkdownRelativePath,
  persistFeatureLabels,
  prepareModelDraftWorkspace,
  publishBootstrapSignals,
  publishProgressAdvance,
  validateFeatureLabels,
} from "./modeler_runtime_helpers.js";

type ActiveModelerControl = {
  controller: AbortController;
  interruptRequested: boolean;
};

const activeModelerControls = new Map<string, ActiveModelerControl>();

function nowIso(): string {
  return new Date().toISOString();
}

function siblingPromptFile(promptFile: string, replacement: string): string {
  return path.join(path.dirname(promptFile), replacement).replace(/\\/g, "/");
}
export {
  deriveAcceptanceTargetLevelFromState,
  deriveContinuationAcceptanceTarget,
} from "./modeler_runtime_helpers.js";

export function requestActiveModelerInterrupt(sessionId: string): boolean {
  const control = activeModelerControls.get(sessionId);
  if (!control || control.interruptRequested) return false;
  control.interruptRequested = true;
  control.controller.abort();
  return true;
}
async function persistAcceptedModel(
  workspaceRoot: string,
  config: FluxConfig,
  modelOutput: Record<string, unknown>,
  comparePayload: Record<string, unknown>,
  sourceWorkspaceDir: string,
): Promise<string> {
  const revisionId = newId("model_rev");
  const currentDir = path.join(fluxModelRoot(workspaceRoot, config), "current");
  const revisionDir = path.join(fluxModelRoot(workspaceRoot, config), "revisions", revisionId);
  await fs.mkdir(currentDir, { recursive: true });
  await fs.mkdir(revisionDir, { recursive: true });
  await writeJsonAtomic(path.join(revisionDir, "model_update.json"), modelOutput);
  await writeJsonAtomic(path.join(currentDir, "model_update.json"), modelOutput);
  await persistModelRevisionWorkspace({
    workspaceRoot,
    config,
    revisionId,
    sourceWorkspaceDir,
  });
  await publishCurrentModelWorkspace({
    workspaceRoot,
    config,
    sourceWorkspaceDir,
  });
  const candidateSummary = buildCoverageSummary({ comparePayload, accepted: true });
  const currentSummary = await loadCurrentModelCoverageSummary(workspaceRoot, config);
  const seedMeta = await loadSeedMeta(workspaceRoot, config);
  const durableSummary = preferCoverageSummary(
    coverageSummaryFromSeedMeta(seedMeta.lastQueuedBootstrapCoverageSummary)
      ?? coverageSummaryFromSeedMeta(seedMeta.lastBootstrapperCoverageSummary)
      ?? currentSummary,
    candidateSummary,
  );
  await saveModelCoverageSummary({
    workspaceRoot,
    config,
    revisionId,
    summary: durableSummary,
  });
  await saveCurrentModelHead({
    workspaceRoot,
    config,
    revisionId,
    summary: durableSummary,
  });
  return revisionId;
}

export async function runModelerQueueItem(args: {
  workspaceRoot: string;
  config: FluxConfig;
  queueItem: FluxQueueItem;
  state: FluxRunState;
}): Promise<void> {
  const sessionId = modelSessionId();
  const invocationId = args.queueItem.id;
  await persistFluxInvocationInput(args.workspaceRoot, args.config, {
    invocationId,
    invocationType: "modeler_invocation",
    sessionType: "modeler",
    createdAt: args.queueItem.createdAt,
    reason: args.queueItem.reason,
    payload: { ...args.queueItem.payload },
  });
  const existing = await loadFluxSession(args.workspaceRoot, args.config, "modeler", sessionId);
  const session: FluxSessionRecord = existing ?? {
    sessionId,
    sessionType: "modeler",
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    provider: args.config.modeler.provider ?? args.config.runtimeDefaults.provider,
    model: args.config.modeler.model ?? args.config.runtimeDefaults.model,
    resumePolicy: "always",
    sessionScope: "run",
  };
  session.status = "running";
  session.stopReason = undefined;
  session.activeInvocationId = invocationId;
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  await markFluxInvocationStatus({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    invocationId,
    sessionType: "modeler",
    status: "running",
    sessionId,
  });
  await appendProjectionEventsAndRebuild({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    configPath: args.state.configPath,
    events: [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "projection.slot_updated",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId,
      invocationId,
      summary: `active modeler invocation ${invocationId} started`,
      payload: {
        active: {
          sessionId,
          invocationId,
          status: "running",
          queueItemId: args.queueItem.id,
          pid: process.pid,
          updatedAt: nowIso(),
        },
      },
    }],
  });
  const promptTemplate = await loadFluxPromptTemplate(args.workspaceRoot, args.config.modeler.promptFile);
  const boxLabelPromptTemplate = await loadFluxPromptTemplate(
    args.workspaceRoot,
    siblingPromptFile(args.config.modeler.promptFile, "modeler_boxes.md"),
  );
  const continueTemplate = await loadFluxPromptTemplate(
    args.workspaceRoot,
    args.config.modeler.acceptance.continueMessageTemplateFile,
  );
  const modelDraftWorkspaceDir = await prepareModelDraftWorkspace({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    invocationId,
  });
  let promptPayload = args.queueItem.payload;
  let continueTurns = 0;
  let continueAcceptanceMessage: string | null = null;
  let continueFailingReport: Record<string, unknown> | null = null;
  let boxLabelValidationError: string | null = null;
  let boxLabelValidationFailures = 0;
  const invocationAcceptanceMaxLevel = await deriveInvocationAcceptanceTargetLevel({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    promptPayload: args.queueItem.payload,
  });
  let continueAcceptanceTarget: { maxLevel?: number | null; level?: number | null; sequenceId?: string | null } | null = null;

  for (;;) {
    const freshlySupersedingPayload = await consumeSupersedingModelerInput({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      activeInvocationId: invocationId,
      sessionId,
    });
    if (freshlySupersedingPayload) {
      promptPayload = freshlySupersedingPayload;
    }
    if (args.config.problem.syncModelWorkspace) {
      await runFluxProblemCommand(args.config.problem.syncModelWorkspace, {
        workspaceRoot: args.workspaceRoot,
        queueItem: args.queueItem,
        reason: continueTurns === 0 ? args.queueItem.reason : "modeler_continue",
        evidenceBundleId: typeof promptPayload.evidenceBundleId === "string" ? promptPayload.evidenceBundleId : undefined,
        evidenceBundlePath: typeof promptPayload.evidenceBundlePath === "string" ? promptPayload.evidenceBundlePath : undefined,
        targetWorkspaceDir: modelDraftWorkspaceDir,
      });
    }
    const solverTheoryInterjection = await buildSolverTheoryInterjection({
      workspaceDir: modelDraftWorkspaceDir,
      lastInjectedLevel: session.lastInjectedSolverTheoryLevel,
    });
    if (solverTheoryInterjection) {
      session.lastInjectedSolverTheoryLevel = solverTheoryInterjection.level;
      session.updatedAt = nowIso();
      await saveFluxSession(args.workspaceRoot, args.config, session);
    }

    const preflightModelOutput = {
      decision: "checked_current_model",
      summary: "preflight compare of current model against latest evidence",
      message_for_bootstrapper: "",
      artifacts_updated: [],
      evidence_watermark: String(promptPayload.evidenceWatermark ?? ""),
    };
    const preflightAcceptance = await runModelAcceptance({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      modelOutput: preflightModelOutput,
      modelRevisionId: await loadCurrentModelRevisionId(args.workspaceRoot, args.config),
      evidenceBundleId: typeof promptPayload.evidenceBundleId === "string" ? promptPayload.evidenceBundleId : null,
      evidenceBundlePath: typeof promptPayload.evidenceBundlePath === "string" ? promptPayload.evidenceBundlePath : null,
      targetWorkspaceDir: modelDraftWorkspaceDir,
      acceptanceTarget: continueAcceptanceTarget ?? (
        invocationAcceptanceMaxLevel
          ? { maxLevel: invocationAcceptanceMaxLevel, level: invocationAcceptanceMaxLevel }
          : null
      ),
    });
    const preflightComparePayload = preflightAcceptance.payload.compare_payload
      && typeof preflightAcceptance.payload.compare_payload === "object"
      && !Array.isArray(preflightAcceptance.payload.compare_payload)
      ? preflightAcceptance.payload.compare_payload as Record<string, unknown>
      : {};
    const preflightInfrastructureFailure = await inferAcceptanceInfrastructureFailure({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      acceptanceMessage: preflightAcceptance.message,
      comparePayload: preflightComparePayload,
      existing: preflightAcceptance.infrastructureFailure,
      targetWorkspaceDir: modelDraftWorkspaceDir,
    });
    const previousProgress = await loadBestProgress(args.workspaceRoot, args.config);
    const preflightProgress = computeModelProgress(preflightComparePayload);
    if (preflightAcceptance.accepted) {
      const currentRevisionId = await loadCurrentModelRevisionId(args.workspaceRoot, args.config)
        ?? await persistAcceptedModel(args.workspaceRoot, args.config, preflightModelOutput, preflightComparePayload, modelDraftWorkspaceDir);
      await publishBootstrapSignals({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        comparePayload: preflightComparePayload,
        currentProgress: preflightProgress,
        previousProgress,
        modelOutput: preflightModelOutput,
        modelRevisionId: currentRevisionId,
        promptPayload,
        sessionId,
      });
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "modeler.acceptance_passed",
        workspaceRoot: args.workspaceRoot,
        invocationId,
        sessionType: "modeler",
        sessionId,
        summary: "current model already matches latest evidence",
        payload: { revisionId: currentRevisionId },
      }]);
      session.status = "idle";
      session.stopReason = undefined;
      session.updatedAt = nowIso();
      await saveFluxSession(args.workspaceRoot, args.config, session);
      await saveFluxInvocationResult(args.workspaceRoot, args.config, {
        invocationId,
        invocationType: "modeler_invocation",
        sessionType: "modeler",
        status: "completed",
        recordedAt: nowIso(),
        summary: "current model already matches latest evidence",
        payload: {
          sessionId,
          accepted: true,
          comparePayload: preflightComparePayload,
          revisionId: currentRevisionId,
        },
      });
      await markFluxInvocationStatus({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        invocationId,
        sessionType: "modeler",
        status: "completed",
        sessionId,
      });
      await appendProjectionEventsAndRebuild({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        configPath: args.state.configPath,
        events: [{
          eventId: newId("evt"),
          ts: nowIso(),
          kind: "projection.slot_updated",
          workspaceRoot: args.workspaceRoot,
          sessionType: "modeler",
          sessionId,
          invocationId,
          summary: `active modeler invocation ${invocationId} cleared`,
          payload: { active: { sessionId, invocationId, status: "idle", updatedAt: nowIso() } },
        }],
      });
      return;
    }
    if (preflightInfrastructureFailure) {
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "modeler.acceptance_failed",
        workspaceRoot: args.workspaceRoot,
        invocationId,
        sessionType: "modeler",
        sessionId,
        summary: preflightAcceptance.message || "model preflight compare failed",
        payload: {
          blocked: false,
          infrastructureFailure: preflightInfrastructureFailure,
        },
      }]);
      session.status = "idle";
      session.stopReason = undefined;
      session.updatedAt = nowIso();
      await saveFluxSession(args.workspaceRoot, args.config, session);
      await saveFluxInvocationResult(args.workspaceRoot, args.config, {
        invocationId,
        invocationType: "modeler_invocation",
        sessionType: "modeler",
        status: "failed",
        recordedAt: nowIso(),
        summary: preflightAcceptance.message || "model preflight compare failed",
        payload: {
          sessionId,
          infrastructureFailure: preflightInfrastructureFailure,
          comparePayload: preflightComparePayload,
        },
      });
      await markFluxInvocationStatus({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        invocationId,
        sessionType: "modeler",
        status: "failed",
        sessionId,
        error: preflightAcceptance.message || "model preflight compare failed",
      });
      await appendProjectionEventsAndRebuild({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        configPath: args.state.configPath,
        events: [{
          eventId: newId("evt"),
          ts: nowIso(),
          kind: "projection.slot_updated",
          workspaceRoot: args.workspaceRoot,
          sessionType: "modeler",
          sessionId,
          invocationId,
          summary: `active modeler invocation ${invocationId} cleared`,
          payload: { active: { sessionId, invocationId, status: "idle", updatedAt: nowIso() } },
        }],
      });
      return;
    }

    const featureLabelLevel = deriveFeatureLabelTargetLevel({
      acceptanceTarget: continueAcceptanceTarget ?? (
        invocationAcceptanceMaxLevel
          ? { maxLevel: invocationAcceptanceMaxLevel, level: invocationAcceptanceMaxLevel }
          : null
      ),
      invocationAcceptanceMaxLevel,
      comparePayload: preflightComparePayload,
    });
    const featureBoxes = featureLabelLevel
      ? await loadFeatureBoxes({ workspaceDir: modelDraftWorkspaceDir, level: featureLabelLevel })
      : null;
    const featureLabelsValidation = featureLabelLevel
      ? await validateFeatureLabels({ workspaceDir: modelDraftWorkspaceDir, level: featureLabelLevel })
      : { ok: true as const, payload: {} as Record<string, unknown> };
    const boxLabelPhaseActive = Boolean(featureLabelLevel && featureBoxes && !featureLabelsValidation.ok);
    const featureLabelValidationReason = featureLabelsValidation.ok ? null : featureLabelsValidation.reason;

    let promptText: string;
    if (boxLabelPhaseActive) {
      promptText = buildFeatureLabelPrompt({
        template: boxLabelPromptTemplate,
        level: featureLabelLevel!,
        featureBoxes: featureBoxes!,
        validationError: boxLabelValidationError ?? featureLabelValidationReason,
      });
      if (solverTheoryInterjection) {
        promptText = [promptText, "", solverTheoryInterjection.text].join("\n");
      }
    } else if (continueTurns === 0) {
      const parts = [
        promptTemplate.trim(),
        solverTheoryInterjection?.text ?? "",
        `Modeling trigger: ${args.queueItem.reason}`,
        JSON.stringify(promptPayload, null, 2),
      ].filter(Boolean);
      promptText = parts.join("\n\n");
    } else {
      promptText = buildModelerContinuePrompt({
        template: continueTemplate,
        acceptanceMessage: continueAcceptanceMessage || "model acceptance failed",
        latestEvidenceWatermark: String(promptPayload.evidenceWatermark ?? ""),
        maxLevel: invocationAcceptanceMaxLevel,
        targetLevel: continueAcceptanceTarget?.level ?? null,
        targetSequenceId: continueAcceptanceTarget?.sequenceId ?? null,
        failingStep: Number(continueFailingReport?.divergence_step ?? 0) || null,
        failingReason: typeof continueFailingReport?.divergence_reason === "string" ? String(continueFailingReport.divergence_reason) : null,
        frameCountGame: Number(continueFailingReport?.frame_count_game ?? 0) || null,
        frameCountModel: Number(continueFailingReport?.frame_count_model ?? 0) || null,
      });
      if (solverTheoryInterjection) {
        promptText = [promptText, "", solverTheoryInterjection.text].join("\n");
      }
    }

    await appendFluxMessage(args.workspaceRoot, args.config, "modeler", sessionId, {
      messageId: newId("msg"),
      ts: nowIso(),
      turnIndex: Date.now(),
      invocationId,
      kind: "user",
      text: promptText,
    });
    const controller = new AbortController();
    activeModelerControls.set(sessionId, { controller, interruptRequested: false });
    const timeout = args.config.modeler.turnTimeoutMs ? setTimeout(() => controller.abort(), args.config.modeler.turnTimeoutMs) : null;
    let turn;
    try {
      turn = await runFluxProviderTurn({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        session,
        sessionType: "modeler",
        invocationId,
        promptText,
        reasoningEffort: args.config.modeler.reasoningEffort ?? args.config.runtimeDefaults.reasoningEffort,
        outputSchema: args.config.modeler.turnTimeoutMs
          ? undefined
          : schemaForName(boxLabelPhaseActive ? "model_box_labels_v1" : args.config.modeler.outputSchema),
        workingDirectory: modelDraftWorkspaceDir,
        signal: controller.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      activeModelerControls.delete(sessionId);
    }
    if (turn.interrupted) {
      session.status = "idle";
      session.stopReason = "interrupted";
      session.updatedAt = nowIso();
      await saveFluxSession(args.workspaceRoot, args.config, session);
      await saveFluxInvocationResult(args.workspaceRoot, args.config, {
        invocationId,
        invocationType: "modeler_invocation",
        sessionType: "modeler",
        status: "failed",
        recordedAt: nowIso(),
        summary: "modeler interrupted",
        payload: { sessionId, interrupted: true },
      });
      await markFluxInvocationStatus({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        invocationId,
        sessionType: "modeler",
        status: "failed",
        sessionId,
        error: "modeler interrupted",
      });
      await appendProjectionEventsAndRebuild({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        configPath: args.state.configPath,
        events: [{
          eventId: newId("evt"),
          ts: nowIso(),
          kind: "projection.slot_updated",
          workspaceRoot: args.workspaceRoot,
          sessionType: "modeler",
          sessionId,
          invocationId,
          summary: `active modeler invocation ${invocationId} cleared`,
          payload: { active: { sessionId, invocationId, status: "idle", updatedAt: nowIso() } },
        }],
      });
      return;
    }
    await appendFluxMessage(args.workspaceRoot, args.config, "modeler", sessionId, {
      messageId: newId("msg"),
      ts: nowIso(),
      turnIndex: Date.now(),
      invocationId,
      kind: "assistant",
      text: turn.assistantText,
      providerThreadId: turn.providerThreadId,
    });
    if (boxLabelPhaseActive) {
      const parsedLabels = parseJsonObjectFromAssistantText(turn.assistantText || "") ?? {};
      const reportedLevel = Number(parsedLabels.level ?? 0) || 0;
      if (reportedLevel !== featureLabelLevel) {
        boxLabelValidationError = `label response level mismatch: expected ${featureLabelLevel}, got ${reportedLevel || "(missing)"}`;
        boxLabelValidationFailures += 1;
        if (boxLabelValidationFailures >= 3) {
          const failureSummary = `feature box labeling failed repeatedly for level ${featureLabelLevel}: ${boxLabelValidationError}`;
          session.status = "idle";
          session.stopReason = undefined;
          session.updatedAt = nowIso();
          await saveFluxSession(args.workspaceRoot, args.config, session);
          await saveFluxInvocationResult(args.workspaceRoot, args.config, {
            invocationId,
            invocationType: "modeler_invocation",
            sessionType: "modeler",
            status: "failed",
            recordedAt: nowIso(),
            summary: failureSummary,
            payload: { sessionId, phase: "feature_boxes", reason: boxLabelValidationError },
          });
          await markFluxInvocationStatus({
            workspaceRoot: args.workspaceRoot,
            config: args.config,
            invocationId,
            sessionType: "modeler",
            status: "failed",
            sessionId,
            error: failureSummary,
          });
          await appendProjectionEventsAndRebuild({
            workspaceRoot: args.workspaceRoot,
            config: args.config,
            configPath: args.state.configPath,
            events: [{
              eventId: newId("evt"),
              ts: nowIso(),
              kind: "projection.slot_updated",
              workspaceRoot: args.workspaceRoot,
              sessionType: "modeler",
              sessionId,
              invocationId,
              summary: `active modeler invocation ${invocationId} cleared`,
              payload: { active: { sessionId, invocationId, status: "idle", updatedAt: nowIso() } },
            }],
          });
          return;
        }
        continueTurns += 1;
        continue;
      }
      await persistFeatureLabels({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        workspaceDir: modelDraftWorkspaceDir,
        level: featureLabelLevel!,
        labels: parsedLabels,
      });
      const refreshedValidation = await validateFeatureLabels({
        workspaceDir: modelDraftWorkspaceDir,
        level: featureLabelLevel!,
      });
      if (!refreshedValidation.ok) {
        boxLabelValidationError = refreshedValidation.reason;
        boxLabelValidationFailures += 1;
        if (boxLabelValidationFailures >= 3) {
          const failureSummary = `feature box labeling failed repeatedly for level ${featureLabelLevel}: ${boxLabelValidationError}`;
          session.status = "idle";
          session.stopReason = undefined;
          session.updatedAt = nowIso();
          await saveFluxSession(args.workspaceRoot, args.config, session);
          await saveFluxInvocationResult(args.workspaceRoot, args.config, {
            invocationId,
            invocationType: "modeler_invocation",
            sessionType: "modeler",
            status: "failed",
            recordedAt: nowIso(),
            summary: failureSummary,
            payload: { sessionId, phase: "feature_boxes", reason: boxLabelValidationError },
          });
          await markFluxInvocationStatus({
            workspaceRoot: args.workspaceRoot,
            config: args.config,
            invocationId,
            sessionType: "modeler",
            status: "failed",
            sessionId,
            error: failureSummary,
          });
          await appendProjectionEventsAndRebuild({
            workspaceRoot: args.workspaceRoot,
            config: args.config,
            configPath: args.state.configPath,
            events: [{
              eventId: newId("evt"),
              ts: nowIso(),
              kind: "projection.slot_updated",
              workspaceRoot: args.workspaceRoot,
              sessionType: "modeler",
              sessionId,
              invocationId,
              summary: `active modeler invocation ${invocationId} cleared`,
              payload: { active: { sessionId, invocationId, status: "idle", updatedAt: nowIso() } },
            }],
          });
          return;
        }
        continueTurns += 1;
        continue;
      }
      boxLabelValidationError = null;
      boxLabelValidationFailures = 0;
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "modeler.progress_advanced",
        workspaceRoot: args.workspaceRoot,
        sessionType: "modeler",
        sessionId,
        summary: `validated feature box labels for level ${featureLabelLevel}`,
        payload: {
          level: featureLabelLevel,
          phase: "feature_boxes",
        },
      }]);
      continueTurns = 0;
      continueAcceptanceMessage = null;
      continueFailingReport = null;
      continue;
    }
    const parsedModelOutput = parseJsonObjectFromAssistantText(turn.assistantText || "");
    const modelOutput = parsedModelOutput ?? fallbackModelOutput(promptPayload, turn.assistantText, turn.interrupted);
    if (args.config.problem.syncModelWorkspace) {
      await runFluxProblemCommand(args.config.problem.syncModelWorkspace, {
        workspaceRoot: args.workspaceRoot,
        queueItem: args.queueItem,
        reason: "post_modeler_turn",
        evidenceBundleId: typeof promptPayload.evidenceBundleId === "string" ? promptPayload.evidenceBundleId : undefined,
        evidenceBundlePath: typeof promptPayload.evidenceBundlePath === "string" ? promptPayload.evidenceBundlePath : undefined,
        targetWorkspaceDir: modelDraftWorkspaceDir,
      });
    }
    const acceptance = await runModelAcceptance({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      modelOutput,
      evidenceBundleId: typeof promptPayload.evidenceBundleId === "string" ? promptPayload.evidenceBundleId : null,
      evidenceBundlePath: typeof promptPayload.evidenceBundlePath === "string" ? promptPayload.evidenceBundlePath : null,
      targetWorkspaceDir: modelDraftWorkspaceDir,
      acceptanceTarget: continueAcceptanceTarget ?? (
        invocationAcceptanceMaxLevel
          ? { maxLevel: invocationAcceptanceMaxLevel, level: invocationAcceptanceMaxLevel }
          : null
      ),
    });
    const comparePayload = acceptance.payload.compare_payload && typeof acceptance.payload.compare_payload === "object" && !Array.isArray(acceptance.payload.compare_payload)
      ? acceptance.payload.compare_payload as Record<string, unknown>
      : {};
    const inferredInfrastructureFailure = await inferAcceptanceInfrastructureFailure({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      acceptanceMessage: acceptance.message,
      comparePayload,
      existing: acceptance.infrastructureFailure,
      targetWorkspaceDir: modelDraftWorkspaceDir,
    });
    const currentProgress = computeModelProgress(comparePayload);
    if (!acceptance.accepted) {
      await publishProgressAdvance({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        currentProgress,
        previousProgress,
        comparePayload,
        modelOutput,
        promptPayload,
        sessionId,
        sourceWorkspaceDir: modelDraftWorkspaceDir,
      });
      const blocked = isBlockedModelOutput(modelOutput);
      const infrastructureFailure = inferredInfrastructureFailure;
      const modelSummary = String(modelOutput.summary ?? "").trim();
      const acceptanceMessage = String(acceptance.message ?? "").trim();
      const failureSummary = blocked
        ? (acceptanceMessage || modelSummary || "model acceptance blocked")
        : (acceptanceMessage ? `model update rejected: ${acceptanceMessage}` : "model update rejected by acceptance compare");
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "modeler.acceptance_failed",
        workspaceRoot: args.workspaceRoot,
        invocationId,
        sessionType: "modeler",
        sessionId,
        summary: failureSummary,
        payload: {
          blocked,
          infrastructureFailure,
          acceptanceMessage,
          modelSummary,
        },
      }]);
      const blockedWithoutConcreteRetry = blocked && !hasConcreteAcceptanceMismatch(comparePayload);
      if (blockedWithoutConcreteRetry || infrastructureFailure) {
        session.status = "idle";
        session.stopReason = undefined;
        session.updatedAt = nowIso();
        await saveFluxSession(args.workspaceRoot, args.config, session);
        await saveFluxInvocationResult(args.workspaceRoot, args.config, {
          invocationId,
          invocationType: "modeler_invocation",
          sessionType: "modeler",
          status: "failed",
          recordedAt: nowIso(),
          summary: failureSummary,
          payload: { sessionId, accepted: false, comparePayload, modelOutput },
        });
        await markFluxInvocationStatus({
          workspaceRoot: args.workspaceRoot,
          config: args.config,
          invocationId,
          sessionType: "modeler",
          status: "failed",
          sessionId,
          error: failureSummary,
        });
        await appendProjectionEventsAndRebuild({
          workspaceRoot: args.workspaceRoot,
          config: args.config,
          configPath: args.state.configPath,
          events: [{
            eventId: newId("evt"),
            ts: nowIso(),
            kind: "projection.slot_updated",
            workspaceRoot: args.workspaceRoot,
            sessionType: "modeler",
            sessionId,
            invocationId,
            summary: `active modeler invocation ${invocationId} cleared`,
            payload: { active: { sessionId, invocationId, status: "idle", updatedAt: nowIso() } },
          }],
        });
        return;
      }
      continueTurns += 1;
      const supersedingPayload = await consumeSupersedingModelerInput({
        workspaceRoot: args.workspaceRoot,
        config: args.config,
        activeInvocationId: invocationId,
        sessionId,
      });
      if (supersedingPayload) {
        promptPayload = supersedingPayload;
      }
      continueAcceptanceMessage = acceptanceMessage || failureSummary;
      continueFailingReport = firstFailingReport(comparePayload);
      continueAcceptanceTarget = deriveContinuationAcceptanceTarget({
        invocationAcceptanceMaxLevel,
        currentProgress,
        priorTarget: continueAcceptanceTarget,
      });
      continue;
    }

    const currentCoverageSummary = await loadCurrentModelCoverageSummary(args.workspaceRoot, args.config);
    const acceptedLevel = Number(comparePayload.level ?? 0) || 0;
    const requiresFreshTheory = acceptedLevel > Math.max(0, Number(currentCoverageSummary?.level ?? 0) || 0);
    const hasTheoryMarkdown = acceptedLevel > 0
      ? await hasModelerTheoryMarkdown({ workspaceDir: modelDraftWorkspaceDir, level: acceptedLevel })
      : true;
    if (acceptedLevel > 0 && (requiresFreshTheory || !hasTheoryMarkdown) && !hasTheoryMarkdown) {
      continueTurns += 1;
      continueAcceptanceMessage = [
        `Level ${acceptedLevel} compare now passes, but the required modeler handoff file is missing.`,
        `Write ${modelerTheoryMarkdownRelativePath(acceptedLevel)} with the refined mechanics for level ${acceptedLevel}.`,
        "Carry forward trusted rules, note remaining uncertainty explicitly, and then rerun acceptance without changing the accepted mechanics unless needed.",
      ].join(" ");
      continueFailingReport = null;
      continueAcceptanceTarget = {
        maxLevel: invocationAcceptanceMaxLevel,
        level: acceptedLevel,
      };
      await appendFluxEvents(args.workspaceRoot, args.config, [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "modeler.handoff_missing",
        workspaceRoot: args.workspaceRoot,
        invocationId,
        sessionType: "modeler",
        sessionId,
        summary: `missing ${modelerTheoryMarkdownRelativePath(acceptedLevel)} before accepted handoff`,
        payload: {
          level: acceptedLevel,
          relativePath: modelerTheoryMarkdownRelativePath(acceptedLevel),
        },
      }]);
      continue;
    }
    const revisionId = await persistAcceptedModel(args.workspaceRoot, args.config, modelOutput, comparePayload, modelDraftWorkspaceDir);
    await publishBootstrapSignals({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      comparePayload,
      currentProgress,
      previousProgress,
      modelOutput,
      modelRevisionId: revisionId,
      promptPayload,
      sessionId,
    });
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.acceptance_passed",
      workspaceRoot: args.workspaceRoot,
      invocationId,
      sessionType: "modeler",
      sessionId,
      summary: `accepted model revision ${revisionId}`,
      payload: { revisionId },
    }]);
    session.status = "idle";
    session.stopReason = undefined;
    session.updatedAt = nowIso();
    await saveFluxSession(args.workspaceRoot, args.config, session);
    await saveFluxInvocationResult(args.workspaceRoot, args.config, {
      invocationId,
      invocationType: "modeler_invocation",
      sessionType: "modeler",
      status: "completed",
      recordedAt: nowIso(),
      summary: "modeler acceptance passed",
      payload: {
        sessionId,
        accepted: true,
        comparePayload,
        modelOutput,
        revisionId,
      },
    });
    await markFluxInvocationStatus({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      invocationId,
      sessionType: "modeler",
      status: "completed",
      sessionId,
    });
    await appendProjectionEventsAndRebuild({
      workspaceRoot: args.workspaceRoot,
      config: args.config,
      configPath: args.state.configPath,
      events: [{
        eventId: newId("evt"),
        ts: nowIso(),
        kind: "projection.slot_updated",
        workspaceRoot: args.workspaceRoot,
        sessionType: "modeler",
        sessionId,
        invocationId,
        summary: `active modeler invocation ${invocationId} cleared`,
        payload: { active: { sessionId, invocationId, status: "idle", updatedAt: nowIso() } },
      }],
    });
    return;
  }
}
