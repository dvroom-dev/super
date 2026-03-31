import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../utils/hash.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { fluxRoot } from "./paths.js";
import type { FluxConfig, FluxEvidenceRecord } from "./types.js";

function evidencePath(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "evidence", "evidence.jsonl");
}

function watermarkPath(workspaceRoot: string, config: FluxConfig): string {
  return path.join(fluxRoot(workspaceRoot, config), "evidence", "latest_watermark.json");
}

export async function appendEvidence(
  workspaceRoot: string,
  config: FluxConfig,
  records: Array<Omit<FluxEvidenceRecord, "evidenceId" | "fingerprint">>,
): Promise<{ watermark: string; appended: FluxEvidenceRecord[] }> {
  if (records.length === 0) {
    return { watermark: "", appended: [] };
  }
  const normalized: FluxEvidenceRecord[] = records.map((record) => ({
    ...record,
    evidenceId: sha256Hex(JSON.stringify(record)),
    fingerprint: sha256Hex(JSON.stringify(record.payload)),
  }));
  let appended = normalized;
  if (config.problem.mergeEvidence.strategy === "dedupe_by_fingerprint") {
    const existing = await fs.readFile(evidencePath(workspaceRoot, config), "utf8").catch(() => "");
    const fingerprints = new Set<string>();
    for (const line of existing.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<FluxEvidenceRecord>;
        if (typeof parsed.fingerprint === "string" && parsed.fingerprint) {
          fingerprints.add(parsed.fingerprint);
        }
      } catch {
        continue;
      }
    }
    appended = normalized.filter((record) => !fingerprints.has(record.fingerprint));
  }
  if (appended.length === 0) {
    return { watermark: "", appended: [] };
  }
  await fs.mkdir(path.dirname(evidencePath(workspaceRoot, config)), { recursive: true });
  await fs.appendFile(evidencePath(workspaceRoot, config), appended.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  const watermark = appended[appended.length - 1]!.evidenceId;
  await writeJsonAtomic(watermarkPath(workspaceRoot, config), { watermark, updatedAt: new Date().toISOString() });
  return { watermark, appended };
}
