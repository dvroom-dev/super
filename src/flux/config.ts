import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { FluxConfig } from "./types.js";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return Math.floor(parsed);
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty list`);
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
}

function asOptionalStringArray(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
}

function asStringMap(value: unknown, label: string): Record<string, string> {
  if (value == null) return {};
  const record = asRecord(value, label);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) out[key] = asString(entry, `${label}.${key}`);
  return out;
}

function asCommandSpec(value: unknown, label: string): { command: string[] } {
  return { command: asStringArray(asRecord(value, label).command, `${label}.command`) };
}

export async function loadFluxConfig(workspaceRoot: string, configPath: string): Promise<FluxConfig> {
  const resolvedConfigPath = path.resolve(workspaceRoot, configPath);
  const raw = await fs.readFile(resolvedConfigPath, "utf8");
  const parsed = asRecord(YAML.parse(raw), resolvedConfigPath);

  const runtimeDefaults = asRecord(parsed.runtime_defaults, "runtime_defaults");
  const storage = asRecord(parsed.storage, "storage");
  const orchestrator = asRecord(parsed.orchestrator, "orchestrator");
  const problem = asRecord(parsed.problem, "problem");
  const solver = asRecord(parsed.solver, "solver");
  const modeler = asRecord(parsed.modeler, "modeler");
  const bootstrapper = asRecord(parsed.bootstrapper, "bootstrapper");
  const observability = asRecord(parsed.observability, "observability");
  const retention = asRecord(parsed.retention, "retention");

  const schemaVersion = Number(parsed.schema_version);
  if (schemaVersion !== 1) throw new Error("schema_version must be 1");

  return {
    schemaVersion: 1,
    runtimeDefaults: {
      provider: asString(runtimeDefaults.provider, "runtime_defaults.provider"),
      model: asString(runtimeDefaults.model, "runtime_defaults.model"),
      reasoningEffort: runtimeDefaults.reasoning_effort == null ? undefined : asString(runtimeDefaults.reasoning_effort, "runtime_defaults.reasoning_effort") as any,
      sandboxMode: runtimeDefaults.sandbox_mode == null ? undefined : asString(runtimeDefaults.sandbox_mode, "runtime_defaults.sandbox_mode") as any,
      approvalPolicy: runtimeDefaults.approval_policy == null ? undefined : asString(runtimeDefaults.approval_policy, "runtime_defaults.approval_policy") as any,
      env: asStringMap(runtimeDefaults.env, "runtime_defaults.env"),
    },
    storage: {
      fluxRoot: asString(storage.flux_root, "storage.flux_root"),
      aiRoot: asString(storage.ai_root, "storage.ai_root"),
    },
    orchestrator: {
      tickMs: asNumber(orchestrator.tick_ms, "orchestrator.tick_ms"),
      solverPreemptGraceMs: asNumber(orchestrator.solver_preempt_grace_ms, "orchestrator.solver_preempt_grace_ms"),
      evidencePollMs: asNumber(orchestrator.evidence_poll_ms, "orchestrator.evidence_poll_ms"),
      modelerIdleBackoffMs: asNumber(orchestrator.modeler_idle_backoff_ms, "orchestrator.modeler_idle_backoff_ms"),
      bootstrapperIdleBackoffMs: asNumber(orchestrator.bootstrapper_idle_backoff_ms, "orchestrator.bootstrapper_idle_backoff_ms"),
    },
    problem: {
      provisionInstance: asCommandSpec(problem.provision_instance, "problem.provision_instance"),
      destroyInstance: asCommandSpec(problem.destroy_instance, "problem.destroy_instance"),
      observeEvidence: asCommandSpec(problem.observe_evidence, "problem.observe_evidence"),
      syncModelWorkspace: problem.sync_model_workspace == null
        ? undefined
        : asCommandSpec(problem.sync_model_workspace, "problem.sync_model_workspace"),
      rehearseSeedOnModel: asCommandSpec(problem.rehearse_seed_on_model, "problem.rehearse_seed_on_model"),
      replaySeedOnRealGame: asCommandSpec(problem.replay_seed_on_real_game, "problem.replay_seed_on_real_game"),
      mergeEvidence: {
        strategy: asString(asRecord(problem.merge_evidence, "problem.merge_evidence").strategy, "problem.merge_evidence.strategy") as any,
      },
    },
    solver: {
      promptFile: asString(solver.prompt_file, "solver.prompt_file"),
      workingDirectory: solver.working_directory == null ? undefined : asString(solver.working_directory, "solver.working_directory"),
      sessionScope: asString(solver.session_scope, "solver.session_scope") as any,
      resumePolicy: asString(solver.resume_policy, "solver.resume_policy") as any,
      provider: solver.provider == null ? undefined : asString(solver.provider, "solver.provider"),
      model: solver.model == null ? undefined : asString(solver.model, "solver.model"),
      reasoningEffort: solver.reasoning_effort == null ? undefined : asString(solver.reasoning_effort, "solver.reasoning_effort") as any,
      turnTimeoutMs: solver.turn_timeout_ms == null ? undefined : asNumber(solver.turn_timeout_ms, "solver.turn_timeout_ms"),
      cadenceMs: asNumber(solver.cadence_ms, "solver.cadence_ms"),
      queueReplacementGraceMs: asNumber(solver.queue_replacement_grace_ms, "solver.queue_replacement_grace_ms"),
      tools: {
        builtin: asOptionalStringArray(asRecord(solver.tools, "solver.tools").builtin, "solver.tools.builtin"),
        custom: [],
      },
    },
    modeler: {
      promptFile: asString(modeler.prompt_file, "modeler.prompt_file"),
      workingDirectory: modeler.working_directory == null ? undefined : asString(modeler.working_directory, "modeler.working_directory"),
      sessionScope: asString(modeler.session_scope, "modeler.session_scope") as any,
      resumePolicy: asString(modeler.resume_policy, "modeler.resume_policy") as any,
      provider: modeler.provider == null ? undefined : asString(modeler.provider, "modeler.provider"),
      model: modeler.model == null ? undefined : asString(modeler.model, "modeler.model"),
      reasoningEffort: modeler.reasoning_effort == null ? undefined : asString(modeler.reasoning_effort, "modeler.reasoning_effort") as any,
      turnTimeoutMs: modeler.turn_timeout_ms == null ? undefined : asNumber(modeler.turn_timeout_ms, "modeler.turn_timeout_ms"),
      triggers: {
        onNewEvidence: asBoolean(asRecord(modeler.triggers, "modeler.triggers").on_new_evidence, "modeler.triggers.on_new_evidence"),
        onSolverStopped: asBoolean(asRecord(modeler.triggers, "modeler.triggers").on_solver_stopped, "modeler.triggers.on_solver_stopped"),
        periodicMs: asNumber(asRecord(modeler.triggers, "modeler.triggers").periodic_ms, "modeler.triggers.periodic_ms"),
      },
      outputSchema: asString(modeler.output_schema, "modeler.output_schema"),
      acceptance: {
        command: asStringArray(asRecord(modeler.acceptance, "modeler.acceptance").command, "modeler.acceptance.command"),
        parseAs: asString(asRecord(modeler.acceptance, "modeler.acceptance").parse_as, "modeler.acceptance.parse_as") as "json",
        continueMessageTemplateFile: asString(
          asRecord(modeler.acceptance, "modeler.acceptance").continue_message_template_file,
          "modeler.acceptance.continue_message_template_file",
        ),
      },
    },
    bootstrapper: {
      promptFile: asString(bootstrapper.prompt_file, "bootstrapper.prompt_file"),
      workingDirectory: bootstrapper.working_directory == null ? undefined : asString(bootstrapper.working_directory, "bootstrapper.working_directory"),
      sessionScope: asString(bootstrapper.session_scope, "bootstrapper.session_scope") as any,
      resumePolicy: asString(bootstrapper.resume_policy, "bootstrapper.resume_policy") as any,
      provider: bootstrapper.provider == null ? undefined : asString(bootstrapper.provider, "bootstrapper.provider"),
      model: bootstrapper.model == null ? undefined : asString(bootstrapper.model, "bootstrapper.model"),
      reasoningEffort: bootstrapper.reasoning_effort == null ? undefined : asString(bootstrapper.reasoning_effort, "bootstrapper.reasoning_effort") as any,
      turnTimeoutMs: bootstrapper.turn_timeout_ms == null ? undefined : asNumber(bootstrapper.turn_timeout_ms, "bootstrapper.turn_timeout_ms"),
      outputSchema: asString(bootstrapper.output_schema, "bootstrapper.output_schema"),
      seedBundlePath: asString(bootstrapper.seed_bundle_path, "bootstrapper.seed_bundle_path"),
      requireModelRehearsalBeforeFinalize: asBoolean(
        bootstrapper.require_model_rehearsal_before_finalize,
        "bootstrapper.require_model_rehearsal_before_finalize",
      ),
      replay: {
        maxAttemptsPerEvent: asNumber(asRecord(bootstrapper.replay, "bootstrapper.replay").max_attempts_per_event, "bootstrapper.replay.max_attempts_per_event"),
        continueMessageTemplateFile: asString(
          asRecord(bootstrapper.replay, "bootstrapper.replay").continue_message_template_file,
          "bootstrapper.replay.continue_message_template_file",
        ),
      },
    },
    observability: {
      capturePrompts: asBoolean(observability.capture_prompts, "observability.capture_prompts"),
      captureRawProviderEvents: asBoolean(observability.capture_raw_provider_events, "observability.capture_raw_provider_events"),
      captureToolCalls: asBoolean(observability.capture_tool_calls, "observability.capture_tool_calls"),
      captureToolResults: asBoolean(observability.capture_tool_results, "observability.capture_tool_results"),
      captureQueueSnapshots: asBoolean(observability.capture_queue_snapshots, "observability.capture_queue_snapshots"),
      captureTimingMetrics: asBoolean(observability.capture_timing_metrics, "observability.capture_timing_metrics"),
    },
    retention: {
      keepAllEvents: asBoolean(retention.keep_all_events, "retention.keep_all_events"),
      keepAllSessions: asBoolean(retention.keep_all_sessions, "retention.keep_all_sessions"),
      keepAllAttempts: asBoolean(retention.keep_all_attempts, "retention.keep_all_attempts"),
    },
  };
}
