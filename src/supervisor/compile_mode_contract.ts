export type SupervisorModeGuidance = {
  description?: string;
  startWhen?: string[];
  stopWhen?: string[];
};

type BuildModeContractJsonArgs = {
  currentMode: string;
  allowedNextModes: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  modeGuidanceByMode?: Record<string, SupervisorModeGuidance>;
};

function normalizeList(values: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizedModeGuidance(raw: SupervisorModeGuidance | undefined): SupervisorModeGuidance {
  return {
    description: String(raw?.description ?? "").trim() || undefined,
    startWhen: normalizeList(raw?.startWhen),
    stopWhen: normalizeList(raw?.stopWhen),
  };
}

export function buildModeContractJson(args: BuildModeContractJsonArgs): string {
  const allowedNextModes = normalizeList(args.allowedNextModes);
  const guidanceByMode = args.modeGuidanceByMode ?? {};
  const currentGuidance = normalizedModeGuidance(guidanceByMode[args.currentMode]);
  const candidateModes = allowedNextModes.map((mode) => {
    const guidance = normalizedModeGuidance(guidanceByMode[mode]);
    return {
      mode,
      description: guidance.description ?? null,
      start_when: guidance.startWhen ?? [],
      stop_when: guidance.stopWhen ?? [],
      mode_payload_fields: normalizeList(args.modePayloadFieldsByMode?.[mode]),
    };
  });
  const modeContract = {
    current_mode: args.currentMode,
    current_mode_description: currentGuidance.description ?? null,
    current_mode_stop_when: currentGuidance.stopWhen ?? [],
    candidate_modes: candidateModes,
  };
  return JSON.stringify(modeContract, null, 2);
}
