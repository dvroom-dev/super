import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";

describe("loadFluxConfig", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-config-"));
  });

  test("loads a valid config", async () => {
    await fs.writeFile(path.join(workspaceRoot, "flux.yaml"), `
schema_version: 1
runtime_defaults:
  provider: claude
  model: claude-opus-4-6
  reasoning_effort: medium
  sandbox_mode: workspace-write
  approval_policy: never
  env: {}
storage:
  flux_root: flux
  ai_root: .ai-flux
orchestrator:
  tick_ms: 10
  solver_preempt_grace_ms: 10
  evidence_poll_ms: 10
  modeler_idle_backoff_ms: 10
  bootstrapper_idle_backoff_ms: 10
problem:
  provision_instance:
    command: ["echo", "provision"]
  destroy_instance:
    command: ["echo", "destroy"]
  observe_evidence:
    command: ["echo", "observe"]
  replay_seed:
    command: ["echo", "replay"]
  merge_evidence:
    strategy: dedupe_by_fingerprint
solver:
  prompt_file: prompts/solver.md
  session_scope: per_attempt
  resume_policy: never
  cadence_ms: 10
  queue_replacement_grace_ms: 10
  tools:
    builtin: [shell]
modeler:
  prompt_file: prompts/modeler.md
  session_scope: run
  resume_policy: always
  triggers:
    on_new_evidence: true
    on_solver_stopped: true
    periodic_ms: 10
  output_schema: model_update_v1
  acceptance:
    command: ["echo", "{}"]
    parse_as: json
    continue_message_template_file: prompts/modeler_continue.md
bootstrapper:
  prompt_file: prompts/bootstrapper.md
  session_scope: run
  resume_policy: always
  output_schema: bootstrap_attestation_v1
  seed_bundle_path: flux/seed/current.json
  replay:
    max_attempts_per_event: 1
    continue_message_template_file: prompts/bootstrapper_continue.md
observability:
  capture_prompts: true
  capture_raw_provider_events: true
  capture_tool_calls: true
  capture_tool_results: true
  capture_queue_snapshots: true
  capture_timing_metrics: true
retention:
  keep_all_events: true
  keep_all_sessions: true
  keep_all_attempts: true
`, "utf8");

    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    expect(config.schemaVersion).toBe(1);
    expect(config.runtimeDefaults.provider).toBe("claude");
    expect(config.bootstrapper.seedBundlePath).toBe("flux/seed/current.json");
  });

  test("fails loudly on missing required fields", async () => {
    await fs.writeFile(path.join(workspaceRoot, "flux.yaml"), "schema_version: 1\n", "utf8");
    await expect(loadFluxConfig(workspaceRoot, "flux.yaml")).rejects.toThrow("runtime_defaults must be a mapping");
  });
});
