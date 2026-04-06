import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { runModelerQueueItem } from "./modeler_runtime.js";
import { loadFluxQueue, saveFluxQueue } from "./queue.js";
import { loadFluxSession, saveFluxSession } from "./session_store.js";
import { saveFluxState } from "./state.js";
import type { FluxRunState, FluxSessionRecord } from "./types.js";

describe("modeler runtime", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-modeler-"));
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
    const noop = await writeScript("noop.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write("{}"));`);
    const sync = await writeScript("sync.js", `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const payload = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({ synced: true, reason: payload.reason || "" }));
});`);
    const acceptance = await writeScript("accept.js", `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({ accepted: true, message: input.modelOutput.summary || "" }));
});`);
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
    command: ["${noop}"]
  destroy_instance:
    command: ["${noop}"]
  observe_evidence:
    command: ["${noop}"]
  sync_model_workspace:
    command: ["${sync}"]
  rehearse_seed_on_model:
    command: ["${noop}"]
  replay_seed_on_real_game:
    command: ["${noop}"]
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
    command: ["${acceptance}"]
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

  test("skips the LLM turn when the current model already matches the latest evidence", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```json",
      JSON.stringify({
        decision: "updated_model",
        summary: "improved model",
        message_for_bootstrapper: "use this model",
        artifacts_updated: ["model.py"],
        evidence_watermark: "wm1",
      }, null, 2),
      "```",
    ].join("\n");
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
    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q1",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: {
          evidenceWatermark: "wm1",
          latestEvidence: {
            summary: "current_level=2",
            state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED" },
          },
        },
      },
    });
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
    expect(bootstrapQueue.items).toHaveLength(1);
    expect(bootstrapQueue.items[0]?.payload.sourceEvidenceWatermark).toBe("wm1");
    expect((bootstrapQueue.items[0]?.payload.sourceEvidence as Record<string, unknown>)?.summary).toBe("current_level=2");
    expect(events.some((event) => event.kind === "modeler.acceptance_passed")).toBe(true);
    expect(await fs.readdir(promptDir)).toHaveLength(0);
  });

  test("does not hot-loop blocked modeler turns", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "blocked",
      summary: "missing local evidence",
      message_for_bootstrapper: "",
      artifacts_updated: [],
      evidence_watermark: "wm2",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_blocked.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: input.modelOutput.summary || "blocked",
    model_output: input.modelOutput,
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q2",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm2" },
      },
    });
    const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(modelerQueue.items).toHaveLength(0);
    expect(events.some((event) => event.kind === "modeler.acceptance_failed" && event.payload?.blocked === true)).toBe(true);
  });

  test("publishes bootstrapper progress when contiguous matched prefix improves before full acceptance", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "matched one more sequence",
      message_for_bootstrapper: "sequence 1 now matches; prioritize the first failing sequence next",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm3",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_partial.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "seq_0002 still fails",
    model_output: input.modelOutput,
    compare_payload: {
      level: 1,
      all_match: false,
      reports: [
        { sequence_id: "seq_0001", matched: true },
        { sequence_id: "seq_0002", matched: false, divergence_reason: "intermediate_frame_mismatch" },
        { sequence_id: "seq_0003", matched: true }
      ]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q3",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm3" },
      },
    });
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(bootstrapQueue.items).toHaveLength(1);
    expect(bootstrapQueue.items[0]?.reason).toBe("model_progress_advanced");
    expect((bootstrapQueue.items[0]?.payload.modelProgress as Record<string, unknown>)?.contiguousMatchedSequences).toBe(1);
    expect(modelerQueue.items).toHaveLength(0);
    expect(events.some((event) => event.kind === "modeler.progress_advanced")).toBe(true);
  });

  test("recovers a reused modeler session when the persisted provider thread is stale", async () => {
    process.env.MOCK_PROVIDER_STREAMED_ERROR_IF_THREAD_ID_SET = "codex app-server exited (signal SIGTERM)\nstate db missing rollout path for thread stale_modeler";
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "recovered after stale thread",
      message_for_bootstrapper: "fresh thread recovery worked",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm-stale-thread",
    });
    try {
      const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
      const acceptancePath = path.join(workspaceRoot, "scripts", "accept_retry_thread.js");
      await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const preflight = input.modelOutput?.decision === "checked_current_model";
  process.stdout.write(JSON.stringify({
    accepted: !preflight,
    message: preflight ? "preflight mismatch" : (input.modelOutput?.summary || "accepted"),
    compare_payload: preflight ? { all_match: false, level: 1, reports: [] } : { all_match: true, level: 1, reports: [] }
  }));
});`, "utf8");
      await fs.chmod(acceptancePath, 0o755);
      const fluxPath = path.join(workspaceRoot, "flux.yaml");
      let fluxText = await fs.readFile(fluxPath, "utf8");
      fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
      const seededSession: FluxSessionRecord = {
        sessionId: "modeler_run",
        sessionType: "modeler",
        status: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provider: "mock",
        model: "mock-model",
        resumePolicy: "always",
        sessionScope: "run",
        providerThreadId: "stale_modeler_thread",
      };
      await saveFluxSession(workspaceRoot, refreshedConfig, seededSession);

      await runModelerQueueItem({
        workspaceRoot,
        config: refreshedConfig,
        state,
        queueItem: {
          id: "q_stale_1",
          sessionType: "modeler",
          createdAt: new Date().toISOString(),
          reason: "solver_new_evidence",
          payload: {
            evidenceWatermark: "wm-stale-thread",
            latestEvidence: {
              summary: "current_level=1 after more evidence",
              state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED" },
            },
          },
        },
      });

      const secondSession = await loadFluxSession(workspaceRoot, refreshedConfig, "modeler", "modeler_run");
      const events = await readFluxEvents(workspaceRoot, refreshedConfig);
      expect(secondSession?.status).toBe("idle");
      expect(secondSession?.stopReason).toBeUndefined();
      expect(secondSession?.providerThreadId).toMatch(/^mock_thread_/);
      expect(secondSession?.providerThreadId).not.toBe("stale_modeler_thread");
      expect(events.some((event) => event.kind === "modeler.acceptance_passed")).toBe(true);
      expect(events.some((event) => event.kind === "session.failed" && event.sessionType === "modeler")).toBe(false);
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_ERROR_IF_THREAD_ID_SET;
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  });

  test("publishes bootstrapper progress when the first failing step advances within the same sequence", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "same sequence fails later",
      message_for_bootstrapper: "earliest mismatch moved deeper in the same sequence",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_same_seq_1",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_same_sequence_progress.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const evidenceWatermark = String((input.modelOutput || {}).evidence_watermark || "");
  const divergenceStep = evidenceWatermark === "wm_same_seq_2" ? 14 : 6;
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "seq_0001 still fails later",
    model_output: input.modelOutput,
    compare_payload: {
      level: 2,
      all_match: false,
      reports: [
        { sequence_id: "seq_0001", matched: false, divergence_step: divergenceStep, divergence_reason: "intermediate_frame_mismatch" }
      ]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_same_1",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_same_seq_1" },
      },
    });
    let bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(1);
    await saveFluxQueue(workspaceRoot, config, { ...bootstrapQueue, items: [] });

    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "same sequence fails later",
      message_for_bootstrapper: "earliest mismatch moved deeper in the same sequence",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_same_seq_2",
    });

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_same_2",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_same_seq_2" },
      },
    });

    bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(bootstrapQueue.items).toHaveLength(1);
    expect(bootstrapQueue.items[0]?.reason).toBe("model_progress_advanced");
    expect((bootstrapQueue.items[0]?.payload.modelProgress as Record<string, unknown>)?.firstFailingSequenceId).toBe("seq_0001");
    expect((bootstrapQueue.items[0]?.payload.modelProgress as Record<string, unknown>)?.firstFailingStep).toBe(14);
    expect(events.some((event) =>
      event.kind === "modeler.progress_advanced"
      && (event.payload?.firstFailingStep as number | undefined) === 14
    )).toBe(true);
  });

  test("does not requeue modeler on infrastructure acceptance failures", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "no model change",
      message_for_bootstrapper: "",
      artifacts_updated: [],
      evidence_watermark: "wm4",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_infra.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "compare_sequences failed: shutil.Error ... No such file or directory",
    infrastructure_failure: {
      type: "sequence_surface_race",
      message: "compare_sequences failed: shutil.Error ... No such file or directory"
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q4",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm4" },
      },
    });
    const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(modelerQueue.items).toHaveLength(0);
    expect(events.some((event) =>
      event.kind === "modeler.acceptance_failed"
      && (event.payload?.infrastructureFailure as Record<string, unknown> | undefined)?.type === "sequence_surface_race"
    )).toBe(true);
  });

  test("does not self-requeue modeler after a normal acceptance failure", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "patch landed but compare still fails",
      message_for_bootstrapper: "",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_no_loop",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_not_yet.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "still failing at step 9",
    model_output: input.modelOutput,
    compare_payload: {
      level: 1,
      all_match: false,
      reports: [
        { sequence_id: "seq_0001", matched: false, divergence_step: 9, divergence_reason: "intermediate_frame_mismatch" }
      ]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_no_loop",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_no_loop" },
      },
    });
    const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(modelerQueue.items).toHaveLength(0);
    expect(events.some((event) => event.kind === "modeler.acceptance_failed")).toBe(true);
  });

  test("does not rerun bootstrapper for identical accepted frontier state", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```json",
      JSON.stringify({
        decision: "updated_model",
        summary: "same accepted frontier",
        message_for_bootstrapper: "same frontier",
        artifacts_updated: ["model.py"],
        evidence_watermark: "wm5",
      }, null, 2),
      "```",
    ].join("\n");
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

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q5a",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm5" },
      },
    });
    let bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(1);
    const seedMetaPath = path.join(workspaceRoot, "flux", "seed", "current_meta.json");
    const seedMeta = JSON.parse(await fs.readFile(seedMetaPath, "utf8"));
    expect(seedMeta.lastQueuedBootstrapModelRevisionId).toBeTruthy();
    await saveFluxQueue(workspaceRoot, config, { ...bootstrapQueue, items: [] });

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q5b",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm5b" },
      },
    });
    bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(0);
  });

  test("requeues bootstrapper when the same accepted model revision covers more frontier than the last bootstrapped seed", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```json",
      JSON.stringify({
        decision: "updated_model",
        summary: "same accepted model, broader frontier",
        message_for_bootstrapper: "seed can now carry the stronger frontier",
        artifacts_updated: [],
        evidence_watermark: "wm_same_revision_advance",
      }, null, 2),
      "```",
    ].join("\n");
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_same_revision_advance.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const evidenceWatermark = String((input.modelOutput || {}).evidence_watermark || "");
  const comparePayload = evidenceWatermark === "wm_same_revision_advance"
    ? {
        level: 2,
        all_match: true,
        reports: [
          { sequence_id: "seq_0001", matched: true },
          { sequence_id: "seq_0002", matched: true }
        ]
      }
    : {
        level: 1,
        all_match: true,
        reports: [{ sequence_id: "seq_0001", matched: true }]
      };
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted",
    model_output: input.modelOutput,
    compare_payload: comparePayload
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
    await fs.mkdir(path.join(workspaceRoot, "flux", "seed"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "seed", "current_meta.json"),
      JSON.stringify({
        lastBootstrapperModelRevisionId: "model_rev_same",
        lastBootstrapperCoverageSummary: {
          level: 1,
          allMatch: true,
          coveredSequenceIds: ["seq_0001"],
          contiguousMatchedSequences: 1,
          firstFailingSequenceId: null,
          firstFailingStep: null,
          firstFailingReason: null,
          frontierDiscovered: false,
          compareKind: "accepted",
        },
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_same"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_same", "summary.json"),
      JSON.stringify({
        level: 1,
        allMatch: true,
        coveredSequenceIds: ["seq_0001"],
        contiguousMatchedSequences: 1,
        firstFailingSequenceId: null,
        firstFailingStep: null,
        firstFailingReason: null,
        frontierDiscovered: false,
        compareKind: "accepted",
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "current"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "current", "meta.json"),
      JSON.stringify({ revisionId: "model_rev_same" }, null, 2),
      "utf8",
    );

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_same_revision_advance",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_same_revision_advance" },
      },
    });

    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(1);
    expect(bootstrapQueue.items[0]?.reason).toBe("model_accepted");
    expect(bootstrapQueue.items[0]?.payload.modelRevisionId).toBe("model_rev_same");
    expect((bootstrapQueue.items[0]?.payload.coverageSummary as Record<string, unknown>)?.contiguousMatchedSequences).toBe(2);
  });

  test("preserves the strongest accepted summary for a revision and can bootstrap from it after restart", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```json",
      JSON.stringify({
        decision: "updated_model",
        summary: "same revision after restart",
        message_for_bootstrapper: "reuse strongest known accepted frontier",
        artifacts_updated: [],
        evidence_watermark: "wm_restart_weaker",
      }, null, 2),
      "```",
    ].join("\n");
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_restart_weaker.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted",
    model_output: input.modelOutput,
    compare_payload: {
      level: 1,
      all_match: true,
      reports: [{ sequence_id: "seq_0001", matched: true }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
    await fs.mkdir(path.join(workspaceRoot, "flux", "seed"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "seed", "current_meta.json"),
      JSON.stringify({
        lastBootstrapperModelRevisionId: "model_rev_same",
        lastBootstrapperCoverageSummary: {
          level: 1,
          allMatch: true,
          coveredSequenceIds: ["seq_0001"],
          contiguousMatchedSequences: 1,
          firstFailingSequenceId: null,
          firstFailingStep: null,
          firstFailingReason: null,
          frontierDiscovered: false,
          compareKind: "accepted",
        },
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_same"), { recursive: true });
    const strongerSummary = {
      level: 2,
      allMatch: true,
      coveredSequenceIds: ["seq_0001", "seq_0002"],
      contiguousMatchedSequences: 2,
      firstFailingSequenceId: null,
      firstFailingStep: null,
      firstFailingReason: null,
      frontierDiscovered: false,
      compareKind: "accepted",
    };
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_same", "summary.json"),
      JSON.stringify(strongerSummary, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "current"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "current", "meta.json"),
      JSON.stringify({ revisionId: "model_rev_same", summary: strongerSummary }, null, 2),
      "utf8",
    );

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_restart_weaker",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_restart_weaker" },
      },
    });

    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(1);
    expect((bootstrapQueue.items[0]?.payload.coverageSummary as Record<string, unknown>)?.level).toBe(2);
    const summary = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_same", "summary.json"), "utf8"));
    expect(summary.level).toBe(2);
    expect(summary.contiguousMatchedSequences).toBe(2);
  });

  test("does not let a newly accepted revision regress the current accepted coverage summary", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```json",
      JSON.stringify({
        decision: "updated_model",
        summary: "accepted on a narrower latest slice",
        message_for_bootstrapper: "keep strongest known accepted coverage",
        artifacts_updated: [],
        evidence_watermark: "wm_new_weaker",
      }, null, 2),
      "```",
    ].join("\n");
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_new_weaker_revision.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const decision = String((input.modelOutput || {}).decision || "");
  if (decision === "checked_current_model") {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "need provider turn",
      model_output: input.modelOutput,
      compare_payload: {
        level: 1,
        all_match: false,
        reports: [{ sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "needs_update" }]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted",
    model_output: input.modelOutput,
    compare_payload: {
      level: 1,
      all_match: true,
      reports: [{ sequence_id: "seq_0001", matched: true }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
    const strongerSummary = {
      level: 2,
      frontierLevel: 2,
      allMatch: true,
      coveredSequenceIds: ["level_1:seq_0001", "level_1:seq_0002"],
      contiguousMatchedSequences: 2,
      firstFailingSequenceId: null,
      firstFailingStep: null,
      firstFailingReason: null,
      frontierDiscovered: false,
      compareKind: "accepted",
    };
    await fs.mkdir(path.join(workspaceRoot, "flux", "seed"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "seed", "current_meta.json"),
      JSON.stringify({
        lastQueuedBootstrapModelRevisionId: "model_rev_strong",
        lastQueuedBootstrapCoverageSummary: strongerSummary,
        lastBootstrapperModelRevisionId: "model_rev_strong",
        lastBootstrapperCoverageSummary: strongerSummary,
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_strong"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_strong", "summary.json"),
      JSON.stringify(strongerSummary, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "current"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "current", "meta.json"),
      JSON.stringify({ revisionId: "model_rev_strong", summary: strongerSummary }, null, 2),
      "utf8",
    );

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_new_weaker_revision",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_new_weaker" },
      },
    });

    const currentMeta = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "model", "current", "meta.json"), "utf8"));
    expect(currentMeta.revisionId).not.toBe("model_rev_strong");
    expect(currentMeta.summary.level).toBe(2);
    expect(currentMeta.summary.frontierLevel).toBe(2);
    expect(currentMeta.summary.coveredSequenceIds).toEqual(["level_1:seq_0001", "level_1:seq_0002"]);
    expect(currentMeta.summary.contiguousMatchedSequences).toBe(2);
  });

  test("prefers the already queued bootstrap model revision over an older successful baseline", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```json",
      JSON.stringify({
        decision: "updated_model",
        summary: "same accepted frontier again",
        message_for_bootstrapper: "same frontier",
        artifacts_updated: ["model.py"],
        evidence_watermark: "wm_same_again",
      }, null, 2),
      "```",
    ].join("\n");
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
    await fs.mkdir(path.join(workspaceRoot, "flux", "seed"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "seed", "current_meta.json"),
      JSON.stringify({
        lastBootstrapperModelRevisionId: "model_rev_old",
        lastQueuedBootstrapModelRevisionId: "model_rev_same",
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_old"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_old", "summary.json"),
      JSON.stringify({
        level: 1,
        allMatch: true,
        coveredSequenceIds: ["seq_0001"],
        contiguousMatchedSequences: 1,
        firstFailingSequenceId: null,
        firstFailingStep: null,
        firstFailingReason: null,
        frontierDiscovered: false,
        compareKind: "accepted",
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_same"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_same", "summary.json"),
      JSON.stringify({
        level: 1,
        allMatch: true,
        coveredSequenceIds: ["seq_0001"],
        contiguousMatchedSequences: 1,
        firstFailingSequenceId: null,
        firstFailingStep: null,
        firstFailingReason: null,
        frontierDiscovered: false,
        compareKind: "accepted",
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "current"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "current", "meta.json"),
      JSON.stringify({ revisionId: "model_rev_same" }, null, 2),
      "utf8",
    );

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_same_model",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_same_again" },
      },
    });
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(0);
  });
});
