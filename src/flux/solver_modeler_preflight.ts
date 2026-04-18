import { appendFluxEvents } from "./events.js";
import { runModelAcceptance } from "./model_acceptance.js";
import { computeModelProgress } from "./model_coverage.js";
import {
  loadBestProgress,
  loadCurrentModelRevisionId,
  publishBootstrapSignals,
} from "./modeler_runtime_helpers.js";
import type { FluxConfig } from "./types.js";
import { newId } from "../utils/ids.js";

function nowIso(): string {
  return new Date().toISOString();
}

export async function preflightCurrentModelMatchesEvidence(args: {
  workspaceRoot: string;
  config: FluxConfig;
  sessionId: string;
  attemptId: string;
  instanceId: string;
  watermark: string;
  evidenceCount: number;
  latestEvidence: Record<string, unknown> | null;
  evidenceBundleId: string;
  evidenceBundlePath: string;
}): Promise<boolean> {
  if (!args.evidenceBundlePath) return false;
  const modelRevisionId = await loadCurrentModelRevisionId(args.workspaceRoot, args.config);
  if (!modelRevisionId) return false;
  const modelOutput = {
    decision: "checked_current_model",
    summary: "preflight compare of current model against latest solver evidence",
    message_for_bootstrapper: "",
    artifacts_updated: [],
    evidence_watermark: args.watermark,
  };
  const acceptance = await runModelAcceptance({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    modelOutput,
    modelRevisionId,
    evidenceBundleId: args.evidenceBundleId || null,
    evidenceBundlePath: args.evidenceBundlePath,
  });
  const comparePayload = acceptance.payload.compare_payload
    && typeof acceptance.payload.compare_payload === "object"
    && !Array.isArray(acceptance.payload.compare_payload)
    ? acceptance.payload.compare_payload as Record<string, unknown>
    : {};
  if (!acceptance.accepted) return false;
  await publishBootstrapSignals({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    comparePayload,
    currentProgress: computeModelProgress(comparePayload),
    previousProgress: await loadBestProgress(args.workspaceRoot, args.config),
    modelOutput,
    modelRevisionId,
    promptPayload: {
      attemptId: args.attemptId,
      instanceId: args.instanceId,
      evidenceWatermark: args.watermark,
      evidenceCount: args.evidenceCount,
      latestEvidence: args.latestEvidence,
      evidenceBundleId: args.evidenceBundleId || undefined,
      evidenceBundlePath: args.evidenceBundlePath || undefined,
    },
    sessionId: args.sessionId,
    requeueModelerBeforeLevel1: false,
  });
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "solver.modeler_enqueue_skipped",
    workspaceRoot: args.workspaceRoot,
    sessionType: "solver",
    sessionId: args.sessionId,
    summary: "current accepted model already matches latest solver evidence",
    payload: {
      attemptId: args.attemptId,
      instanceId: args.instanceId,
      watermark: args.watermark,
      evidenceBundleId: args.evidenceBundleId || null,
      modelRevisionId,
      comparePayload,
    },
  }]);
  return true;
}
