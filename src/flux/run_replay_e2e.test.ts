import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fixture from "./__fixtures__/run_20260406_stale_surface.json";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { loadFluxQueue, saveFluxQueue } from "./queue.js";
import { runSolverQueueItem } from "./solver_runtime.js";
import { loadFluxSession } from "./session_store.js";
import { saveFluxState } from "./state.js";
import type { FluxRunState } from "./types.js";

describe("flux replay fixture", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-replay-e2e-"));
    await fs.mkdir(path.join(workspaceRoot, "prompts"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "prompts", "solver.md"), "SOLVER_PROMPT", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler.md"), "MODELER_PROMPT", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "bootstrapper.md"), "BOOTSTRAP_PROMPT", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler_continue.md"), "Continue model.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "bootstrapper_continue.md"), "Continue bootstrap.", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
    const writeScript = async (name: string, body: string) => {
      const filePath = path.join(workspaceRoot, "scripts", name);
      await fs.writeFile(filePath, body, "utf8");
      await fs.chmod(filePath, 0o755);
      return filePath;
    };
    const provision = await writeScript("provision.js", `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const id = input.seedRevisionId || input.attemptId || "instance_1";
  process.stdout.write(JSON.stringify({
    instance_id: id,
    working_directory: input.workspaceRoot,
    prompt_text: "Puzzle context",
    env: {},
    metadata: { state_dir: input.workspaceRoot, solver_dir: input.workspaceRoot }
  }));
});`);
    const destroy = await writeScript("destroy.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write("{}"));`);
    const observe = await writeScript("observe.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const payload = ${JSON.stringify(fixture.staleEvidence, null, 2)};
  process.stdout.write(JSON.stringify({
    evidence: [payload],
    evidence_bundle_id: "evidence_replay_fixture",
    evidence_bundle_path: "/tmp/evidence_replay_fixture"
  }));
});`);
    const replay = await writeScript("replay.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  replay_ok: true,
  tool_results: [],
  evidence: [{
    summary: "preplayed stale frontier",
    action_count: 1,
    state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", total_steps: 1, current_attempt_steps: 0, last_action_name: "ACTION1" }
  }]
})));`);
    await fs.mkdir(path.join(workspaceRoot, "flux", "seed"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "current.json"), JSON.stringify(fixture.seed, null, 2), "utf8");
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
    command: ["${provision}"]
  destroy_instance:
    command: ["${destroy}"]
  observe_evidence:
    command: ["${observe}"]
  rehearse_seed_on_model:
    command: ["${replay}"]
  replay_seed_on_real_game:
    command: ["${replay}"]
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
    command: ["${replay}"]
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
  keep_all_attempts: true
`, "utf8");
  });

  test("real stale-surface replay does not enqueue modeler and records an explicit surface inconsistency", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_DELAY_MS = "100";
    try {
      const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
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

      const runPromise = runSolverQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_solver_fixture",
          sessionType: "solver",
          createdAt: new Date().toISOString(),
          reason: "replay_fixture",
          payload: {},
        },
      });

      let sessionId = "";
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !sessionId) {
        const solverDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
        try {
          const sessions = (await fs.readdir(solverDir)).filter((name) => name.startsWith("solver_attempt_")).sort();
          sessionId = sessions[0] || "";
        } catch {
          sessionId = "";
        }
        if (!sessionId) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(sessionId).toBeTruthy();

      const eventDeadline = Date.now() + 4000;
      let events = await readFluxEvents(workspaceRoot, config);
      while (Date.now() < eventDeadline && !events.some((event) => event.kind === "solver.infrastructure_failure")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        events = await readFluxEvents(workspaceRoot, config);
      }
      expect(events.some((event) => event.kind === "solver.evidence_surface_incomplete")).toBe(true);
      expect(events.some((event) => event.kind === "solver.infrastructure_failure")).toBe(true);

      const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
      expect(modelerQueue.items).toHaveLength(0);

      await runPromise;
      const session = await loadFluxSession(workspaceRoot, config, "solver", sessionId);
      expect(session?.stopReason).toBe("evidence_surface_incomplete");
      const latestState = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "state.json"), "utf8")) as FluxRunState;
      expect(latestState.stopRequested).toBe(false);
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  }, 15000);

  test("stale surface failure does not strand an already queued replacement solver", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_DELAY_MS = "100";
    try {
      const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
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
      await saveFluxQueue(workspaceRoot, config, {
        sessionType: "solver",
        updatedAt: new Date().toISOString(),
        items: [{
          id: "q_replacement_fixture",
          sessionType: "solver",
          createdAt: new Date().toISOString(),
          reason: "bootstrapper_finalized_seed",
          payload: {
            seedBundle: fixture.seed,
            interruptPolicy: "queue_and_interrupt",
          },
        }],
      });

      await runSolverQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_solver_fixture",
          sessionType: "solver",
          createdAt: new Date().toISOString(),
          reason: "replay_fixture",
          payload: {},
        },
      });

      const latestState = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "state.json"), "utf8")) as FluxRunState;
      const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
      expect(latestState.stopRequested).toBe(false);
      expect(solverQueue.items).toHaveLength(1);
      expect(solverQueue.items[0]?.id).toBe("q_replacement_fixture");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  }, 15000);
});
