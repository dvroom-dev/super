export const RUN_CONFIG_PRESETS = ["benchmark_strict"] as const;

export type RunConfigPresetName = (typeof RUN_CONFIG_PRESETS)[number];

export type PresetRules = {
  agentRules: string[];
  supervisorInstructions: string[];
};

const BENCHMARK_STRICT: PresetRules = {
  agentRules: [
    "Do not modify files under tests/.",
    "Do not modify problem.py or frozen_problem internals.",
    "Do not monkeypatch, clamp, spoof, or otherwise alter cycle accounting or benchmark reporting.",
    "Only pursue genuine algorithmic/kernel optimizations in perf_takehome.py.",
    "Verify progress with python tests/submission_tests.py and report measured cycles from that command.",
    "The task is only complete if measured cycles are strictly below 1000.",
    "If cycles are 1000 or higher, continue iterating and do not claim completion.",
    "Avoid scanning .ai-supervisor directories unless explicitly needed.",
  ],
  supervisorInstructions: [
    "Treat any benchmark/reporting manipulation as a hard rule violation.",
    "If cheating/manipulation is detected, require rewrite/removal of that approach and set resume=true.",
    "If cycles are >= 1000, do not allow completion claims; force continuation.",
    "Keep context compact by replacing stale verbose outputs with concise summaries and references.",
  ],
};

const PRESET_RULES: Record<RunConfigPresetName, PresetRules> = {
  benchmark_strict: BENCHMARK_STRICT,
};

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function normalizePresetName(raw: string, sourcePath: string): RunConfigPresetName {
  const normalized = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if ((RUN_CONFIG_PRESETS as readonly string[]).includes(normalized)) {
    return normalized as RunConfigPresetName;
  }
  throw new Error(`${sourcePath}: unsupported preset '${raw}' (supported: ${RUN_CONFIG_PRESETS.join(", ")})`);
}

export function resolvePresetRules(presets: RunConfigPresetName[]): PresetRules {
  const agentRules: string[] = [];
  const supervisorInstructions: string[] = [];
  for (const preset of presets) {
    const rules = PRESET_RULES[preset];
    if (!rules) continue;
    agentRules.push(...rules.agentRules);
    supervisorInstructions.push(...rules.supervisorInstructions);
  }
  return {
    agentRules: dedupe(agentRules),
    supervisorInstructions: dedupe(supervisorInstructions),
  };
}
