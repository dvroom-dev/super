import type { RenderedRunConfig } from "../../../supervisor/run_config.js";
import { frontmatterValue, updateFrontmatterField } from "./mode_runtime.js";

export type ActiveProcessState = {
  stageId: string | null;
  profileId: string | null;
  mode: string | null;
};

export function isV2ProcessEnabled(config: RenderedRunConfig | null | undefined): boolean {
  return Number(config?.schemaVersion ?? 0) >= 2 && Boolean(config?.taskProfiles);
}

export function resolveInitialProcessStage(config: RenderedRunConfig | null | undefined): string | null {
  if (!isV2ProcessEnabled(config)) return null;
  const configured = String(config?.process?.initialStage ?? "").trim();
  if (configured) return configured;
  const first = Object.keys(config?.process?.stages ?? {})[0];
  return first ?? null;
}

export function resolveProcessStage(documentText: string, config: RenderedRunConfig | null | undefined): string | null {
  if (!isV2ProcessEnabled(config)) return null;
  const fromDoc = String(frontmatterValue(documentText, "process_stage") ?? "").trim();
  if (fromDoc) return fromDoc;
  return resolveInitialProcessStage(config);
}

export function resolveTaskProfile(documentText: string, config: RenderedRunConfig | null | undefined): string | null {
  if (!isV2ProcessEnabled(config)) return null;
  const fromDoc = String(frontmatterValue(documentText, "task_profile") ?? "").trim();
  if (fromDoc) return fromDoc;
  const stageId = resolveProcessStage(documentText, config);
  if (!stageId) return null;
  return String(config?.process?.stages?.[stageId]?.profile ?? "").trim() || null;
}

export function resolveTaskProfileMode(config: RenderedRunConfig | null | undefined, profileId: string | null | undefined): string | null {
  if (!profileId || !config?.taskProfiles?.[profileId]) return null;
  return String(config.taskProfiles[profileId]?.mode ?? "").trim() || null;
}

export function profileIdForMode(config: RenderedRunConfig | null | undefined, mode: string | null | undefined): string | null {
  const targetMode = String(mode ?? "").trim();
  if (!targetMode || !config?.taskProfiles) return null;
  for (const [profileId, profile] of Object.entries(config.taskProfiles)) {
    if (String(profile.mode ?? "").trim() === targetMode) return profileId;
  }
  return null;
}

export function stageIdForProfile(config: RenderedRunConfig | null | undefined, profileId: string | null | undefined): string | null {
  const targetProfile = String(profileId ?? "").trim();
  if (!targetProfile || !config?.process?.stages) return null;
  for (const [stageId, stage] of Object.entries(config.process.stages)) {
    if (String(stage.profile ?? "").trim() === targetProfile) return stageId;
  }
  return null;
}

export function resolveActiveProcessState(documentText: string, config: RenderedRunConfig | null | undefined): ActiveProcessState {
  const stageId = resolveProcessStage(documentText, config);
  const profileId = resolveTaskProfile(documentText, config);
  const mode = resolveTaskProfileMode(config, profileId);
  return { stageId, profileId, mode };
}

export function allowedNextModesForProcess(config: RenderedRunConfig | null | undefined, stageId: string | null | undefined): string[] {
  if (!stageId) return [];
  const nextProfiles = config?.process?.stages?.[stageId]?.allowedNextProfiles ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const profileId of nextProfiles) {
    const mode = resolveTaskProfileMode(config, profileId);
    if (!mode || seen.has(mode)) continue;
    seen.add(mode);
    out.push(mode);
  }
  return out;
}

export function validatorsForActiveProcessState(config: RenderedRunConfig | null | undefined, stageId: string | null | undefined, profileId: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of [
    ...(config?.process?.stages?.[stageId ?? ""]?.validators ?? []),
    ...(config?.taskProfiles?.[profileId ?? ""]?.validators ?? []),
  ]) {
    const normalized = String(key ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function selectedModelKeyForTaskProfile(config: RenderedRunConfig | null | undefined, profileId: string | null | undefined): string | null {
  const preferred = config?.taskProfiles?.[profileId ?? ""]?.preferredModels ?? [];
  const modelKey = String(preferred[0] ?? "").trim();
  return modelKey || null;
}

export function applyProcessFrontmatter(
  documentText: string,
  args: { stageId?: string | null; profileId?: string | null; mode?: string | null },
): string {
  let next = documentText;
  if (args.mode) next = updateFrontmatterField(next, "mode", args.mode);
  if (args.stageId) next = updateFrontmatterField(next, "process_stage", args.stageId);
  if (args.profileId) next = updateFrontmatterField(next, "task_profile", args.profileId);
  return next;
}

export function renderProcessContractMarkdown(config: RenderedRunConfig | null | undefined, state: ActiveProcessState): string {
  if (!isV2ProcessEnabled(config) || !state.stageId || !state.profileId) return "";
  const stage = config?.process?.stages?.[state.stageId];
  const profile = config?.taskProfiles?.[state.profileId];
  const lines = [
    "Process Task Packet (supervisor-owned):",
    "",
    `- Current process stage: ${state.stageId}`,
    `- Current task profile: ${state.profileId}`,
    `- Worker mode: ${state.mode ?? "(unset)"}`,
    stage?.description ? `- Stage description: ${stage.description}` : "",
    stage?.objective ? `- Stage objective: ${stage.objective}` : "",
    profile?.description ? `- Profile description: ${profile.description}` : "",
    profile?.preferredModels?.length ? `- Preferred models: ${profile.preferredModels.join(", ")}` : "",
    profile?.validators?.length || stage?.validators?.length
      ? `- Validators after turn: ${validatorsForActiveProcessState(config, state.stageId, state.profileId).join(", ")}`
      : "",
    profile?.contextRules?.length
      ? ["- Context rules:", ...profile.contextRules.map((rule) => `  - ${rule}`)].join("\n")
      : "",
    config?.process?.globalRules?.length
      ? ["- Global process rules:", ...config.process.globalRules.map((rule) => `  - ${rule}`)].join("\n")
      : "",
    "- Progression is supervisor-owned. Do not assume you may advance stages just because your local reasoning feels complete.",
  ].filter(Boolean);
  return lines.join("\n");
}
