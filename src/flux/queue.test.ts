import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { enqueueFluxQueueItem, loadFluxQueue } from "./queue.js";

describe("flux queue", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-queue-"));
    await fs.writeFile(path.join(workspaceRoot, "flux.yaml"), `
schema_version: 1
runtime_defaults:
  provider: mock
  model: mock-model
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
    command: ["echo"]
  destroy_instance:
    command: ["echo"]
  observe_evidence:
    command: ["echo"]
  rehearse_seed_on_model:
    command: ["echo", "{}"]
  replay_seed_on_real_game:
    command: ["echo", "{}"]
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
    command: ["echo"]
    parse_as: json
    continue_message_template_file: prompts/modeler_continue.md
bootstrapper:
  prompt_file: prompts/bootstrapper.md
  session_scope: run
  resume_policy: always
  output_schema: bootstrap_seed_decision_v1
  seed_bundle_path: flux/seed/current.json
  require_model_rehearsal_before_finalize: true
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
  keep_allAttempts: true
  keep_all_attempts: true
`, "utf8");
  });

  test("keeps only the latest queued solver and modeler items", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    await enqueueFluxQueueItem(workspaceRoot, config, "solver", {
      id: "solver_1",
      sessionType: "solver",
      createdAt: new Date().toISOString(),
      reason: "first",
      payload: { seed: 1 },
    });
    await enqueueFluxQueueItem(workspaceRoot, config, "solver", {
      id: "solver_2",
      sessionType: "solver",
      createdAt: new Date().toISOString(),
      reason: "second",
      payload: { seed: 2 },
    });
    await enqueueFluxQueueItem(workspaceRoot, config, "modeler", {
      id: "modeler_1",
      sessionType: "modeler",
      createdAt: new Date().toISOString(),
      reason: "first",
      payload: { evidence: 1 },
    });
    await enqueueFluxQueueItem(workspaceRoot, config, "modeler", {
      id: "modeler_2",
      sessionType: "modeler",
      createdAt: new Date().toISOString(),
      reason: "second",
      payload: { evidence: 2 },
    });
    const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    expect(solverQueue.items).toHaveLength(1);
    expect(solverQueue.items[0]?.id).toBe("solver_2");
    expect(modelerQueue.items).toHaveLength(1);
    expect(modelerQueue.items[0]?.id).toBe("modeler_2");
  });
});
