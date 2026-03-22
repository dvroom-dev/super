import { renderChat } from "../../../markdown/render.js";
import type { ProviderPermissionProfile } from "../../../providers/types.js";
import type { SupervisorReviewResult } from "../../../supervisor/review_schema.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import { combineTranscript } from "../helpers.js";
import { fallbackReview, normalizeReview, validateReviewSemantic } from "../supervisor/review_utils.js";
import {
  buildSupervisorInjectedMessage,
  messageTemplateSpecsForReview,
} from "../supervisor/supervisor_interjections.js";
import {
  runSuperviseReviewStep,
  type SuperviseReviewStepResult,
} from "../supervisor/supervise_review.js";
import type { SupervisorConfig } from "../types.js";
import type { RuntimeContext } from "./context.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;
type CadenceReason = "cadence_time" | "cadence_tokens";
type ProviderName = "mock" | "codex" | "claude";

type CreateCadenceParallelControllerArgs = {
  ctx: RuntimeContext;
  disableSupervision: boolean;
  effectiveSupervisor: SupervisorConfig;
  renderedRunConfig: RenderedRunConfig;
  workspaceRoot: string;
  conversationId: string;
  documentText: string;
  currentDocText: string;
  currentSupervisorThreadId?: string;
  effectiveAgentRequirements: string[];
  effectiveAgentViolations: string[];
  effectiveSupervisorInstructions: string[];
  supervisorProviderName: ProviderName;
  effectiveSupervisorProviderOptions?: Record<string, unknown>;
  permissionProfile: ProviderPermissionProfile;
  supervisorModel: string;
  currentModel: string;
  supervisorModelReasoningEffort?: string;
  agentsText?: string;
  workspaceListingText: string;
  taggedFiles: any[];
  openFiles: any[];
  utilities: any[];
  skills: any[];
  skillsToInvoke: any[];
  skillInstructions: any[];
  effectiveSupervisorConfiguredSystemMessage?: any;
  effectiveStopCondition: string;
  activeMode: string;
  allowedNextModes: string[];
  modePayloadFields: Record<string, string[]>;
  modeGuidance: Record<string, { description?: string; startWhen?: string[]; stopWhen?: string[] }>;
  supervisorWorkspaceRoot: string;
};

export type CadenceParallelController = {
  onCadenceHit: (event: {
    reason: CadenceReason;
    requestInterrupt: (reason: string) => void;
    requestSteer: (
      message: string,
      options?: { expectedTurnId?: string },
    ) => Promise<{
      applied: boolean;
      deferred: boolean;
      reason?: string;
      threadId?: string;
      turnId?: string;
    }>;
  }) => void;
  onToolBoundary: () => Promise<void>;
  onAppendMarkdown: (markdown: string) => void;
  onAssistantText: (text: string) => void;
  finalize: () => Promise<{
    supervisorThreadId?: string;
    reviewStep?: SuperviseReviewStepResult;
    appendedMarkdowns: string[];
    inlineReviewApplied: boolean;
  }>;
};

type PendingBoundaryAction =
  | {
      kind: "interrupt";
    }
  | {
      kind: "steer";
      messageText: string;
      markdown: string;
      expectedTurnId?: string;
    };

function shouldInterruptForCadenceReview(
  review: SupervisorReviewResult,
  cadenceInterruptPolicy?: "boundary" | "interrupt",
): boolean {
  if (cadenceInterruptPolicy === "boundary") return false;
  if (review.decision === "stop_and_return") {
    return review.payload.wait_for_boundary !== true;
  }
  if (review.decision === "fork_new_conversation") {
    return review.payload.wait_for_boundary !== true;
  }
  if (review.decision === "resume_mode_head") {
    return review.payload.wait_for_boundary !== true;
  }
  return false;
}

function shouldPersistCadenceReview(reviewStep: SuperviseReviewStepResult): boolean {
  return reviewStep.review.decision !== "continue" && reviewStep.review.decision !== "retry";
}

function parseOverrideCadenceReview(args: CreateCadenceParallelControllerArgs): SupervisorReviewResult {
  const appendMessageTemplates = messageTemplateSpecsForReview({
    supervisorMode: "soft",
    reviewTrigger: "agent_yield",
    supervisorTriggers: args.renderedRunConfig?.supervisorTriggers,
  });
  let review = fallbackReview({
    trigger: "agent_yield",
    mode: "soft",
    agentRules: args.effectiveAgentRequirements,
    agentRuleViolations: args.effectiveAgentViolations,
    reason: "Invalid supervisor override JSON.",
  });
  try {
    const parsed = JSON.parse(String(args.effectiveSupervisor.reviewOverrideJson));
    const normalized = normalizeReview({
      raw: parsed,
      trigger: "agent_yield",
      mode: "soft",
      agentRules: args.effectiveAgentRequirements,
      agentRuleViolations: args.effectiveAgentViolations,
    });
    const semanticError = validateReviewSemantic({
      review: normalized,
      trigger: "agent_yield",
      mode: "soft",
      agentRules: args.effectiveAgentRequirements,
      agentRuleViolations: args.effectiveAgentViolations,
      allowedNextModes: args.allowedNextModes,
      modePayloadFieldsByMode: args.modePayloadFields,
      appendMessageTemplates,
    });
    review = semanticError
      ? fallbackReview({
        trigger: "agent_yield",
        mode: "soft",
        agentRules: args.effectiveAgentRequirements,
        agentRuleViolations: args.effectiveAgentViolations,
        reason: `Supervisor override failed semantic validation: ${semanticError}`,
      })
      : normalized;
  } catch {
    // fallback already assigned
  }
  return review;
}

export function createCadenceParallelController(args: CreateCadenceParallelControllerArgs): CadenceParallelController {
  let turnSnapshotDocText = args.currentDocText;
  let turnSnapshotAssistantText = "";
  let cadenceReviewPromise: Promise<void> | null = null;
  let cadenceReviewThreadId = args.currentSupervisorThreadId;
  let cadenceReviewStep: SuperviseReviewStepResult | undefined;
  let boundaryCount = 0;
  let cadenceBoundaryAnchor = 0;
  let pendingBoundaryAction: PendingBoundaryAction | undefined;
  let cadenceInterruptRequested = false;
  let cadenceRequestInterrupt: ((reason: string) => void) | undefined;
  let cadenceRequestSteer:
    | ((
      message: string,
      options?: { expectedTurnId?: string },
    ) => Promise<{
      applied: boolean;
      deferred: boolean;
      reason?: string;
      threadId?: string;
      turnId?: string;
    }>)
    | undefined;
  let inlineCadenceReviewApplied = false;
  const appendedMarkdowns: string[] = [];

  const maybeRequestBoundaryAction = async () => {
    if (!pendingBoundaryAction || cadenceInterruptRequested || !cadenceRequestInterrupt) return;
    if (boundaryCount <= cadenceBoundaryAnchor) return;
    const action = pendingBoundaryAction;
    pendingBoundaryAction = undefined;
    if (action.kind === "steer" && cadenceRequestSteer) {
      const steer = await cadenceRequestSteer(action.messageText, {
        expectedTurnId: action.expectedTurnId,
      });
      if (steer.applied) {
        inlineCadenceReviewApplied = true;
        appendedMarkdowns.push(action.markdown);
        turnSnapshotDocText = combineTranscript(turnSnapshotDocText, [action.markdown]);
        return;
      }
      pendingBoundaryAction = { kind: "interrupt" };
    }
    cadenceInterruptRequested = true;
    args.ctx.sendNotification({
      method: "conversation.status",
      params: { message: "cadence supervisor interrupt: boundary" },
    });
    cadenceRequestInterrupt("cadence_supervisor");
  };

  const maybeInterruptForReview = (review: SupervisorReviewResult, requestInterrupt: (reason: string) => void) => {
    if (!shouldInterruptForCadenceReview(review, args.effectiveSupervisor.cadenceInterruptPolicy)) return;
    cadenceInterruptRequested = true;
    args.ctx.sendNotification({
      method: "conversation.status",
      params: { message: `cadence supervisor interrupt: ${review.decision}` },
    });
    requestInterrupt("cadence_supervisor");
  };

  const onCadenceHit = (event: {
    reason: CadenceReason;
    requestInterrupt: (reason: string) => void;
    requestSteer: (
      message: string,
      options?: { expectedTurnId?: string },
    ) => Promise<{
      applied: boolean;
      deferred: boolean;
      reason?: string;
      threadId?: string;
      turnId?: string;
    }>;
  }) => {
    if (cadenceReviewPromise) return;
    if (args.disableSupervision || args.effectiveSupervisor.enabled === false) return;
    cadenceRequestInterrupt = event.requestInterrupt;
    cadenceRequestSteer = event.requestSteer;
    cadenceBoundaryAnchor = boundaryCount;
    if (args.effectiveSupervisor.reviewOverrideJson) {
      maybeInterruptForReview(parseOverrideCadenceReview(args), event.requestInterrupt);
    }
    cadenceReviewPromise = (async () => {
      const reviewStep = await runSuperviseReviewStep({
        ctx: args.ctx,
        workspaceRoot: args.workspaceRoot,
        conversationId: args.conversationId,
        documentText: args.documentText,
        currentDocText: turnSnapshotDocText,
        agentRules: args.effectiveAgentRequirements,
        agentRuleViolations: args.effectiveAgentViolations,
        supervisorInstructions: args.effectiveSupervisorInstructions,
        result: {
          appended: [],
          assistantText: turnSnapshotAssistantText,
          errorMessage: null,
          assistantFinal: false,
          toolCalls: undefined,
          hadError: false,
          interrupted: false,
          interruptionReason: null,
          abortedBySupervisor: false,
          abortError: false,
          streamEnded: false,
          usage: undefined,
          cadenceHit: true,
          cadenceReason: event.reason,
          compactionDetected: false,
          compactionDetails: null,
        },
        reasons: [event.reason],
        supervisorMode: "soft",
        providerName: args.supervisorProviderName,
        supervisorProviderOptions: args.effectiveSupervisorProviderOptions,
        permissionProfile: args.permissionProfile,
        supervisor: args.effectiveSupervisor,
        supervisorModel: args.supervisorModel,
        currentModel: args.currentModel,
        supervisorModelReasoningEffort: args.supervisorModelReasoningEffort,
        agentsText: args.agentsText,
        workspaceListingText: args.workspaceListingText,
        taggedFiles: args.taggedFiles,
        openFiles: args.openFiles,
        utilities: args.utilities,
        skills: args.skills,
        skillsToInvoke: args.skillsToInvoke,
        skillInstructions: args.skillInstructions,
        configuredSystemMessage: args.effectiveSupervisorConfiguredSystemMessage,
        supervisorTriggers: args.renderedRunConfig?.supervisorTriggers,
        stopCondition: args.effectiveStopCondition,
        currentMode: args.activeMode,
        allowedNextModes: args.allowedNextModes,
        modePayloadFieldsByMode: args.modePayloadFields,
        modeGuidanceByMode: args.modeGuidance,
        supervisorWorkspaceRoot: args.supervisorWorkspaceRoot,
        currentSupervisorThreadId: cadenceReviewThreadId,
      });
      cadenceReviewStep = reviewStep;
      cadenceReviewThreadId = reviewStep.nextSupervisorThreadId ?? cadenceReviewThreadId;
      if (reviewStep.reviewReasons.includes("supervisor_error")) return;
      if (shouldInterruptForCadenceReview(reviewStep.review, args.effectiveSupervisor.cadenceInterruptPolicy)) {
        maybeInterruptForReview(reviewStep.review, event.requestInterrupt);
        return;
      }
      if (reviewStep.review.decision === "append_message_and_continue") {
        const injected = buildSupervisorInjectedMessage({
          supervisorMode: "soft",
          reviewTrigger: "agent_yield",
          review: reviewStep.review,
          guidanceText: reviewStep.nextUserMessage ?? "",
          messageTemplateName: reviewStep.nextMessageTemplateName,
          reasons: reviewStep.reviewReasons,
          stopDetails: [],
          supervisorTriggers: args.renderedRunConfig?.supervisorTriggers,
        });
        if (injected?.messageType === "user" && injected.text.trim()) {
          pendingBoundaryAction = {
            kind: "steer",
            messageText: injected.text,
            markdown: renderChat(injected.messageType, injected.text),
          };
          await maybeRequestBoundaryAction();
          return;
        }
      }
      if (shouldPersistCadenceReview(reviewStep)) {
        pendingBoundaryAction = { kind: "interrupt" };
        await maybeRequestBoundaryAction();
      }
    })().catch((err: any) => {
      const message = err?.message ?? String(err);
      args.ctx.sendNotification({
        method: "log",
        params: { level: "warn", message: `cadence supervisor review failed: ${message}` },
      });
    });
  };

  return {
    onCadenceHit,
    async onToolBoundary() {
      boundaryCount += 1;
      await maybeRequestBoundaryAction();
    },
    onAppendMarkdown(markdown: string) {
      turnSnapshotDocText = combineTranscript(turnSnapshotDocText, [markdown]);
    },
    onAssistantText(text: string) {
      turnSnapshotAssistantText = text;
    },
    async finalize() {
      if (cadenceReviewPromise) {
        await cadenceReviewPromise;
      }
      return {
        supervisorThreadId: cadenceReviewThreadId,
        reviewStep:
          !inlineCadenceReviewApplied
          && cadenceReviewStep
          && shouldPersistCadenceReview(cadenceReviewStep)
          ? cadenceReviewStep
          : undefined,
        appendedMarkdowns,
        inlineReviewApplied: inlineCadenceReviewApplied,
      };
    },
  };
}
