import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { runBootstrapperQueueItem } from "./bootstrapper_runtime.js";
import { loadFluxQueue, saveFluxQueue } from "./queue.js";
import { loadFluxSession, saveFluxSession } from "./session_store.js";
import { saveFluxState } from "./state.js";
import type { FluxRunState } from "./types.js";

describe("bootstrapper runtime", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-bootstrapper-"));
    await fs.mkdir(path.join(workspaceRoot, "prompts"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "prompts", "solver.md"), "Solve.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler.md"), "Model.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "bootstrapper.md"), "Bootstrap.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler_continue.md"), "Continue model: {{acceptance_message}}", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "bootstrapper_continue.md"), "Continue bootstrap: {{replay_results}}", "utf8");
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
  process.stdout.write(JSON.stringify({ instance_id: "instance_r1", working_directory: input.workspaceRoot }));
});`);
    const destroy = await writeScript("destroy.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write("{}"));`);
    const observe = await writeScript("observe.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ evidence: [] })));`);
    const rehearse = await writeScript("rehearse.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ rehearsal_ok: true, tool_results: [{ tool: "model", ok: true }], model_state: { current_level: 2 } })));`);
    const replay = await writeScript("replay.js", `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    replay_ok: true,
    tool_results: [{ tool: "real", ok: true }],
    instance: input.instance || {},
  }));
});`);
    await fs.mkdir(path.join(workspaceRoot, "flux", "seed"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "current.json"), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      syntheticMessages: [{ role: "assistant", text: "Do A" }],
      replayPlan: [{ tool: "shell", args: { cmd: ["arc_action", "ACTION1"] } }],
      assertions: [],
    }, null, 2), "utf8");
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
    command: ["${rehearse}"]
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
    command: ["${observe}"]
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

  test("runs model rehearsal before finalizing and queues solver on a later finalize pass", async () => {
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
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "finalize_seed",
      summary: "ready to finalize",
      seed_bundle_updated: true,
      notes: "ship it",
      solver_action: "queue_and_interrupt",
      seed_delta_kind: "level_completion_advanced",
    });
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_boot",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "model_accepted",
        payload: { messageForBootstrapper: "use model" },
      },
    });
    let solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    let bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(solverQueue.items).toHaveLength(0);
    expect(bootstrapQueue.items).toHaveLength(1);
    expect(events.some((event) => event.kind === "bootstrapper.model_rehearsal_passed")).toBe(true);
    await saveFluxQueue(workspaceRoot, config, { ...bootstrapQueue, items: [] });

    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "finalize_seed",
      summary: "ready to finalize",
      seed_bundle_updated: false,
      notes: "ship it",
      solver_action: "queue_and_interrupt",
      seed_delta_kind: "level_completion_advanced",
    });
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_boot_retry",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "bootstrapper_retry_after_model_rehearsal",
        payload: { rehearsalResult: { rehearsal_ok: true } },
      },
    });
    solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(solverQueue.items).toHaveLength(1);
    expect(solverQueue.items[0]?.payload.seedBundle).toBeTruthy();
    expect(bootstrapQueue.items).toHaveLength(0);
    const finalEvents = await readFluxEvents(workspaceRoot, config);
    expect(finalEvents.some((event) => event.kind === "bootstrapper.real_replay_passed")).toBe(true);
    expect(finalEvents.some((event) => event.kind === "bootstrapper.attested_satisfactory")).toBe(true);
  });

  test("does not queue another solver attempt for an unchanged approved finalized seed", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "finalize_seed",
      summary: "looks good",
      seed_bundle_updated: true,
      notes: "ship it",
      solver_action: "queue_and_interrupt",
      seed_delta_kind: "level_completion_advanced",
    });
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
    const queueItem = {
      id: "q_boot_same",
      sessionType: "bootstrapper" as const,
      createdAt: new Date().toISOString(),
      reason: "model_accepted",
      payload: { messageForBootstrapper: "use model" },
    };
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem,
    });
    let solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    expect(solverQueue.items).toHaveLength(0);
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(1);
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_boot_same_finalize",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "bootstrapper_retry_after_model_rehearsal",
        payload: { rehearsalResult: { rehearsal_ok: true } },
      },
    });
    solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    expect(solverQueue.items).toHaveLength(1);
    await saveFluxQueue(workspaceRoot, config, { ...solverQueue, items: [] });
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: { ...queueItem, id: "q_boot_same_2" },
    });
    solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    expect(solverQueue.items).toHaveLength(0);
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "bootstrapper.attested_satisfactory" && event.payload?.changed === false && event.payload?.queuedSolver === false)).toBe(true);
  });

  test("queues a continuation when bootstrap seed references generated artifacts in replayPlan", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "finalize_seed",
      summary: "ship it",
      seed_bundle_updated: false,
      notes: "done",
      solver_action: "queue_and_interrupt",
      seed_delta_kind: "mechanic_explanation_added",
    });
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "current.json"), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      syntheticMessages: [{ role: "assistant", text: "Do A" }],
      replayPlan: [{ tool: "read_file", args: { path: "agent/game_ls20/level_1/sequences/seq_0001.json" } }],
      assertions: [],
    }, null, 2), "utf8");
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
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_boot_bad_seed",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "model_accepted",
        payload: { messageForBootstrapper: "use model" },
      },
    });
    const queue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.reason).toBe("bootstrapper_invalid_seed");
    expect(String(queue.items[0]?.payload.validationError || "")).toContain("must not target generated sequence artifacts");
    expect(events.some((event) => event.kind === "bootstrapper.seed_invalid")).toBe(true);
  });

  test("queues a continuation when bootstrap seed uses shell snippets instead of replayable argv", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "finalize_seed",
      summary: "ship it",
      seed_bundle_updated: false,
      notes: "done",
      solver_action: "queue_and_interrupt",
      seed_delta_kind: "mechanic_explanation_added",
    });
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "current.json"), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      syntheticMessages: [{ role: "assistant", text: "Do A" }],
      replayPlan: [{ tool: "shell", args: { cmd: ["cd agent/game_ls20 && python - <<'PY'"] } }],
      assertions: [],
    }, null, 2), "utf8");
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
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_boot_bad_shell_seed",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "model_accepted",
        payload: { messageForBootstrapper: "use model" },
      },
    });
    const queue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.reason).toBe("bootstrapper_invalid_seed");
    expect(String(queue.items[0]?.payload.validationError || "")).toContain("direct program token, not a shell snippet");
    expect(events.some((event) => event.kind === "bootstrapper.seed_invalid")).toBe(true);
  });

  test("clears stale bootstrap failure stopReason after a later successful pass", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "continue_refining",
      summary: "keep seed",
      seed_bundle_updated: false,
      notes: "ok",
      solver_action: "no_action",
      seed_delta_kind: "no_useful_change",
    });
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
    await saveFluxSession(workspaceRoot, config, {
      sessionId: "bootstrapper_run",
      sessionType: "bootstrapper",
      status: "failed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      provider: "mock",
      model: "mock-model",
      resumePolicy: "always",
      sessionScope: "run",
      stopReason: "old failure",
    });
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_boot_recover",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "model_accepted",
        payload: { messageForBootstrapper: "use model" },
      },
    });
    const session = await loadFluxSession(workspaceRoot, config, "bootstrapper", "bootstrapper_run");
    expect(session?.status).toBe("idle");
    expect(session?.stopReason).toBeUndefined();
  });

  test("queues a continuation instead of hard-failing when the current seed is invalid", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "finalize_seed",
      summary: "keep going",
      seed_bundle_updated: false,
      notes: "repair seed",
      solver_action: "no_action",
      seed_delta_kind: "no_useful_change",
    });
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "current.json"), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      syntheticMessages: [{ role: "assistant", text: "Do A" }],
      replayPlan: [{ tool: "shell", args: { cmd: ["reset_level"] } }],
      assertions: [],
    }, null, 2), "utf8");
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
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_boot_invalid_seed",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "model_accepted",
        payload: { messageForBootstrapper: "use model" },
      },
    });
    const queue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    const session = await loadFluxSession(workspaceRoot, config, "bootstrapper", "bootstrapper_run");
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.reason).toBe("bootstrapper_invalid_seed");
    expect(String(queue.items[0]?.payload.validationError || "")).toContain("must be one of arc_action, arc_repl, arc_level");
    expect(events.some((event) => event.kind === "bootstrapper.seed_invalid")).toBe(true);
    expect(session?.status).toBe("idle");
  });
});
