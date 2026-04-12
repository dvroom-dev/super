import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "../utils/hash.js";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { currentSeedHasModelRehearsal, expectedFrontierLevelFromPromptPayload, runBootstrapperQueueItem } from "./bootstrapper_runtime.js";
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
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  tool_results: [{ tool: "model", ok: true }],
  status_after: { current_level: 2 },
  compare_payload: { level: 2, frontier_level: 2, all_match: true, compared_sequences: 1, eligible_sequences: 1 }
})));`);
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

  test("auto-accepts a changed seed after rehearsal reaches the model frontier and queues solver immediately", async () => {
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
    expect(solverQueue.items).toHaveLength(1);
    expect(solverQueue.items[0]?.payload.seedBundle).toBeTruthy();
    expect(bootstrapQueue.items).toHaveLength(0);
    expect(events.some((event) => event.kind === "bootstrapper.model_rehearsal_passed")).toBe(true);
    const finalEvents = await readFluxEvents(workspaceRoot, config);
    expect(finalEvents.some((event) => event.kind === "bootstrapper.auto_accepted_after_rehearsal")).toBe(true);
    expect(finalEvents.some((event) => event.kind === "bootstrapper.real_replay_passed")).toBe(true);
    expect(finalEvents.some((event) => event.kind === "bootstrapper.attested_satisfactory")).toBe(true);
  });

  test("points bootstrapper at accepted modeler handoff files", async () => {
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
    await fs.mkdir(path.join(workspaceRoot, "modeler_handoff"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "modeler_handoff", "untrusted_theories_level_1.md"),
      "# Level 1\nValidated mechanic notes.\n",
      "utf8",
    );
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Modeler handoff files to read before finalizing mechanics:",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "read handoff",
          seed_bundle_updated: false,
          notes: "use the accepted mechanics",
          solver_action: "no_action",
          seed_delta_kind: "mechanic_explanation_improved",
        }),
      },
    ]);
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_boot_handoff",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "model_accepted",
        payload: {
          baselineModelRevisionId: "model_rev_x",
          coverageSummary: {
            level: 1,
            frontierLevel: 2,
            allMatch: true,
            coveredSequenceIds: ["level_1:seq_0001"],
            contiguousMatchedSequences: 1,
            firstFailingSequenceId: null,
            firstFailingStep: null,
            firstFailingReason: null,
            frontierDiscovered: false,
            compareKind: "accepted",
          },
        },
      },
    });
    const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "bootstrapper", "bootstrapper_run", "prompts");
    const promptFiles = (await fs.readdir(promptDir)).sort();
    const promptPayload = JSON.parse(await fs.readFile(path.join(promptDir, promptFiles[0]!), "utf8"));
    const promptText = String(promptPayload.promptText ?? "");
    expect(promptText).toContain("Modeler handoff files to read before finalizing mechanics:");
    expect(promptText).toContain("modeler_handoff/untrusted_theories_level_1.md");
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
    expect(solverQueue.items).toHaveLength(1);
    const firstSeedMeta = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "seed", "current_meta.json"), "utf8"));
    const firstRevisionId = String(firstSeedMeta.revisionId);
    solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    await saveFluxQueue(workspaceRoot, config, { ...solverQueue, items: [] });
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: { ...queueItem, id: "q_boot_same_2" },
    });
    solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    expect(solverQueue.items).toHaveLength(0);
    const secondSeedMeta = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "seed", "current_meta.json"), "utf8"));
    expect(String(secondSeedMeta.revisionId)).toBe(firstRevisionId);
    const revisionFiles = await fs.readdir(path.join(workspaceRoot, "flux", "seed", "revisions"));
    expect(revisionFiles.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "bootstrapper.reuse_accepted" && event.payload?.changed === false)).toBe(true);
  });

  test("queues a solver for an unchanged seed when accepted model coverage improved", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "finalize_seed",
      summary: "same seed, stronger model",
      seed_bundle_updated: false,
      notes: "reuse seed with stronger accepted coverage",
      solver_action: "queue_and_interrupt",
      seed_delta_kind: "level_completion_advanced",
    });
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const rehearseBetterPath = path.join(workspaceRoot, "scripts", "rehearse_better_model.js");
    await fs.writeFile(rehearseBetterPath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  tool_results: [{ tool: "model", ok: true }],
  status_after: { current_level: 3 },
  compare_payload: { level: 3, frontier_level: 3, all_match: true, compared_sequences: 1, eligible_sequences: 1 }
})));`, "utf8");
    await fs.chmod(rehearseBetterPath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/rehearse_seed_on_model:\n\s+command: \["[^"]*rehearse\.js"\]/, `rehearse_seed_on_model:\n    command: ["${rehearseBetterPath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");
    const refreshedConfig = await loadFluxConfig(workspaceRoot, "flux.yaml");
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
    await saveFluxState(workspaceRoot, refreshedConfig, state);
    await runBootstrapperQueueItem({
      workspaceRoot,
      config: refreshedConfig,
      state,
      queueItem: {
        id: "q_boot_same_seed_better_model",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "model_accepted",
        payload: {
          modelRevisionId: "model_rev_new",
          coverageSummary: {
            level: 2,
            frontierLevel: 3,
            allMatch: true,
            coveredSequenceIds: ["level_1:seq_0001", "level_2:seq_0001"],
            contiguousMatchedSequences: 1,
            firstFailingSequenceId: null,
            firstFailingStep: null,
            firstFailingReason: null,
            frontierDiscovered: false,
            compareKind: "accepted",
          },
        },
      },
    });
    const solverQueue = await loadFluxQueue(workspaceRoot, refreshedConfig, "solver");
    expect(solverQueue.items).toHaveLength(1);
    expect(solverQueue.items[0]?.payload.seedRevisionId).toBeTruthy();
  });

  test("does not auto-accept a seed when rehearsal compare still fails on the prefix", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "continue_refining",
      summary: "candidate needs more work",
      seed_bundle_updated: true,
      notes: "not ready",
      solver_action: "queue_and_interrupt",
      seed_delta_kind: "mechanic_explanation_added",
    });
    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_fail_compare.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  tool_results: [{ tool: "model", ok: true }],
  status_after: { current_level: 1 },
  compare_payload: { level: 1, frontier_level: 1, all_match: false, compared_sequences: 1, eligible_sequences: 1 }
})));`, "utf8");
    await fs.chmod(rehearsePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/rehearse_seed_on_model:\n    command: \["[^"]*"\]/, `rehearse_seed_on_model:\n    command: ["${rehearsePath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");

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
    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_boot_fail_compare",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "model_accepted",
        payload: {
          messageForBootstrapper: "use model",
          coverageSummary: { level: 1, frontierLevel: 1, coveredSequenceIds: ["level_1:seq_0001"] },
        },
      },
    });
    const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(solverQueue.items).toHaveLength(0);
    expect(bootstrapQueue.items).toHaveLength(1);
    expect(bootstrapQueue.items[0]?.reason).toBe("bootstrapper_retry_after_model_rehearsal");
    expect(events.some((event) => event.kind === "bootstrapper.auto_accepted_after_rehearsal")).toBe(false);
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
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "candidate.json"), JSON.stringify({
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
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "candidate.json"), JSON.stringify({
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

  test("queues a continuation instead of hard-failing when the candidate seed is invalid", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "finalize_seed",
      summary: "keep going",
      seed_bundle_updated: false,
      notes: "repair seed",
      solver_action: "no_action",
      seed_delta_kind: "no_useful_change",
    });
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const currentSeedPath = path.join(workspaceRoot, "flux", "seed", "current.json");
    await fs.writeFile(currentSeedPath, JSON.stringify({
      version: 1,
      generatedAt: "2026-04-05T19:23:19.835Z",
      syntheticMessages: [{ role: "assistant", text: "Do A" }],
      replayPlan: [{ tool: "shell", args: { cmd: ["arc_action", "ACTION1"] } }],
      assertions: [],
    }, null, 2), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "candidate.json"), JSON.stringify({
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
    const currentSeed = JSON.parse(await fs.readFile(currentSeedPath, "utf8"));
    expect(currentSeed.replayPlan[0]?.args?.cmd).toEqual(["arc_action", "ACTION1"]);
  });

  test("queues a continuation when the candidate seed file contains malformed JSON", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "finalize_seed",
      summary: "repair malformed seed",
      seed_bundle_updated: true,
      notes: "repair malformed seed json",
      solver_action: "no_action",
      seed_delta_kind: "no_useful_change",
    });
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    const currentSeedPath = path.join(workspaceRoot, "flux", "seed", "current.json");
    await fs.writeFile(currentSeedPath, JSON.stringify({
      version: 1,
      generatedAt: "2026-04-05T19:23:19.835Z",
      syntheticMessages: [{ role: "assistant", text: "Do A" }],
      replayPlan: [{ tool: "shell", args: { cmd: ["arc_action", "ACTION1"] } }],
      assertions: [],
    }, null, 2), "utf8");
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "seed", "candidate.json"),
      `{
  "version": 1,
  "generatedAt": "2026-04-10T03:11:39Z",
  "syntheticMessages": [],
  "replayPlan": [
    {
      "tool": "shell",
      "args": { "cmd": ["arc_action", "ACTION1"] }
    },
  ],
  "assertions": []
}
`,
      "utf8",
    );
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
        id: "q_boot_invalid_json_seed",
        sessionType: "bootstrapper",
        createdAt: new Date().toISOString(),
        reason: "bootstrapper_invalid_seed",
        payload: { validationError: "JSON Parse error: Unexpected comma at the end of array expression" },
      },
    });
    const queue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    const session = await loadFluxSession(workspaceRoot, config, "bootstrapper", "bootstrapper_run");
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.reason).toBe("bootstrapper_invalid_seed");
    expect(String(queue.items[0]?.payload.validationError || "")).toContain("Unexpected comma at the end of array expression");
    expect(events.some((event) =>
      event.kind === "bootstrapper.seed_invalid"
      && String(event.summary).includes("Unexpected comma at the end of array expression")
    )).toBe(true);
    expect(events.some((event) => event.kind === "session.failed" && event.sessionType === "bootstrapper")).toBe(false);
    expect(session?.status).toBe("idle");
    const currentSeed = JSON.parse(await fs.readFile(currentSeedPath, "utf8"));
    expect(currentSeed.replayPlan[0]?.args?.cmd).toEqual(["arc_action", "ACTION1"]);
  });

  test("does not treat a stored rehearsal with compare failures as satisfactory", async () => {
    const currentSeed = {
      version: 1,
      generatedAt: new Date().toISOString(),
      syntheticMessages: [{ role: "assistant", text: "Do A" }],
      replayPlan: [{ tool: "shell", args: { cmd: ["arc_action", "ACTION1"] } }],
      assertions: [],
    };
    const seedHash = sha256Hex(JSON.stringify(currentSeed));
    expect(currentSeedHasModelRehearsal({
      lastModelRehearsalSeedHash: seedHash,
      lastModelRehearsalSucceeded: true,
      lastModelRehearsalResult: {
        rehearsal_ok: true,
        status_after: { current_level: 2 },
        compare_payload: {
          level: 2,
          frontier_level: 2,
          all_match: false,
          compared_sequences: 6,
          eligible_sequences: 6,
        },
      },
    }, seedHash, 2)).toBe(false);
  });

  test("does not treat a stored rehearsal with compare errors as satisfactory", async () => {
    const currentSeed = {
      version: 1,
      generatedAt: new Date().toISOString(),
      syntheticMessages: [{ role: "assistant", text: "Do A" }],
      replayPlan: [{ tool: "shell", args: { cmd: ["arc_action", "ACTION1"] } }],
      assertions: [],
    };
    const seedHash = sha256Hex(JSON.stringify(currentSeed));
    expect(currentSeedHasModelRehearsal({
      lastModelRehearsalSeedHash: seedHash,
      lastModelRehearsalSucceeded: true,
      lastModelRehearsalResult: {
        rehearsal_ok: true,
        status_after: { current_level: 2 },
        compare_payload: {
          ok: false,
          action: "compare_sequences",
          error: {
            type: "missing_sequences",
            message: "missing sequences dir: /tmp/rehearsal/level_2/sequences",
          },
        },
      },
    }, seedHash, 2)).toBe(false);
  });

  test("caps expected frontier to one level beyond accepted coverage", async () => {
    const expected = expectedFrontierLevelFromPromptPayload({
      coverageSummary: {
        level: 1,
        frontierLevel: 3,
        allMatch: true,
        coveredSequenceIds: ["level_1:seq_0001"],
        contiguousMatchedSequences: 1,
        firstFailingSequenceId: null,
        firstFailingStep: null,
        firstFailingReason: null,
        frontierDiscovered: false,
        compareKind: "accepted",
      },
    });
    expect(expected).toBe(2);
  });
});
