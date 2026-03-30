import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { FLUX_SESSION_TYPES, loadFluxQueue } from "./queue.js";
import { ensureInitialSolverQueued, dequeueNextSolver } from "./scheduler.js";
import { loadFluxState, saveFluxState } from "./state.js";
import { runSolverQueueItem } from "./solver_runtime.js";
import type { FluxRunState } from "./types.js";

async function writeJsonScript(filePath: string, source: string) {
  await fs.writeFile(filePath, source, "utf8");
  await fs.chmod(filePath, 0o755);
}

describe("solver runtime", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-solver-"));
    await fs.mkdir(path.join(workspaceRoot, "prompts"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "prompts", "solver.md"), "Solve the instance.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler.md"), "Model.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "bootstrapper.md"), "Bootstrap.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler_continue.md"), "Continue model.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "bootstrapper_continue.md"), "Continue bootstrap.", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
    await writeJsonScript(path.join(workspaceRoot, "scripts", "provision.js"), `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    instance_id: "instance_1",
    working_directory: input.workspaceRoot,
    prompt_text: "Puzzle context",
    env: {}
  }));
});`);
    await writeJsonScript(path.join(workspaceRoot, "scripts", "destroy.js"), `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write("{}"));`);
    await writeJsonScript(path.join(workspaceRoot, "scripts", "observe.js"), `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ evidence: [{ summary: "moved tile", effect: "ok" }] })));`);
    await writeJsonScript(path.join(workspaceRoot, "scripts", "replay.js"), `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write("{}"));`);
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
    command: ["${path.join(workspaceRoot, "scripts", "provision.js")}"]
  destroy_instance:
    command: ["${path.join(workspaceRoot, "scripts", "destroy.js")}"]
  observe_evidence:
    command: ["${path.join(workspaceRoot, "scripts", "observe.js")}"]
  replay_seed:
    command: ["${path.join(workspaceRoot, "scripts", "replay.js")}"]
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
  });

  test("runs an initial solver attempt and records evidence", async () => {
    process.env.MOCK_PROVIDER_RUNONCE_TEXT = "unused";
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    for (const sessionType of FLUX_SESSION_TYPES) {
      expect((await loadFluxQueue(workspaceRoot, config, sessionType)).items).toHaveLength(0);
    }
    await ensureInitialSolverQueued(workspaceRoot, config);
    const queueItem = await dequeueNextSolver(workspaceRoot, config);
    expect(queueItem).not.toBeNull();
    const state: FluxRunState = {
      version: 1,
      workspaceRoot,
      configPath: path.join(workspaceRoot, "flux.yaml"),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      stopRequested: false,
      active: {
        solver: { status: "idle", updatedAt: new Date().toISOString() },
        modeler: { status: "idle", updatedAt: new Date().toISOString() },
        bootstrapper: { status: "idle", updatedAt: new Date().toISOString() },
      },
    };
    await saveFluxState(workspaceRoot, config, state);
    await runSolverQueueItem({ workspaceRoot, config, queueItem: queueItem!, state });
    const events = await readFluxEvents(workspaceRoot, config);
    const persisted = await loadFluxState(workspaceRoot, config);
    const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    expect(events.some((event) => event.kind === "solver.evidence_observed")).toBe(true);
    expect(persisted?.active.solver.status).toBe("idle");
    expect(modelerQueue.items).toHaveLength(1);
  });
});
