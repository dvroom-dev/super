import type { FluxModelCoverageSummary } from "./types.js";

export type ModelProgress = {
  level: number;
  contiguousMatchedSequences: number;
  firstFailingSequenceId: string | null;
  firstFailingStep: number | null;
  firstFailingReason: string | null;
};

function sequenceNumber(sequenceId: string): number | null {
  const match = sequenceId.match(/seq_(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function computeModelProgress(comparePayload: Record<string, unknown>): ModelProgress {
  const reports = Array.isArray(comparePayload.reports) ? comparePayload.reports : [];
  const skipped = Array.isArray(comparePayload.skipped_sequences) ? comparePayload.skipped_sequences : [];
  const bySequence = new Map<number, { matched: boolean; reason: string | null; sequenceId: string; step: number | null }>();
  for (const report of reports) {
    if (!report || typeof report !== "object" || Array.isArray(report)) continue;
    const record = report as Record<string, unknown>;
    const sequenceId = String(record.sequence_id ?? "");
    const order = sequenceNumber(sequenceId);
    if (!order) continue;
    const divergenceStep = Number(record.divergence_step ?? 0) || 0;
    bySequence.set(order, {
      matched: Boolean(record.matched),
      reason: String(record.divergence_reason ?? "") || null,
      sequenceId,
      step: divergenceStep > 0 ? divergenceStep : null,
    });
  }
  for (const skippedRecord of skipped) {
    if (!skippedRecord || typeof skippedRecord !== "object" || Array.isArray(skippedRecord)) continue;
    const record = skippedRecord as Record<string, unknown>;
    const sequenceId = String(record.sequence_id ?? "");
    const order = sequenceNumber(sequenceId);
    if (!order || bySequence.has(order)) continue;
    bySequence.set(order, {
      matched: false,
      reason: String(record.reason ?? record.end_reason ?? "") || null,
      sequenceId,
      step: null,
    });
  }
  const ordered = [...bySequence.entries()].sort((left, right) => left[0] - right[0]);
  let contiguousMatchedSequences = 0;
  let firstFailingSequenceId: string | null = null;
  let firstFailingStep: number | null = null;
  let firstFailingReason: string | null = null;
  for (const [order, item] of ordered) {
    const expected = contiguousMatchedSequences + 1;
    if (order !== expected || !item.matched) {
      firstFailingSequenceId = item.sequenceId || `seq_${String(expected).padStart(4, "0")}`;
      firstFailingStep = item.step;
      firstFailingReason = item.reason;
      break;
    }
    contiguousMatchedSequences = order;
  }
  return {
    level: Number(comparePayload.level ?? 1) || 1,
    contiguousMatchedSequences,
    firstFailingSequenceId,
    firstFailingStep,
    firstFailingReason,
  };
}

export function buildCoverageSummary(args: {
  comparePayload: Record<string, unknown>;
  accepted: boolean;
}): FluxModelCoverageSummary {
  const reports = Array.isArray(args.comparePayload.reports) ? args.comparePayload.reports : [];
  const progress = computeModelProgress(args.comparePayload);
  const coveredSequenceIds = reports
    .filter((report): report is Record<string, unknown> => Boolean(report) && typeof report === "object" && !Array.isArray(report))
    .filter((report) => Boolean(report.matched))
    .map((report) => String(report.sequence_id ?? ""))
    .filter(Boolean);
  const error = args.comparePayload.error && typeof args.comparePayload.error === "object" && !Array.isArray(args.comparePayload.error)
    ? args.comparePayload.error as Record<string, unknown>
    : {};
  const errorType = String(error.type ?? "");
  const frontierDiscovered = Boolean(args.comparePayload.frontier_discovery);
  const compareKind: FluxModelCoverageSummary["compareKind"] = frontierDiscovered
    ? "frontier_discovered_no_sequences"
    : args.accepted
      ? "accepted"
      : errorType ? "incomplete_artifacts" : "rejected";
  return {
    level: Number(args.comparePayload.level ?? progress.level ?? 1) || 1,
    frontierLevel: Number(args.comparePayload.frontier_level ?? args.comparePayload.level ?? progress.level ?? 1) || 1,
    allMatch: Boolean(args.comparePayload.all_match),
    coveredSequenceIds,
    contiguousMatchedSequences: progress.contiguousMatchedSequences,
    firstFailingSequenceId: progress.firstFailingSequenceId,
    firstFailingStep: progress.firstFailingStep,
    firstFailingReason: progress.firstFailingReason,
    frontierDiscovered,
    compareKind,
  };
}

export function classifyModelImprovement(
  baseline: FluxModelCoverageSummary | null,
  candidate: FluxModelCoverageSummary,
): "no_improvement" | "new_coverage" | "frontier_advanced" {
  if (!baseline) {
    return candidate.compareKind === "accepted" || candidate.frontierDiscovered ? "new_coverage" : "no_improvement";
  }
  const baselineFrontier = Number(baseline.frontierLevel ?? baseline.level ?? 1) || 1;
  const candidateFrontier = Number(candidate.frontierLevel ?? candidate.level ?? 1) || 1;
  const baselineCovered = new Set(baseline.coveredSequenceIds);
  if (candidate.coveredSequenceIds.some((sequenceId) => !baselineCovered.has(sequenceId))) {
    return "new_coverage";
  }
  if (candidateFrontier > baselineFrontier || candidate.contiguousMatchedSequences > baseline.contiguousMatchedSequences) {
    return "frontier_advanced";
  }
  return "no_improvement";
}
