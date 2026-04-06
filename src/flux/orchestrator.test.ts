import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import pathSync from "node:path";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { requestFluxStop, runFluxOrchestrator } from "./orchestrator.js";
import { fluxRunLockPath } from "./paths.js";
import { loadFluxQueue } from "./queue.js";
import { loadFluxState } from "./state.js";

async function readFluxEventsWithRetry(workspaceRoot: string, config: Awaited<ReturnType<typeof loadFluxConfig>>) {
  const deadline = Date.now() + 2000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await readFluxEvents(workspaceRoot, config);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "failed to read flux events"));
}

async function writeConfig(workspaceRoot: string) {
  await fs.mkdir(path.join(workspaceRoot, "prompts"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "prompts", "solver.md"), "Solve.", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler.md"), "Model.", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "prompts", "bootstrapper.md"), "Bootstrap.", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler_continue.md"), "Continue model.", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "prompts", "bootstrapper_continue.md"), "Continue bootstrap.", "utf8");
  await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
  const writeScript = async (name: string, body: string) => {
    const filePath = path.join(workspaceRoot, "scripts", name);
    await fs.writeFile(filePath, body, "utf8");
    await fs.chmod(filePath, 0o755);
    return filePath;
  };
  const provisionPath = await writeScript("provision.js", `#!/usr/bin/env node
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
  const destroyPath = await writeScript("destroy.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write("{}"));`);
  const observePath = await writeScript("observe.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ evidence: [] })));`);
  const replayPath = await writeScript("replay.js", `#!/usr/bin/env node
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
    command: ["${provisionPath}"]
  destroy_instance:
    command: ["${destroyPath}"]
  observe_evidence:
    command: ["${observePath}"]
  rehearse_seed_on_model:
    command: ["${replayPath}"]
  replay_seed_on_real_game:
    command: ["${replayPath}"]
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
}

describe("runFluxOrchestrator", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-orchestrator-"));
    await writeConfig(workspaceRoot);
  });

  test("initializes state and records start/stop events", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const runPromise = runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await loadFluxState(workspaceRoot, config)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await requestFluxStop(workspaceRoot, config);
    await runPromise;

    const state = await loadFluxState(workspaceRoot, config);
    const events = await readFluxEventsWithRetry(workspaceRoot, config);
    expect(state?.status).toBe("stopped");
    expect(events.some((event) => event.kind === "orchestrator.started")).toBe(true);
    expect(events.some((event) => event.kind === "orchestrator.stopped")).toBe(true);
  });

  test("refuses a second orchestrator for the same workspace when the lock owner is alive", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const lockPath = fluxRunLockPath(workspaceRoot, config);
    await fs.mkdir(pathSync.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n", "utf8");
    await expect(runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config)).rejects.toThrow(
      /already running/,
    );
  });

  test("reconciles stale active session state on restart", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    await fs.mkdir(path.join(workspaceRoot, ".ai-flux", "sessions", "solver", "solver_attempt_old"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-flux", "sessions", "solver", "solver_attempt_old", "session.json"),
      JSON.stringify({
        sessionId: "solver_attempt_old",
        sessionType: "solver",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provider: "mock",
        model: "mock-model",
        resumePolicy: "never",
        sessionScope: "per_attempt",
        activeAttemptId: "attempt_old",
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "state.json"),
      JSON.stringify({
        version: 1,
        workspaceRoot,
        configPath: path.join(workspaceRoot, "flux.yaml"),
        pid: 999999,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "stopped",
        stopRequested: true,
        active: {
          solver: {
            sessionId: "solver_attempt_old",
            status: "running",
            queueItemId: "q_old",
            pid: 999999,
            attemptId: "attempt_old",
            instanceId: "instance_old",
            updatedAt: new Date().toISOString(),
          },
          modeler: { status: "idle", updatedAt: new Date().toISOString() },
          bootstrapper: { status: "idle", updatedAt: new Date().toISOString() },
        },
      }, null, 2),
      "utf8",
    );

    const runPromise = runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config);
    const deadline = Date.now() + 2000;
    let recovered = false;
    while (Date.now() < deadline && !recovered) {
      const current = await loadFluxState(workspaceRoot, config);
      recovered = current?.active.solver.status === "idle";
      if (!recovered) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(recovered).toBe(true);
    await requestFluxStop(workspaceRoot, config);
    await runPromise;

    const state = await loadFluxState(workspaceRoot, config);
    const events = await readFluxEventsWithRetry(workspaceRoot, config);
    expect(state?.active.solver.status).toBe("idle");
    expect(events.some((event) => event.kind === "orchestrator.recovered")).toBe(true);
  });

  test("does not overwrite newer solver state with stale in-memory state during loop save", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const ts = new Date().toISOString();
    await fs.mkdir(path.join(workspaceRoot, "flux"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "state.json"),
      JSON.stringify({
        version: 1,
        workspaceRoot,
        configPath: path.join(workspaceRoot, "flux.yaml"),
        pid: process.pid,
        startedAt: ts,
        updatedAt: ts,
        status: "running",
        stopRequested: false,
        active: {
          solver: {
            sessionId: "solver_attempt_done",
            status: "idle",
            updatedAt: ts,
          },
          modeler: { status: "idle", updatedAt: ts },
          bootstrapper: { status: "idle", updatedAt: ts },
        },
      }, null, 2),
      "utf8",
    );

    const runPromise = runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config);
    const deadline = Date.now() + 2000;
    let liveSessionId = "";
    while (Date.now() < deadline && !liveSessionId) {
      const current = await loadFluxState(workspaceRoot, config);
      const sessionId = current?.active.solver.sessionId;
      if (sessionId && sessionId !== "solver_attempt_done") {
        liveSessionId = sessionId;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(liveSessionId).toMatch(/^solver_attempt_/);
    await requestFluxStop(workspaceRoot, config);
    await runPromise;

    const state = await loadFluxState(workspaceRoot, config);
    expect(state?.active.solver.status).toBe("idle");
    expect(state?.active.solver.sessionId).toMatch(/^solver_attempt_/);
    expect(state?.active.solver.sessionId).not.toBe("solver_attempt_done");
  }, 15000);

  test("reconciles stale bootstrapper running state from session truth during the loop", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const ts = new Date().toISOString();
    await fs.mkdir(path.join(workspaceRoot, ".ai-flux", "sessions", "bootstrapper", "bootstrapper_run"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-flux", "sessions", "bootstrapper", "bootstrapper_run", "session.json"),
      JSON.stringify({
        sessionId: "bootstrapper_run",
        sessionType: "bootstrapper",
        status: "idle",
        createdAt: ts,
        updatedAt: ts,
        provider: "mock",
        model: "mock-model",
        resumePolicy: "always",
        sessionScope: "run",
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "state.json"),
      JSON.stringify({
        version: 1,
        workspaceRoot,
        configPath: path.join(workspaceRoot, "flux.yaml"),
        pid: process.pid,
        startedAt: ts,
        updatedAt: ts,
        status: "running",
        stopRequested: false,
        active: {
          solver: { status: "idle", updatedAt: ts },
          modeler: { status: "idle", updatedAt: ts },
          bootstrapper: {
            sessionId: "bootstrapper_run",
            status: "running",
            queueItemId: "q_boot",
            pid: process.pid,
            updatedAt: ts,
          },
        },
      }, null, 2),
      "utf8",
    );

    const runPromise = runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config);
    const deadline = Date.now() + 2000;
    let reconciled = false;
    while (Date.now() < deadline && !reconciled) {
      const current = await loadFluxState(workspaceRoot, config);
      reconciled = current?.active.bootstrapper.status === "idle";
      if (!reconciled) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(reconciled).toBe(true);
    await requestFluxStop(workspaceRoot, config);
    await runPromise;
  });

  test("reconciles orphan running solver session records when the active slot is idle", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const ts = new Date().toISOString();
    await fs.mkdir(path.join(workspaceRoot, ".ai-flux", "sessions", "solver", "solver_attempt_orphan"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".ai-flux", "sessions", "solver", "solver_attempt_orphan", "session.json"),
      JSON.stringify({
        sessionId: "solver_attempt_orphan",
        sessionType: "solver",
        status: "running",
        createdAt: ts,
        updatedAt: ts,
        provider: "mock",
        model: "mock-model",
        resumePolicy: "never",
        sessionScope: "per_attempt",
        activeAttemptId: "attempt_orphan",
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "state.json"),
      JSON.stringify({
        version: 1,
        workspaceRoot,
        configPath: path.join(workspaceRoot, "flux.yaml"),
        pid: process.pid,
        startedAt: ts,
        updatedAt: ts,
        status: "running",
        stopRequested: false,
        active: {
          solver: { status: "idle", updatedAt: ts },
          modeler: { status: "idle", updatedAt: ts },
          bootstrapper: { status: "idle", updatedAt: ts },
        },
      }, null, 2),
      "utf8",
    );

    const runPromise = runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config);
    const deadline = Date.now() + 2000;
    let reconciled = false;
    while (Date.now() < deadline && !reconciled) {
      const session = JSON.parse(await fs.readFile(path.join(workspaceRoot, ".ai-flux", "sessions", "solver", "solver_attempt_orphan", "session.json"), "utf8"));
      reconciled = session.status === "stopped" && session.stopReason === "orphaned_session_record";
      if (!reconciled) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(reconciled).toBe(true);
    await requestFluxStop(workspaceRoot, config);
    await runPromise;
    const events = await readFluxEventsWithRetry(workspaceRoot, config);
    expect(events.some((event) => event.kind === "orchestrator.reconciled_session_truth")).toBe(true);
  });

});
