import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../lib/fs.js";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { markFluxInvocationStatus, saveFluxInvocationResult } from "./invocations.js";
import { buildCoverageSummary, classifyModelImprovement, type ModelProgress } from "./model_coverage.js";
import { loadModelCoverageSummary, modelRevisionWorkspaceSource, saveModelCoverageSummary } from "./model_revision_store.js";
import { loadFluxQueue, saveFluxQueue, enqueueFluxQueueItem } from "./queue.js";
import { renderTemplate } from "./prompt_templates.js";
import { loadSeedMeta, saveSeedMeta } from "./seed_meta.js";
import { saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxSessionRecord } from "./types.js";
import { fluxModelDraftDir, fluxModelLabelsRoot, fluxModelRoot } from "./paths.js";

const SOLVER_THEORY_JSON_PREFIX = "untrusted_theories_level_";
const SOLVER_THEORY_JSON_SUFFIX = ".json";
const MODELER_HANDOFF_DIR = "modeler_handoff";
const FEATURE_LABELS_PREFIX = "feature_labels_level_";
const FEATURE_BOXES_PREFIX = "feature_boxes_level_";

function nowIso(): string {
  return new Date().toISOString();
}

export function modelSessionId(): string {
  return "modeler_run";
}

function solverTheoryJsonPath(workspaceDir: string, level: number): string {
  return path.join(workspaceDir, `${SOLVER_THEORY_JSON_PREFIX}${level}${SOLVER_THEORY_JSON_SUFFIX}`);
}

function solverTheoryMarkdownPath(workspaceDir: string): string {
  return path.join(workspaceDir, "solver_handoff", "untrusted_theories.md");
}

export function modelerTheoryMarkdownRelativePath(level: number): string {
  return path.join(MODELER_HANDOFF_DIR, `untrusted_theories_level_${level}.md`);
}

function modelerTheoryMarkdownPath(workspaceDir: string, level: number): string {
  return path.join(workspaceDir, modelerTheoryMarkdownRelativePath(level));
}

function featureBoxesPath(workspaceDir: string, level: number): string {
  return path.join(workspaceDir, `${FEATURE_BOXES_PREFIX}${level}.json`);
}

function featureLabelsPath(workspaceDir: string, level: number): string {
  return path.join(workspaceDir, `${FEATURE_LABELS_PREFIX}${level}.json`);
}

async function latestSolverTheoryLevel(workspaceDir: string): Promise<number | null> {
  try {
    const entries = await fs.readdir(workspaceDir);
    let maxLevel = 0;
    for (const entry of entries) {
      const match = entry.match(/^untrusted_theories_level_(\d+)\.json$/);
      if (!match) continue;
      const level = Number(match[1] ?? 0) || 0;
      if (level > maxLevel) maxLevel = level;
    }
    return maxLevel > 0 ? maxLevel : null;
  } catch {
    return null;
  }
}

export async function buildSolverTheoryInterjection(args: {
  workspaceDir: string;
  lastInjectedLevel?: number;
}): Promise<{ level: number; text: string } | null> {
  const level = await latestSolverTheoryLevel(args.workspaceDir);
  if (!level || level <= (args.lastInjectedLevel ?? 0)) return null;
  const jsonPath = solverTheoryJsonPath(args.workspaceDir, level);
  const markdownPath = solverTheoryMarkdownPath(args.workspaceDir);
  try {
    await fs.access(jsonPath);
  } catch {
    return null;
  }
  const lines = [
    "New solver handoff theory is available.",
    `- Read ${path.relative(args.workspaceDir, jsonPath) || path.basename(jsonPath)}.`,
  ];
  try {
    await fs.access(markdownPath);
    lines.push(`- Also read ${path.relative(args.workspaceDir, markdownPath) || path.basename(markdownPath)}.`);
  } catch {}
  lines.push("- It came from the solver after reaching a new frontier level.");
  lines.push("- Treat it as untrusted context only, refine or invalidate it against compare evidence, and keep going.");
  return { level, text: lines.join("\n") };
}

export async function hasModelerTheoryMarkdown(args: {
  workspaceDir: string;
  level: number;
}): Promise<boolean> {
  try {
    const stat = await fs.stat(modelerTheoryMarkdownPath(args.workspaceDir, args.level));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function loadFeatureBoxes(args: {
  workspaceDir: string;
  level: number;
}): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(featureBoxesPath(args.workspaceDir, args.level), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

type FeatureLabelsValidation =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

export async function validateFeatureLabels(args: {
  workspaceDir: string;
  level: number;
}): Promise<FeatureLabelsValidation> {
  const boxesPayload = await loadFeatureBoxes({ workspaceDir: args.workspaceDir, level: args.level });
  if (!boxesPayload) {
    return { ok: false, reason: `missing feature boxes for level ${args.level}` };
  }
  const expectedHash = String(boxesPayload.box_spec_hash ?? "").trim();
  const expectedBoxes = Array.isArray(boxesPayload.boxes) ? boxesPayload.boxes : [];
  const expectedIds = expectedBoxes
    .filter((box): box is Record<string, unknown> => Boolean(box) && typeof box === "object" && !Array.isArray(box))
    .map((box) => String(box.box_id ?? "").trim())
    .filter(Boolean)
    .sort();
  try {
    const raw = await fs.readFile(featureLabelsPath(args.workspaceDir, args.level), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "feature labels file is not a JSON object" };
    }
    const payload = parsed as Record<string, unknown>;
    if ((Number(payload.level ?? 0) || 0) !== args.level) {
      return { ok: false, reason: `feature labels level mismatch for level ${args.level}` };
    }
    if (expectedHash && String(payload.feature_boxes_hash ?? "").trim() !== expectedHash) {
      return { ok: false, reason: `feature labels hash mismatch for level ${args.level}` };
    }
    const boxes = Array.isArray(payload.boxes) ? payload.boxes : [];
    const actualIds = boxes
      .filter((box): box is Record<string, unknown> => Boolean(box) && typeof box === "object" && !Array.isArray(box))
      .map((box) => String(box.box_id ?? "").trim())
      .filter(Boolean)
      .sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      return { ok: false, reason: `feature labels coverage mismatch for level ${args.level}` };
    }
    for (const box of boxes) {
      if (!box || typeof box !== "object" || Array.isArray(box)) {
        return { ok: false, reason: `feature labels contain an invalid box entry for level ${args.level}` };
      }
      const record = box as Record<string, unknown>;
      const featuresSource = Array.isArray(record.features)
        ? record.features
        : (Array.isArray(record.feature_names) ? record.feature_names : []);
      const features = featuresSource.filter((value) => typeof value === "string" && value.trim());
      const tags = Array.isArray(record.tags) ? record.tags.filter((value) => typeof value === "string" && value.trim()) : [];
      if (features.length === 0 || tags.length === 0) {
        return { ok: false, reason: `feature labels contain an empty features/tags entry for level ${args.level}` };
      }
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: `missing feature labels for level ${args.level}` };
  }
}

export async function persistFeatureLabels(args: {
  workspaceRoot: string;
  config: FluxConfig;
  workspaceDir: string;
  level: number;
  labels: Record<string, unknown>;
}): Promise<void> {
  const boxesPayload = await loadFeatureBoxes({ workspaceDir: args.workspaceDir, level: args.level });
  if (!boxesPayload) {
    throw new Error(`missing feature boxes for level ${args.level}`);
  }
  const payload = {
    schema_version: "flux.modeler_feature_labels.v1",
    level: args.level,
    feature_boxes_hash: String(boxesPayload.box_spec_hash ?? ""),
    summary: String(args.labels.summary ?? ""),
    boxes: (
      Array.isArray(args.labels.boxes)
        ? args.labels.boxes.map((box) => {
            if (!box || typeof box !== "object" || Array.isArray(box)) return box;
            const record = box as Record<string, unknown>;
            const features = Array.isArray(record.features)
              ? record.features
              : (Array.isArray(record.feature_names) ? record.feature_names : []);
            return {
              ...record,
              features,
            };
          })
        : []
    ),
  };
  await writeJsonAtomic(featureLabelsPath(args.workspaceDir, args.level), payload);
  const labelsRoot = fluxModelLabelsRoot(args.workspaceRoot, args.config);
  await fs.mkdir(labelsRoot, { recursive: true });
  await writeJsonAtomic(path.join(labelsRoot, `${FEATURE_LABELS_PREFIX}${args.level}.json`), payload);
}

export function deriveFeatureLabelTargetLevel(args: {
  acceptanceTarget: { maxLevel?: number | null; level?: number | null; sequenceId?: string | null } | null;
  invocationAcceptanceMaxLevel: number | null;
  comparePayload: Record<string, unknown>;
}): number | null {
  const firstReport = firstFailingReport(args.comparePayload);
  const reportLevel = Number(firstReport?.level ?? 0) || 0;
  if (reportLevel > 0) return reportLevel;
  const compareLevel = Number(args.comparePayload.level ?? 0) || 0;
  if (compareLevel > 0) return compareLevel;
  const targetLevel = Number(args.acceptanceTarget?.level ?? 0) || 0;
  if (targetLevel > 0) return targetLevel;
  const maxLevel = Number(args.invocationAcceptanceMaxLevel ?? 0) || 0;
  return maxLevel > 0 ? maxLevel : null;
}

export function buildFeatureLabelPrompt(args: {
  template: string;
  level: number;
  featureBoxes: Record<string, unknown>;
  validationError?: string | null;
}): string {
  const lines = [
    args.template.trim(),
    "",
    `Current box-label phase target: level ${args.level}.`,
    "Read feature_boxes_level_<n>.json and use inspect_box_sequence.py to inspect any box through time before naming it.",
    "Name visual features, not hidden mechanics. Good names are descriptive and local.",
    "Required tags per box: stable, movable, transient, ui_like, or unknown.",
    "Cover every box exactly once in your JSON response.",
  ];
  if (args.validationError) {
    lines.push("", `Previous label set was invalid: ${args.validationError}`);
    lines.push("Return a corrected full box coverage response.");
  }
  lines.push("", JSON.stringify(args.featureBoxes, null, 2));
  return lines.join("\n");
}

export function fallbackModelOutput(queuePayload: Record<string, unknown>, assistantText: string, interrupted: boolean): Record<string, unknown> {
  return {
    decision: "updated_model",
    summary: interrupted ? "interrupted modeler turn; evaluate current workspace state" : "modeler output was not valid JSON; evaluate current workspace state",
    message_for_bootstrapper: "",
    artifacts_updated: [],
    evidence_watermark: String(queuePayload.evidenceWatermark ?? ""),
    raw_assistant_text: assistantText,
  };
}

export function isBlockedModelOutput(modelOutput: Record<string, unknown>): boolean {
  return String(modelOutput.decision ?? "").trim().toLowerCase() === "blocked";
}

export function firstFailingReport(comparePayload: Record<string, unknown>): Record<string, unknown> | null {
  const reports = Array.isArray(comparePayload.reports) ? comparePayload.reports : [];
  for (const report of reports) {
    if (!report || typeof report !== "object" || Array.isArray(report)) continue;
    const record = report as Record<string, unknown>;
    if (!Boolean(record.matched)) return record;
  }
  return null;
}

export function hasConcreteAcceptanceMismatch(comparePayload: Record<string, unknown>): boolean {
  const report = firstFailingReport(comparePayload);
  if (!report) return false;
  const sequenceId = String(report.sequence_id ?? "").trim();
  const divergenceReason = String(report.divergence_reason ?? "").trim();
  const divergenceStep = Number(report.divergence_step ?? 0) || 0;
  return sequenceId.length > 0 && divergenceReason.length > 0 && divergenceStep > 0;
}

export async function loadBestProgress(workspaceRoot: string, config: FluxConfig): Promise<ModelProgress | null> {
  try {
    const raw = await fs.readFile(path.join(fluxModelRoot(workspaceRoot, config), "current", "progress.json"), "utf8");
    return JSON.parse(raw) as ModelProgress;
  } catch {
    return null;
  }
}

export async function saveBestProgress(workspaceRoot: string, config: FluxConfig, progress: ModelProgress): Promise<void> {
  await writeJsonAtomic(path.join(fluxModelRoot(workspaceRoot, config), "current", "progress.json"), {
    ...progress,
    updatedAt: nowIso(),
  });
}

export async function loadCurrentModelRevisionId(workspaceRoot: string, config: FluxConfig): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(fluxModelRoot(workspaceRoot, config), "current", "meta.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const revisionId = parsed.revisionId;
    return typeof revisionId === "string" && revisionId.trim().length > 0 ? revisionId : null;
  } catch {
    return null;
  }
}

export async function loadCurrentModelCoverageSummary(
  workspaceRoot: string,
  config: FluxConfig,
): Promise<ReturnType<typeof buildCoverageSummary> | null> {
  try {
    const raw = await fs.readFile(path.join(fluxModelRoot(workspaceRoot, config), "current", "meta.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summary = parsed.summary;
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
      return null;
    }
    const record = summary as Record<string, unknown>;
    return Array.isArray(record.coveredSequenceIds) ? record as ReturnType<typeof buildCoverageSummary> : null;
  } catch {
    return null;
  }
}

function comparePayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function inferAcceptanceInfrastructureFailure(args: {
  workspaceRoot: string;
  config: FluxConfig;
  acceptanceMessage: string;
  comparePayload: Record<string, unknown>;
  existing: Record<string, unknown> | null;
  targetWorkspaceDir?: string | null;
}): Promise<Record<string, unknown> | null> {
  if (args.existing) return args.existing;
  const errorRecord = comparePayloadRecord(args.comparePayload.error);
  const errorType = String(errorRecord.type ?? "").trim();
  const errorMessage = String(errorRecord.message ?? args.acceptanceMessage ?? "").trim();
  if (["missing_level_dir", "missing_sequences", "missing_sequence_dir"].includes(errorType)) {
    return {
      type: errorType,
      message: errorMessage || "compare surface is missing required level artifacts",
    };
  }
  const reports = Array.isArray(args.comparePayload.reports) ? args.comparePayload.reports : [];
  const workspaceDir = args.targetWorkspaceDir && args.targetWorkspaceDir.trim().length > 0
    ? args.targetWorkspaceDir
    : modelRevisionWorkspaceSource(args.workspaceRoot, args.config);
  for (const report of reports) {
    if (!report || typeof report !== "object" || Array.isArray(report)) continue;
    const record = report as Record<string, unknown>;
    const sequenceId = String(record.sequence_id ?? "").trim();
    const level = Number(record.level ?? args.comparePayload.level ?? 0) || 0;
    if (!sequenceId || level <= 0) continue;
    const sequencePath = path.join(workspaceDir, `level_${level}`, "sequences", `${sequenceId}.json`);
    try {
      await fs.access(sequencePath);
    } catch {
      return {
        type: "missing_sequence_surface",
        message: `compare referenced level_${level}/${sequenceId}, but ${sequencePath} is not present in the synced model workspace`,
        level,
        sequenceId,
      };
    }
  }
  return null;
}

export function isProgressAdvance(previous: ModelProgress | null, next: ModelProgress): boolean {
  const sequenceOrder = (sequenceId: string | null): number => {
    const match = String(sequenceId ?? "").match(/seq_(\d+)/i);
    return match ? Number(match[1]) || 0 : 0;
  };
  const hasOrderedAdvance = (baseline: ModelProgress | null, candidate: ModelProgress): boolean => {
    if (candidate.contiguousMatchedSequences > (baseline?.contiguousMatchedSequences ?? 0)) {
      return true;
    }
    const candidateSequenceOrder = sequenceOrder(candidate.firstFailingSequenceId);
    const baselineSequenceOrder = sequenceOrder(baseline?.firstFailingSequenceId ?? null);
    if (candidateSequenceOrder > Math.max(1, baselineSequenceOrder)) {
      return true;
    }
    if ((candidate.firstFailingStep ?? 0) > 1) {
      return true;
    }
    if (
      baseline?.firstFailingSequenceId
      && candidate.firstFailingSequenceId
      && baseline.firstFailingSequenceId === candidate.firstFailingSequenceId
      && baseline.firstFailingStep != null
      && candidate.firstFailingStep != null
      && candidate.firstFailingStep > baseline.firstFailingStep
    ) {
      return true;
    }
    return false;
  };
  if (!previous) {
    return hasOrderedAdvance(null, next);
  }
  if (next.level !== previous.level) {
    return next.level > previous.level && hasOrderedAdvance(previous, next);
  }
  return hasOrderedAdvance(previous, next);
}

export function coverageSummaryFromSeedMeta(value: unknown): ReturnType<typeof buildCoverageSummary> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.coveredSequenceIds)) {
    return null;
  }
  return record as ReturnType<typeof buildCoverageSummary>;
}

function hasSolvedLevelOne(comparePayload: Record<string, unknown>): boolean {
  const acceptedLevel = Number(comparePayload.level ?? 0) || 0;
  if (acceptedLevel >= 2) return true;
  const reports = Array.isArray(comparePayload.reports) ? comparePayload.reports : [];
  return reports.some((report) => {
    if (!report || typeof report !== "object" || Array.isArray(report)) return false;
    const record = report as Record<string, unknown>;
    const level = Number(record.level ?? 0) || 0;
    if (level !== 1 || !Boolean(record.matched)) return false;
    return Boolean(record.sequence_completed_level) || (Number(record.frontier_level_after_sequence ?? 0) || 0) >= 2;
  });
}

export async function publishBootstrapSignals(args: {
  workspaceRoot: string;
  config: FluxConfig;
  comparePayload: Record<string, unknown>;
  currentProgress: ModelProgress;
  previousProgress: ModelProgress | null;
  modelOutput: Record<string, unknown>;
  modelRevisionId?: string | null;
  promptPayload: Record<string, unknown>;
  sessionId: string;
}): Promise<void> {
  const modelRevisionId = typeof args.modelRevisionId === "string" && args.modelRevisionId ? args.modelRevisionId : null;
  if (!modelRevisionId) return;
  const currentSummary = buildCoverageSummary({ comparePayload: args.comparePayload, accepted: true });
  const persistedSummary = await saveModelCoverageSummary({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    revisionId: modelRevisionId,
    summary: currentSummary,
  });
  const seedMeta = await loadSeedMeta(args.workspaceRoot, args.config);
  const baselineRevisionId = seedMeta.lastQueuedBootstrapModelRevisionId ?? seedMeta.lastBootstrapperModelRevisionId ?? null;
  const baselineSummary =
    coverageSummaryFromSeedMeta(seedMeta.lastQueuedBootstrapCoverageSummary)
    ?? coverageSummaryFromSeedMeta(seedMeta.lastBootstrapperCoverageSummary)
    ?? (baselineRevisionId ? await loadModelCoverageSummary(args.workspaceRoot, args.config, baselineRevisionId) : null);
  const improvementKind = classifyModelImprovement(baselineSummary, persistedSummary);
  if (isProgressAdvance(args.previousProgress, args.currentProgress)) {
    await saveBestProgress(args.workspaceRoot, args.config, args.currentProgress);
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.progress_advanced",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId: args.sessionId,
      summary: `modeled contiguous sequence prefix through ${args.currentProgress.contiguousMatchedSequences}`,
      payload: {
        level: args.currentProgress.level,
        contiguousMatchedSequences: args.currentProgress.contiguousMatchedSequences,
        firstFailingSequenceId: args.currentProgress.firstFailingSequenceId,
        firstFailingStep: args.currentProgress.firstFailingStep,
        firstFailingReason: args.currentProgress.firstFailingReason,
      },
    }]);
  }
  if (improvementKind === "no_improvement") {
    return;
  }
  if (!hasSolvedLevelOne(args.comparePayload)) {
    await appendFluxEvents(args.workspaceRoot, args.config, [{
      eventId: newId("evt"),
      ts: nowIso(),
      kind: "modeler.bootstrap_deferred",
      workspaceRoot: args.workspaceRoot,
      sessionType: "modeler",
      sessionId: args.sessionId,
      summary: "deferred bootstrap until level 1 is solved and accepted",
      payload: {
        level: persistedSummary.level,
        frontierLevel: persistedSummary.frontierLevel,
        coveredSequenceIds: persistedSummary.coveredSequenceIds,
      },
    }]);
    const existingQueue = await loadFluxQueue(args.workspaceRoot, args.config, "modeler");
    if (existingQueue.items.length === 0) {
      await enqueueFluxQueueItem(args.workspaceRoot, args.config, "modeler", {
        id: newId("q"),
        sessionType: "modeler",
        createdAt: nowIso(),
        reason: "modeler_continue_until_level1_solved",
        dedupeKey: `evidence:${String(args.promptPayload.evidenceWatermark ?? "")}`,
        payload: { ...args.promptPayload },
      });
    }
    return;
  }
  await enqueueFluxQueueItem(args.workspaceRoot, args.config, "bootstrapper", {
    id: newId("q"),
    sessionType: "bootstrapper",
    createdAt: nowIso(),
    reason: improvementKind === "frontier_advanced" ? "model_progress_advanced" : "model_accepted",
    dedupeKey: `bootstrap:${modelRevisionId}`,
    payload: {
      baselineModelRevisionId: modelRevisionId,
      improvementKind,
      modelRevisionId,
      messageForBootstrapper: String(args.modelOutput.message_for_bootstrapper ?? ""),
      modelOutput: args.modelOutput,
      sourceEvidence: args.promptPayload.latestEvidence ?? null,
      sourceEvidenceWatermark: String(args.promptPayload.evidenceWatermark ?? args.modelOutput.evidence_watermark ?? ""),
      modelProgress: args.currentProgress,
      comparePayload: args.comparePayload,
      coverageSummary: persistedSummary,
    },
  });
  const nextSeedMeta = {
    ...seedMeta,
    lastQueuedBootstrapModelRevisionId: modelRevisionId,
    lastQueuedBootstrapCoverageSummary: persistedSummary,
  };
  await saveSeedMeta(args.workspaceRoot, args.config, nextSeedMeta);
}

export async function consumeSupersedingModelerInput(args: {
  workspaceRoot: string;
  config: FluxConfig;
  activeInvocationId: string;
  sessionId: string;
}): Promise<Record<string, unknown> | null> {
  const queue = await loadFluxQueue(args.workspaceRoot, args.config, "modeler");
  const next = queue.items[0] ?? null;
  if (!next || next.id === args.activeInvocationId) {
    return null;
  }
  await saveFluxQueue(args.workspaceRoot, args.config, { ...queue, items: [] });
  await saveFluxInvocationResult(args.workspaceRoot, args.config, {
    invocationId: next.id,
    invocationType: "modeler_invocation",
    sessionType: "modeler",
    status: "superseded",
    recordedAt: nowIso(),
    summary: `superseded by active modeler invocation ${args.activeInvocationId}`,
    payload: {
      supersededByInvocationId: args.activeInvocationId,
      sessionId: args.sessionId,
    },
  });
  await markFluxInvocationStatus({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    invocationId: next.id,
    sessionType: "modeler",
    status: "superseded",
    sessionId: args.sessionId,
  });
  return next.payload && typeof next.payload === "object" && !Array.isArray(next.payload)
    ? next.payload as Record<string, unknown>
    : null;
}

export function buildModelerContinuePrompt(args: {
  template: string;
  acceptanceMessage: string;
  latestEvidenceWatermark: string;
  newerEvidenceWatermark?: string | null;
  maxLevel?: number | null;
  targetLevel?: number | null;
  targetSequenceId?: string | null;
  failingStep?: number | null;
  failingReason?: string | null;
  frameCountGame?: number | null;
  frameCountModel?: number | null;
}): string {
  const rendered = renderTemplate(args.template, {
    acceptance_message: args.acceptanceMessage,
  }).trim();
  const lines = [rendered];
  if (args.maxLevel) {
    lines.push("");
    lines.push(`Keep the next retry inside levels 1 through ${args.maxLevel}. Once those visible sequences all match, stop and hand off.`);
  }
  if (args.targetLevel) {
    if (args.targetSequenceId) {
      lines.push(`Focus the next retry on level ${args.targetLevel} sequence ${args.targetSequenceId} first.`);
      lines.push(`After your patch, rerun the targeted compare before a full pass: python3 model.py compare_sequences --game-id ... --level ${args.targetLevel} --sequence ${args.targetSequenceId} --include-reset-ended`);
    } else {
      lines.push(`After your patch, rerun the level batch compare first: python3 model.py compare_sequences --game-id ... --level ${args.targetLevel} --include-reset-ended`);
    }
  }
  if (args.targetLevel && args.targetSequenceId && args.failingStep) {
    lines.push(`Current failing step: level ${args.targetLevel} sequence ${args.targetSequenceId} step ${args.failingStep}${args.failingReason ? ` (${args.failingReason})` : ""}.`);
  }
  if (
    args.failingReason === "frame_count_mismatch"
    && (Number(args.frameCountGame ?? 0) || 0) > 1
    && (Number(args.frameCountModel ?? 0) || 0) <= 1
  ) {
    lines.push("Do not do another broad mechanic patch first.");
    lines.push("For this retry, inspect the exact failing step's frame files and make your model emit the full transient frame sequence for that step before any deeper generalization.");
    lines.push("If the settled state is already correct, temporarily copy the exact transient frames from evidence for that step via `last_step_frames`, rerun compare, and only then generalize the rule.");
  }
  if (args.newerEvidenceWatermark) {
    lines.push("");
    lines.push(`A newer solver evidence bundle arrived while you were modeling: ${args.newerEvidenceWatermark}.`);
    lines.push("Use the newest synced evidence surface for the next retry instead of continuing from the older mismatch only.");
  } else if (args.latestEvidenceWatermark) {
    lines.push("");
    lines.push(`Current target evidence watermark: ${args.latestEvidenceWatermark}.`);
  }
  return lines.join("\n");
}

function deriveAcceptanceTargetLevel(promptPayload: Record<string, unknown>): number | null {
  const latestEvidence = promptPayload.latestEvidence;
  const latestEvidenceRecord = latestEvidence && typeof latestEvidence === "object" && !Array.isArray(latestEvidence)
    ? latestEvidence as Record<string, unknown>
    : {};
  const state = latestEvidenceRecord.state && typeof latestEvidenceRecord.state === "object" && !Array.isArray(latestEvidenceRecord.state)
    ? latestEvidenceRecord.state as Record<string, unknown>
    : {};
  const currentLevel = Number(state.current_level ?? latestEvidenceRecord.frontier_level ?? 0) || 0;
  return currentLevel > 0 ? currentLevel : null;
}

export function deriveAcceptanceTargetLevelFromState(args: {
  promptPayload: Record<string, unknown>;
  currentCoverageSummary: ReturnType<typeof buildCoverageSummary> | null;
}): number | null {
  const requestedFrontier = deriveAcceptanceTargetLevel(args.promptPayload) ?? 1;
  const acceptedCoverageLevel = args.currentCoverageSummary && args.currentCoverageSummary.allMatch
    ? Number(args.currentCoverageSummary.level ?? 0) || 0
    : 0;
  const maxVisibleAllowed = acceptedCoverageLevel > 0 ? acceptedCoverageLevel + 1 : 1;
  const clamped = Math.min(requestedFrontier, maxVisibleAllowed);
  return clamped > 0 ? clamped : null;
}

export async function deriveInvocationAcceptanceTargetLevel(args: {
  workspaceRoot: string;
  config: FluxConfig;
  promptPayload: Record<string, unknown>;
}): Promise<number | null> {
  const currentCoverageSummary = await loadCurrentModelCoverageSummary(args.workspaceRoot, args.config);
  return deriveAcceptanceTargetLevelFromState({
    promptPayload: args.promptPayload,
    currentCoverageSummary,
  });
}

export function deriveContinuationAcceptanceTarget(args: {
  invocationAcceptanceMaxLevel: number | null;
  currentProgress: ModelProgress;
  priorTarget: { maxLevel?: number | null; level?: number | null; sequenceId?: string | null } | null;
}): { maxLevel?: number | null; level?: number | null; sequenceId?: string | null } | null {
  const rawLevel = args.priorTarget?.level ?? args.currentProgress.level ?? null;
  const clampedLevel = args.invocationAcceptanceMaxLevel
    ? Math.min(Number(rawLevel ?? args.invocationAcceptanceMaxLevel) || args.invocationAcceptanceMaxLevel, args.invocationAcceptanceMaxLevel)
    : (Number(rawLevel ?? 0) || null);
  const canCarrySequenceTarget = Boolean(args.currentProgress.firstFailingSequenceId)
    && (!args.invocationAcceptanceMaxLevel || args.currentProgress.level <= args.invocationAcceptanceMaxLevel);
  if (canCarrySequenceTarget) {
    return {
      maxLevel: args.invocationAcceptanceMaxLevel,
      level: clampedLevel,
      sequenceId: args.currentProgress.firstFailingSequenceId,
    };
  }
  if (clampedLevel) {
    return {
      maxLevel: args.invocationAcceptanceMaxLevel,
      level: clampedLevel,
    };
  }
  return args.invocationAcceptanceMaxLevel
    ? { maxLevel: args.invocationAcceptanceMaxLevel, level: args.invocationAcceptanceMaxLevel }
    : null;
}

export async function publishProgressAdvance(args: {
  workspaceRoot: string;
  config: FluxConfig;
  currentProgress: ModelProgress;
  previousProgress: ModelProgress | null;
  comparePayload: Record<string, unknown>;
  modelOutput: Record<string, unknown>;
  promptPayload: Record<string, unknown>;
  sessionId: string;
  modelRevisionId?: string | null;
  sourceWorkspaceDir: string;
}): Promise<void> {
  if (!isProgressAdvance(args.previousProgress, args.currentProgress)) {
    return;
  }
  await saveBestProgress(args.workspaceRoot, args.config, args.currentProgress);
  const revisionId = args.modelRevisionId ?? newId("model_rev");
  const revisionDir = path.join(fluxModelRoot(args.workspaceRoot, args.config), "revisions", revisionId);
  const summary = buildCoverageSummary({ comparePayload: args.comparePayload, accepted: false });
  await fs.mkdir(revisionDir, { recursive: true });
  await writeJsonAtomic(path.join(revisionDir, "model_update.json"), args.modelOutput);
  const { persistModelRevisionWorkspace } = await import("./model_revision_store.js");
  await persistModelRevisionWorkspace({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    revisionId,
    sourceWorkspaceDir: args.sourceWorkspaceDir,
  });
  await saveModelCoverageSummary({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    revisionId,
    summary,
  });
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "modeler.progress_advanced",
    workspaceRoot: args.workspaceRoot,
    sessionType: "modeler",
    sessionId: args.sessionId,
    summary: `modeled contiguous sequence prefix through ${args.currentProgress.firstFailingSequenceId ? args.currentProgress.contiguousMatchedSequences : args.currentProgress.contiguousMatchedSequences}`,
    payload: {
      level: args.currentProgress.level,
      contiguousMatchedSequences: args.currentProgress.contiguousMatchedSequences,
      firstFailingSequenceId: args.currentProgress.firstFailingSequenceId,
      firstFailingStep: args.currentProgress.firstFailingStep,
      firstFailingReason: args.currentProgress.firstFailingReason,
    },
  }]);
}

export async function prepareModelDraftWorkspace(args: {
  workspaceRoot: string;
  config: FluxConfig;
  invocationId: string;
}): Promise<string> {
  const sourceWorkspaceDir = modelRevisionWorkspaceSource(args.workspaceRoot, args.config);
  const draftRoot = fluxModelDraftDir(args.workspaceRoot, args.config, args.invocationId);
  const destination = path.join(draftRoot, path.basename(sourceWorkspaceDir));
  await fs.rm(draftRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(sourceWorkspaceDir, destination, { recursive: true, force: true });
  const labelsRoot = fluxModelLabelsRoot(args.workspaceRoot, args.config);
  try {
    const entries = await fs.readdir(labelsRoot);
    for (const entry of entries) {
      if (!entry.startsWith(FEATURE_LABELS_PREFIX) || !entry.endsWith(".json")) continue;
      await fs.copyFile(path.join(labelsRoot, entry), path.join(destination, entry));
    }
  } catch {
    // no durable labels yet
  }
  return destination;
}
