import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { FLUX_SESSION_TYPES, loadFluxQueue } from "./queue.js";
import { ensureInitialSolverQueued, dequeueNextSolver } from "./scheduler.js";
import { loadFluxState, saveFluxState } from "./state.js";
import { buildContinuationPrompt, runSolverQueueItem } from "./solver_runtime.js";
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
    env: {},
    metadata: {
      solver_dir: input.workspaceRoot,
      state_dir: input.workspaceRoot
    }
  }));
});`);
    await writeJsonScript(path.join(workspaceRoot, "scripts", "destroy.js"), `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write("{}"));`);
    await writeJsonScript(path.join(workspaceRoot, "scripts", "observe.js"), `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const hasInstance = !!(input.instance && input.instance.metadata);
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: "moved tile",
      effect: "ok",
      action_count: hasInstance ? 1 : 0,
      changed_pixels: hasInstance ? 1 : 0
    }]
  }));
});`);
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
  rehearse_seed_on_model:
    command: ["${path.join(workspaceRoot, "scripts", "replay.js")}"]
  replay_seed_on_real_game:
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

  test("does not hard-stop solver turns just because cadence elapses", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "";
    process.env.MOCK_PROVIDER_DELAY_MS = "200";
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    config.solver.cadenceMs = 10
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
    await runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_timeout",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "timeout_probe",
        payload: {},
      },
      state,
    });
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "queue.preempt_requested")).toBe(false);
    delete process.env.MOCK_PROVIDER_DELAY_MS;
  });

  test("requeues solver when no real action evidence exists", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const observeScript = path.join(workspaceRoot, "scripts", "observe.js");
    await fs.writeFile(observeScript, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ evidence: [{ summary: "no action", action_count: 0, changed_pixels: 0 }] })));`, "utf8");
    await fs.chmod(observeScript, 0o755);
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
    await runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_retry",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "retry",
        payload: {},
      },
      state,
    });
    const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    expect(solverQueue.items).toHaveLength(1);
  });

  test("continues solver across natural provider stop when the turn made progress", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const observeScript = path.join(workspaceRoot, "scripts", "observe.js");
    const observeCounterPath = path.join(workspaceRoot, "observe-count.txt");
    await fs.writeFile(observeCounterPath, "0", "utf8");
    await fs.writeFile(observeScript, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const counterPath = path.join(input.workspaceRoot, "observe-count.txt");
  const count = Number(fs.readFileSync(counterPath, "utf8")) || 0;
  const next = count + 1;
  fs.writeFileSync(counterPath, String(next));
  const steps = 1;
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: "step evidence",
      action_count: steps,
      changed_pixels: steps,
      state: {
        current_level: 1,
        levels_completed: 0,
        state: "NOT_FINISHED",
        current_attempt_steps: steps,
        total_steps: steps
      }
    }]
  }));
});`, "utf8");
    await fs.chmod(observeScript, 0o755);
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
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
    await runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_continue_after_progress",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "continue_after_progress",
        payload: {},
      },
      state,
    });
    const sessionDirRoot = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
    const [sessionDir] = await fs.readdir(sessionDirRoot);
    const messages = await fs.readFile(path.join(sessionDirRoot, sessionDir, "messages.jsonl"), "utf8");
    expect(messages).toContain("Continue solving from the current live state.");
  });

  test("requeues solver when observed evidence comes only from seed replay", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const observeScript = path.join(workspaceRoot, "scripts", "observe.js");
    await fs.writeFile(observeScript, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const replayOnly = !!(input.instance && input.instance.metadata);
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: "replay-only action",
      action_count: replayOnly ? 1 : 0,
      changed_pixels: replayOnly ? 1 : 0,
      state: {
        current_attempt_steps: replayOnly ? 1 : 0,
        total_steps: replayOnly ? 1 : 0
      }
    }]
  }));
});`, "utf8");
    await fs.chmod(observeScript, 0o755);
    const replayScript = path.join(workspaceRoot, "scripts", "replay.js");
    await fs.writeFile(replayScript, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  replay_ok: true,
  evidence: [{
    summary: "seed replay",
    action_count: 1,
    changed_pixels: 1,
    state: { current_attempt_steps: 1, total_steps: 1 }
  }]
})));`, "utf8");
    await fs.chmod(replayScript, 0o755);
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
    await runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_seed_only",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "seed_only",
        payload: {
          seedBundle: {
            version: 1,
            generatedAt: new Date().toISOString(),
            syntheticMessages: [{ role: "assistant", text: "do action" }],
            replayPlan: [{ tool: "shell", args: { cmd: ["echo", "hi"] } }],
            assertions: [],
          },
        },
      },
      state,
    });
    const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    expect(solverQueue.items).toHaveLength(1);
    expect(modelerQueue.items).toHaveLength(0);
  });

  test("preplayed solver startup uses a real attempt id and compact prompt", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "seeded solver output";
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
    await runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_preplayed",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "bootstrapper_finalized_seed",
        payload: {
          attemptId: "",
          preplayedInstance: {
            instance_id: "seed_rev_demo",
            working_directory: workspaceRoot,
            env: {},
            metadata: { solver_dir: workspaceRoot, state_dir: workspaceRoot },
          },
          seedBundle: {
            version: 1,
            generatedAt: new Date().toISOString(),
            syntheticMessages: [
              { role: "assistant", text: "Replay the verified prefix, then solve from the frontier." },
            ],
            replayPlan: [{ tool: "shell", args: { cmd: ["arc_action", "ACTION1"] } }],
            assertions: [],
          },
          preplayedReplayResult: {
            replay_ok: true,
            tool_results: [{
              tool: "shell",
              stdout: "x".repeat(5000),
            }],
            evidence: [{
              summary: "state=NOT_FINISHED level=2 completed=1 actions=17 last_action=ACTION1",
              state: {
                current_level: 2,
                levels_completed: 1,
                state: "NOT_FINISHED",
                total_steps: 17,
                current_attempt_steps: 1,
                last_action_name: "ACTION1",
                available_actions: [1, 2, 3, 4],
              },
            }],
          },
        },
      },
      state,
    });
    const solverSessionsDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
    const sessionNames = await fs.readdir(solverSessionsDir);
    const actualSessionName = sessionNames.find((name) => name.startsWith("solver_attempt_"));
    expect(actualSessionName).toBeTruthy();
    expect(sessionNames.includes("solver_")).toBe(false);
    const messagesPath = path.join(solverSessionsDir, actualSessionName!, "messages.jsonl");
    const messages = (await fs.readFile(messagesPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const initialUserPrompt = messages.find((message) => message.kind === "user")?.text ?? "";
    expect(initialUserPrompt).toContain("Seed preplay already ran on this instance.");
    expect(initialUserPrompt).toContain("Current live state after preplay: level 2");
    expect(initialUserPrompt).not.toContain("\"tool_results\"");
    expect(initialUserPrompt.length).toBeLessThan(12000);
  });

  test("continuation prompt is frontier-aware", () => {
    const prompt = buildContinuationPrompt([{
      summary: "state=NOT_FINISHED level=2 completed=1 actions=17 last_action=ACTION1",
      state: {
        current_level: 2,
        levels_completed: 1,
        state: "NOT_FINISHED",
        total_steps: 17,
        current_attempt_steps: 1,
        last_action_name: "ACTION1",
        available_actions: [1, 2, 3, 4],
      },
    }]);
    expect(prompt).toContain("You are already at frontier level 2.");
    expect(prompt).toContain("last action ACTION1");
    expect(prompt).not.toContain("You have not solved level 1 yet.");
  });
});
