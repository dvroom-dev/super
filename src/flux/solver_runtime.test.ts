import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { FLUX_SESSION_TYPES, loadFluxQueue } from "./queue.js";
import { ensureInitialSolverQueued, dequeueNextSolver } from "./scheduler.js";
import { loadFluxState, saveFluxState } from "./state.js";
import { buildContinuationPrompt, requestActiveSolverInterrupt, runSolverQueueItem } from "./solver_runtime.js";
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
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const hasInstance = !!(input.instance && input.instance.metadata);
  const counterPath = path.join(input.workspaceRoot || process.cwd(), ".observe-counter");
  let count = 0;
  try {
    count = Number(fs.readFileSync(counterPath, "utf8")) || 0;
  } catch {}
  count += 1;
  fs.writeFileSync(counterPath, String(count), "utf8");
  const won = hasInstance && count >= 2;
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: "moved tile",
      effect: "ok",
      action_count: hasInstance ? count : 0,
      changed_pixels: hasInstance ? 1 : 0,
      state: {
        current_level: won ? 8 : 1,
        levels_completed: won ? 7 : 0,
        win_levels: 7,
        state: won ? "WIN" : "NOT_FINISHED",
        total_steps: hasInstance ? count : 0,
        current_attempt_steps: hasInstance ? count : 0,
      }
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
  const steps = next >= 2 ? 2 : 1;
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: "step evidence",
      action_count: steps,
      changed_pixels: steps,
      state: {
        current_level: steps >= 2 ? 2 : 1,
        levels_completed: steps >= 2 ? 1 : 0,
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
    process.env.MOCK_PROVIDER_DELAY_MS = "100";
    const runPromise = runSolverQueueItem({
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
    let sessionId = "";
    let sawContinuation = false;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !sawContinuation) {
      const latestState = await loadFluxState(workspaceRoot, config);
      sessionId = latestState?.active.solver.sessionId ?? sessionId;
      if (sessionId) {
        const messagesPath = path.join(workspaceRoot, ".ai-flux", "sessions", "solver", sessionId, "messages.jsonl");
        try {
          const messagesText = await fs.readFile(messagesPath, "utf8");
          sawContinuation = messagesText.includes("Continue solving from the current live state.");
        } catch {}
      }
      if (!sawContinuation) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(sawContinuation).toBe(true);
    requestActiveSolverInterrupt(sessionId);
    await runPromise;
    const sessionDirRoot = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
    const [sessionDir] = await fs.readdir(sessionDirRoot);
    const messages = await fs.readFile(path.join(sessionDirRoot, sessionDir, "messages.jsonl"), "utf8");
    expect(messages).toContain("Continue solving from the current live state.");
    delete process.env.MOCK_PROVIDER_DELAY_MS;
  });

  test("resets the solver provider thread on level transition before the next turn", async () => {
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
  const level = next >= 2 ? 2 : 1;
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: "step evidence",
      action_count: next,
      changed_pixels: next,
      state: {
        current_level: level,
        levels_completed: level - 1,
        state: "NOT_FINISHED",
        current_attempt_steps: next,
        total_steps: next
      }
    }]
  }));
});`, "utf8");
    await fs.chmod(observeScript, 0o755);
    process.env.MOCK_PROVIDER_DELAY_MS = "100";
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
    const runPromise = runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_level_transition_reset",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "level_transition_reset",
        payload: {},
      },
      state,
    });
    let sessionId = "";
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const latestState = await loadFluxState(workspaceRoot, config);
      sessionId = latestState?.active.solver.sessionId ?? sessionId;
      if (sessionId) {
        const sessionPath = path.join(workspaceRoot, ".ai-flux", "sessions", "solver", sessionId, "session.json");
        try {
          const session = JSON.parse(await fs.readFile(sessionPath, "utf8"));
          if (session.lastFrontierLevel === 2 && !session.providerThreadId) break;
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sessionId).toMatch(/^solver_attempt_/);
    const saved = JSON.parse(await fs.readFile(path.join(workspaceRoot, ".ai-flux", "sessions", "solver", sessionId, "session.json"), "utf8"));
    expect(saved.lastFrontierLevel).toBeGreaterThanOrEqual(2);
    expect(saved.pendingSolverTheoryLevel).toBe(1);
    expect(saved.pendingSolverTheoryFrontierLevel).toBe(2);
    expect(saved.providerThreadId).toBeUndefined();
    const requirementPath = path.join(workspaceRoot, ".flux_solver_handoff_requirement.json");
    const requirement = JSON.parse(await fs.readFile(requirementPath, "utf8"));
    expect(requirement.required_theory_level).toBe(1);
    expect(requirement.frontier_level).toBe(2);
    expect(requirement.required_file).toBe("solver_handoff/untrusted_theories.md");
    requestActiveSolverInterrupt(sessionId);
    await runPromise;
    delete process.env.MOCK_PROVIDER_DELAY_MS;
  });

  test("does not require a solver theory handoff just because seed preplay starts on a later level", async () => {
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
        id: "q_preplayed_no_handoff",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "bootstrapper_finalized_seed",
        payload: {
          preplayedInstance: {
            instance_id: "seed_rev_demo",
            working_directory: workspaceRoot,
            env: {},
            metadata: { solver_dir: workspaceRoot, state_dir: workspaceRoot },
          },
          preplayedReplayResult: {
            replay_ok: true,
            evidence: [{
              summary: "state=NOT_FINISHED level=2 completed=1 actions=17 last_action=ACTION1",
              state: {
                current_level: 2,
                levels_completed: 1,
                state: "NOT_FINISHED",
                total_steps: 17,
                current_attempt_steps: 1,
                last_action_name: "ACTION1",
              },
            }],
          },
        },
      },
      state,
    });
    const solverSessionsDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
    const [actualSessionName] = await fs.readdir(solverSessionsDir);
    const promptsDir = path.join(solverSessionsDir, actualSessionName!, "prompts");
    const promptFiles = (await fs.readdir(promptsDir)).sort();
    const initialPrompt = JSON.parse(await fs.readFile(path.join(promptsDir, promptFiles[0]!), "utf8"));
    expect(String(initialPrompt.promptText ?? "")).not.toContain("solver_handoff/untrusted_theories.md");
  });

  test("issues a corrective retry when the solver uses prohibited search", async () => {
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const observeScript = path.join(workspaceRoot, "scripts", "observe.js");
    await fs.writeFile(observeScript, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  evidence: [{
    summary: "step evidence",
    action_count: 1,
    changed_pixels: 1,
    state: {
      current_level: 1,
      levels_completed: 0,
      state: "NOT_FINISHED",
      current_attempt_steps: 1,
      total_steps: 1
    }
  }]
})));`, "utf8");
    await fs.chmod(observeScript, 0o755);
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON = JSON.stringify([
      {
        type: "provider_item",
        item: { provider: "mock", kind: "tool_call", type: "assistant.tool_use", summary: "tool_call Bash", includeInTranscript: true },
        raw: {
          message: {
            content: [{
              type: "tool_use",
              name: "Bash",
              input: { command: "python bfs_probe.py" },
            }],
          },
        },
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "100";
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
      queueItem: {
        id: "q_policy_violation",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "policy_violation",
        payload: {},
      },
      state,
    });
    let sessionId = "";
    let sawCorrectivePrompt = false;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !sawCorrectivePrompt) {
      const latestState = await loadFluxState(workspaceRoot, config);
      sessionId = latestState?.active.solver.sessionId ?? sessionId;
      if (sessionId) {
        const messagesPath = path.join(workspaceRoot, ".ai-flux", "sessions", "solver", sessionId, "messages.jsonl");
        try {
          const messagesText = await fs.readFile(messagesPath, "utf8");
          sawCorrectivePrompt = messagesText.includes("Your last turn violated solver policy.");
        } catch {}
      }
      if (!sawCorrectivePrompt) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(sawCorrectivePrompt).toBe(true);
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "solver.policy_violation")).toBe(true);
    requestActiveSolverInterrupt(sessionId);
    await runPromise;
    delete process.env.MOCK_PROVIDER_DELAY_MS;
    delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
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
    const promptsDir = path.join(solverSessionsDir, actualSessionName!, "prompts");
    const promptFiles = (await fs.readdir(promptsDir)).sort();
    const promptPayload = JSON.parse(await fs.readFile(path.join(promptsDir, promptFiles[0]!), "utf8"));
    const capturedPromptText = String(promptPayload.promptText ?? "");
    const invocationInput = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "invocations", "q_preplayed", "input.json"), "utf8"));
    const invocationStatus = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "invocations", "q_preplayed", "status.json"), "utf8"));
    const invocationResult = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "invocations", "q_preplayed", "result.json"), "utf8"));
    expect(initialUserPrompt).toContain("Seed preplay already ran on this instance.");
    expect(initialUserPrompt).toContain("Current live state after preplay: level 2");
    expect(initialUserPrompt).not.toContain("\"tool_results\"");
    expect(initialUserPrompt.length).toBeLessThan(12000);
    expect(capturedPromptText).toContain("Replay the verified prefix, then solve from the frontier.");
    expect(capturedPromptText).toContain("Synthetic transcript to inherit:");
    expect(promptPayload.invocationId).toBe("q_preplayed");
    expect(invocationInput.invocationId).toBe("q_preplayed");
    expect(invocationStatus.status).toBe("completed");
    expect(invocationResult.status).toBe("completed");
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
    expect(prompt).toContain("write the solver handoff markdown for the previous solved level");
    expect(prompt).toContain("run one bounded real action probe on the new level");
    expect(prompt).toContain("Do not use BFS, DFS, exhaustive reachability, or brute-force search over action/state space.");
    expect(prompt).toContain("Never unpack or subscript the return value of env.step(...)");
    expect(prompt).toContain("switch branch instead of repeating the same action again");
  });

  test("continuation prompt surfaces the required solver theory handoff when pending", () => {
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
    }], { pendingTheoryLevel: 1, pendingTheoryFrontierLevel: 2 });
    expect(prompt).toContain("solver_handoff/untrusted_theories.md");
    expect(prompt).toContain("arc_repl may return `critical_instruction`");
    expect(prompt).toContain("write the solver handoff markdown for the previous solved level");
  });

  test("continuation prompt adds a stronger no-progress nudge when requested", () => {
    const prompt = buildContinuationPrompt([{
      summary: "state=NOT_FINISHED level=1 completed=0 actions=14 last_action=ACTION1",
      state: {
        current_level: 1,
        levels_completed: 0,
        state: "NOT_FINISHED",
        total_steps: 14,
        current_attempt_steps: 0,
        last_action_name: "ACTION1",
        available_actions: [1, 2, 3, 4],
      },
    }], { noProgress: true });
    expect(prompt).toContain("Your last turn did not produce new game progress from the current state.");
    expect(prompt).toContain("Immediately try a different concrete branch from the current live state.");
    expect(prompt).toContain("If one action is now a no-op at the frontier");
  });

  test("solver continues after a stalled turn with a stronger nudge instead of stopping immediately", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_DELAY_MS = "100";
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const observeScript = path.join(workspaceRoot, "scripts", "observe.js");
    await fs.writeFile(observeScript, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const counterPath = path.join(input.workspaceRoot || process.cwd(), ".observe-counter");
  let count = 0;
  try {
    count = Number(fs.readFileSync(counterPath, "utf8")) || 0;
  } catch {}
  count += 1;
  fs.writeFileSync(counterPath, String(count), "utf8");
  const payloads = [
    { action_count: 1, changed_pixels: 1, state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", total_steps: 1, current_attempt_steps: 1 } },
    { action_count: 1, changed_pixels: 0, state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", total_steps: 1, current_attempt_steps: 1 } },
  ];
  process.stdout.write(JSON.stringify({ evidence: [payloads[Math.min(count - 1, payloads.length - 1)]] }));
});`, "utf8");
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
    const runPromise = runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_nudge",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "stalled_turn",
        payload: {},
      },
      state,
    });
    let sessionId = "";
    let sawNudgePrompt = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !sawNudgePrompt) {
      const latestState = await loadFluxState(workspaceRoot, config);
      sessionId = latestState?.active.solver.sessionId ?? sessionId;
      if (sessionId) {
        const messagesPath = path.join(workspaceRoot, ".ai-flux", "sessions", "solver", sessionId, "messages.jsonl");
        try {
          const messagesText = await fs.readFile(messagesPath, "utf8");
          sawNudgePrompt = messagesText.includes("Your last turn did not produce new game progress from the current state.");
        } catch {}
      }
      if (!sawNudgePrompt) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(sawNudgePrompt).toBe(true);
    expect(sessionId).toBeTruthy();
    requestActiveSolverInterrupt(sessionId);
    await runPromise;
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "solver.no_progress_nudged")).toBe(true);
    const solverSessionDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
    const sessionName = (await fs.readdir(solverSessionDir)).find((name) => name.startsWith("solver_attempt_"));
    const messages = (await fs.readFile(path.join(solverSessionDir, sessionName!, "messages.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages.some((message) => message.kind === "user" && String(message.text).includes("Your last turn did not produce new game progress"))).toBe(true);
    delete process.env.MOCK_PROVIDER_DELAY_MS;
  });

  test("solver yields control after repeated no-progress nudges", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const observeScript = path.join(workspaceRoot, "scripts", "observe.js");
    await fs.writeFile(observeScript, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  evidence: [{
    summary: "stalled evidence",
    action_count: 1,
    changed_pixels: 1,
    state: {
      current_level: 1,
      levels_completed: 0,
      state: "NOT_FINISHED",
      total_steps: 1,
      current_attempt_steps: 1
    }
  }]
})));`, "utf8");
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
        id: "q_stalled_after_nudges",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "stalled_after_nudges",
        payload: {},
      },
      state,
    });
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "solver.stalled_after_nudges")).toBe(true);
    const persisted = await loadFluxState(workspaceRoot, config);
    expect(persisted?.active.solver.status).toBe("idle");
  });

  test("advancing to a new level does not mark the solver as solved", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_DELAY_MS = "100";
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const observeScript = path.join(workspaceRoot, "scripts", "observe.js");
    await fs.writeFile(observeScript, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const counterPath = path.join(input.workspaceRoot || process.cwd(), ".observe-level-counter");
  let count = 0;
  try {
    count = Number(fs.readFileSync(counterPath, "utf8")) || 0;
  } catch {}
  count += 1;
  fs.writeFileSync(counterPath, String(count), "utf8");
  const payloads = [
    { action_count: 1, changed_pixels: 1, state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", total_steps: 1, current_attempt_steps: 1, win_levels: 7 } },
    { action_count: 2, changed_pixels: 1, state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", total_steps: 2, current_attempt_steps: 2, win_levels: 7 } },
    { action_count: 2, changed_pixels: 0, state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", total_steps: 2, current_attempt_steps: 2, win_levels: 7 } },
  ];
  process.stdout.write(JSON.stringify({ evidence: [payloads[Math.min(count - 1, payloads.length - 1)]] }));
});`, "utf8");
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
    const runPromise = runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_level_transition",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "level_transition",
        payload: {},
      },
      state,
    });
    let sessionId = "";
    let sawLevel2Nudge = false;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !sawLevel2Nudge) {
      const latestState = await loadFluxState(workspaceRoot, config);
      sessionId = latestState?.active.solver.sessionId ?? sessionId;
      if (sessionId) {
        const messagesPath = path.join(workspaceRoot, ".ai-flux", "sessions", "solver", sessionId, "messages.jsonl");
        try {
          const messagesText = await fs.readFile(messagesPath, "utf8");
          sawLevel2Nudge =
            messagesText.includes("You are already at frontier level 2.") &&
            messagesText.includes("Your last turn did not produce new game progress from the current state.");
        } catch {}
      }
      if (!sawLevel2Nudge) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(sawLevel2Nudge).toBe(true);
    requestActiveSolverInterrupt(sessionId);
    await runPromise;
    const sessionPath = path.join(workspaceRoot, ".ai-flux", "sessions", "solver", sessionId, "session.json");
    const session = JSON.parse(await fs.readFile(sessionPath, "utf8"));
    expect(session.stopReason).not.toBe("solved");
    delete process.env.MOCK_PROVIDER_DELAY_MS;
  });

  test("an interrupted older solver does not clear a newer active solver slot", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_DELAY_MS = "200";
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const observeScript = path.join(workspaceRoot, "scripts", "observe.js");
    await fs.writeFile(observeScript, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  evidence: [{
    summary: "step evidence",
    action_count: 1,
    changed_pixels: 1,
    state: {
      current_level: 1,
      levels_completed: 0,
      state: "NOT_FINISHED",
      total_steps: 1,
      current_attempt_steps: 1
    }
  }]
})));`, "utf8");
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

    const firstRun = runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_old_solver",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "older_solver",
        payload: {},
      },
      state,
    });

    let firstSessionId = "";
    const firstDeadline = Date.now() + 2000;
    while (Date.now() < firstDeadline && !firstSessionId) {
      const latestState = await loadFluxState(workspaceRoot, config);
      firstSessionId = latestState?.active.solver.sessionId ?? "";
      if (!firstSessionId) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(firstSessionId).toBeTruthy();

    const secondRun = runSolverQueueItem({
      workspaceRoot,
      config,
      queueItem: {
        id: "q_new_solver",
        sessionType: "solver",
        createdAt: new Date().toISOString(),
        reason: "newer_solver",
        payload: {
          preplayedInstance: {
            instance_id: "seed_rev_test",
            working_directory: workspaceRoot,
            env: {},
            metadata: { solver_dir: workspaceRoot, state_dir: workspaceRoot },
          },
          preplayedReplayResult: {
            replay_ok: true,
            evidence: [{
              summary: "preplayed state",
              state: {
                current_level: 2,
                levels_completed: 1,
                state: "NOT_FINISHED",
                total_steps: 9,
                current_attempt_steps: 0,
              },
            }],
          },
        },
      },
      state,
    });

    let secondSessionId = "";
    const secondDeadline = Date.now() + 2000;
    while (Date.now() < secondDeadline && !secondSessionId) {
      const latestState = await loadFluxState(workspaceRoot, config);
      const activeSessionId = latestState?.active.solver.sessionId ?? "";
      if (activeSessionId && activeSessionId !== firstSessionId) {
        secondSessionId = activeSessionId;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(secondSessionId).toBeTruthy();

    requestActiveSolverInterrupt(firstSessionId);
    await firstRun;
    const afterFirstStop = await loadFluxState(workspaceRoot, config);
    expect(afterFirstStop?.active.solver.sessionId).toBe(secondSessionId);
    expect(afterFirstStop?.active.solver.status).toBe("running");

    requestActiveSolverInterrupt(secondSessionId);
    await secondRun;
    delete process.env.MOCK_PROVIDER_DELAY_MS;
  });
});
