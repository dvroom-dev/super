import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { runModelerQueueItem } from "./modeler_runtime.js";
import { runBootstrapperQueueItem } from "./bootstrapper_runtime.js";
import { loadFluxQueue, saveFluxQueue } from "./queue.js";
import { loadFluxSession } from "./session_store.js";
import { saveFluxState } from "./state.js";
import { requestActiveSolverInterrupt, runSolverQueueItem } from "./solver_runtime.js";
import type { FluxRunState } from "./types.js";

describe("flux mocked flow", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-flow-e2e-"));
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
    metadata: {
      state_dir: input.workspaceRoot,
      solver_dir: input.workspaceRoot
    }
  }));
});`);
    const destroy = await writeScript("destroy.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write("{}"));`);
    const observe = await writeScript("observe.js", `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const instance = input.instance || {};
  const instanceId = String(instance.instance_id || "instance_1");
  const preplayed = instanceId.startsWith("seed_rev_");
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: preplayed ? "preplayed frontier" : "solver evidence",
      action_count: preplayed ? 17 : 1,
      changed_pixels: 1,
      state: {
        current_level: preplayed ? 2 : 1,
        levels_completed: preplayed ? 1 : 0,
        win_levels: 7,
        state: "NOT_FINISHED",
        total_steps: preplayed ? 17 : 1,
        current_attempt_steps: preplayed ? 0 : 1,
        last_action_name: "ACTION1"
      }
    }]
  }));
});`);
    const rehearse = await writeScript("rehearse.js", `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  status_after: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  compare_payload: {
    ok: true,
    action: "compare_sequences",
    level: 1,
    all_match: true,
    compared_sequences: 1,
    diverged_sequences: 0,
    reports: [{ sequence_id: "seq_0001", matched: true, report_file: "level_1/report.md" }]
  },
  tool_results: []
})));`);
    const replay = await writeScript("replay.js", `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    replay_ok: true,
    tool_results: [],
    evidence: [{
      summary: "preplayed frontier",
      state: {
        current_level: 2,
        levels_completed: 1,
        win_levels: 7,
        state: "NOT_FINISHED",
        total_steps: 17,
        current_attempt_steps: 0,
        last_action_name: "ACTION1"
      }
    }],
    instance: input.instance || {}
  }));
});`);
    const acceptance = await writeScript("accept.js", `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: input.modelOutput?.summary || "accepted",
    compare_payload: {
      level: 1,
      all_match: true,
      compared_sequences: 1,
      diverged_sequences: 0,
      reports: [{ sequence_id: "seq_0001", matched: true }]
    },
    model_output: input.modelOutput || {}
  }));
});`);
    await fs.mkdir(path.join(workspaceRoot, "flux", "seed"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "current.json"), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      syntheticMessages: [{ role: "assistant", text: "Seed knowledge" }],
      replayPlan: [],
      assertions: ["best known seed"],
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

  test("chains mocked modeler, bootstrapper, and replacement solver end-to-end", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "MODELER_PROMPT",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "model updated",
          message_for_bootstrapper: "use the seed",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_e2e",
        }),
      },
      {
        contains: "BOOTSTRAP_PROMPT",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "seed is ready",
          seed_bundle_updated: false,
          notes: "finalize best known seed",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "level_completion_advanced",
        }),
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "50";
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

      await runModelerQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_model",
          sessionType: "modeler",
          createdAt: new Date().toISOString(),
          reason: "solver_new_evidence",
          payload: {
            evidenceWatermark: "wm_e2e",
            latestEvidence: {
              summary: "current_level=1",
              state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
            },
          },
        },
      });

      const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items.length).toBeGreaterThan(0);

      await runBootstrapperQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: bootstrapQueue.items[bootstrapQueue.items.length - 1]!,
      });

      const bootstrapRetryQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapRetryQueue.items.length).toBeGreaterThan(0);

      await runBootstrapperQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: bootstrapRetryQueue.items[bootstrapRetryQueue.items.length - 1]!,
      });

      const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
      expect(solverQueue.items).toHaveLength(1);

      const runPromise = runSolverQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: solverQueue.items[0]!,
      });

      const solverDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
      let solverSessions: string[] = [];
      const sessionDeadline = Date.now() + 2000;
      while (Date.now() < sessionDeadline && solverSessions.length === 0) {
        try {
          solverSessions = (await fs.readdir(solverDir))
            .filter((name) => name.startsWith("solver_attempt_"))
            .sort();
        } catch {
          solverSessions = [];
        }
        if (solverSessions.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(solverSessions).toHaveLength(1);
      const sessionId = solverSessions[0]!;
      const messagesPath = path.join(workspaceRoot, ".ai-flux", "sessions", "solver", sessionId, "messages.jsonl");
      let messages = "";
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          messages = await fs.readFile(messagesPath, "utf8");
        } catch {
          messages = "";
        }
        if (messages.includes("Seed preplay already ran on this instance.")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(messages).toContain("Seed preplay already ran on this instance.");
      expect(messages).toContain("Current live state after preplay: level 2");
      expect(messages).toContain("Seed knowledge");
      requestActiveSolverInterrupt(sessionId);
      await runPromise;

      const bootstrapSession = await loadFluxSession(workspaceRoot, config, "bootstrapper", "bootstrapper_run");
      expect(bootstrapSession?.status).toBe("idle");
      expect(bootstrapSession?.stopReason).toBeUndefined();
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  }, 15000);

  test("treats deeper divergence in the same sequence as progress and avoids modeler self-loops", async () => {
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "MODELER_PROMPT",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "same first failing sequence now fails later",
          message_for_bootstrapper: "frontier moved deeper in the same ordered sequence",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_same_seq_1",
        }),
      },
      {
        contains: "BOOTSTRAP_PROMPT",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "seed is ready",
          seed_bundle_updated: false,
          notes: "finalize best known seed",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "level_completion_advanced",
        }),
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "10";

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_same_sequence_progress.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const modelOutput = input.modelOutput || {};
  const decision = String(modelOutput.decision || "");
  const evidenceWatermark = String(modelOutput.evidence_watermark || "");
  if (decision === "checked_current_model") {
    const step = evidenceWatermark === "wm_same_seq_2" ? 14 : 8;
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "current model still fails in the same sequence",
      model_output: modelOutput,
      compare_payload: {
        level: 2,
        all_match: false,
        reports: [
          { sequence_id: "seq_0001", matched: false, divergence_step: step, divergence_reason: "intermediate_frame_mismatch" }
        ]
      }
    }));
    return;
  }
  const step = evidenceWatermark === "wm_same_seq_2" ? 14 : 8;
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "same sequence now fails later",
    model_output: modelOutput,
    compare_payload: {
      level: 2,
      all_match: false,
      reports: [
        { sequence_id: "seq_0001", matched: false, divergence_step: step, divergence_reason: "intermediate_frame_mismatch" }
      ]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);

    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    const fluxText = (await fs.readFile(fluxPath, "utf8")).replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
        id: "q_model_same_1",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_same_seq_1",
          latestEvidence: {
            summary: "current_level=2",
            state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", win_levels: 7 },
          },
        },
      },
    });

    let bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    let modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    let events = await readFluxEvents(workspaceRoot, config);
    let modelerMessages = await fs.readFile(path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "messages.jsonl"), "utf8");
    expect(bootstrapQueue.items).toHaveLength(1);
    expect(modelerQueue.items).toHaveLength(0);
    expect(modelerMessages.includes("acceptance_failed_resume")).toBe(false);
    expect(events.some((event) =>
      event.kind === "modeler.progress_advanced"
      && event.payload?.firstFailingSequenceId === "seq_0001"
      && event.payload?.firstFailingStep === 8
    )).toBe(true);

    await saveFluxQueue(workspaceRoot, config, { ...bootstrapQueue, items: [] });
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "MODELER_PROMPT",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "same first failing sequence now fails even later",
          message_for_bootstrapper: "frontier moved deeper again in the same ordered sequence",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_same_seq_2",
        }),
      },
      {
        contains: "BOOTSTRAP_PROMPT",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "seed is ready",
          seed_bundle_updated: false,
          notes: "finalize best known seed",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "level_completion_advanced",
        }),
      },
    ]);

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_model_same_2",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_same_seq_2",
          latestEvidence: {
            summary: "current_level=2",
            state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", win_levels: 7 },
          },
        },
      },
    });

    bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    events = await readFluxEvents(workspaceRoot, config);
    modelerMessages = await fs.readFile(path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "messages.jsonl"), "utf8");
    expect(bootstrapQueue.items).toHaveLength(1);
    expect(modelerQueue.items).toHaveLength(0);
    expect(modelerMessages.includes("acceptance_failed_resume")).toBe(false);
    expect(events.some((event) =>
      event.kind === "modeler.progress_advanced"
      && event.payload?.firstFailingSequenceId === "seq_0001"
      && event.payload?.firstFailingStep === 14
    )).toBe(true);

    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: bootstrapQueue.items[0]!,
    });

    const bootstrapRetryQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapRetryQueue.items).toHaveLength(1);

    await runBootstrapperQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: bootstrapRetryQueue.items[0]!,
    });

    const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
    expect(solverQueue.items).toHaveLength(1);

    const runPromise = runSolverQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: solverQueue.items[0]!,
    });
    const solverDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
    const deadline = Date.now() + 2000;
    let solverSessions: string[] = [];
    while (Date.now() < deadline && solverSessions.length === 0) {
      try {
        solverSessions = (await fs.readdir(solverDir)).filter((name) => name.startsWith("solver_attempt_")).sort();
      } catch {
        solverSessions = [];
      }
      if (solverSessions.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(solverSessions).toHaveLength(1);
    requestActiveSolverInterrupt(solverSessions[0]!);
    await runPromise;

    const solverMessages = await fs.readFile(path.join(workspaceRoot, ".ai-flux", "sessions", "solver", solverSessions[0]!, "messages.jsonl"), "utf8");
    expect(solverMessages).toContain("Seed preplay already ran on this instance.");
    expect(solverMessages).toContain("Current live state after preplay: level 2");
  }, 15000);

  test("chains solver to modeler to bootstrapper across multiple solved levels and queues a frontier seed", async () => {
    const observePath = path.join(workspaceRoot, "scripts", "observe_multilevel.js");
    await fs.writeFile(observePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const instance = input.instance || {};
  const instanceId = String(instance.instance_id || "instance_1");
  const preplayed = instanceId.startsWith("seed_rev_");
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: preplayed ? "frontier solver resumed at level 3" : "solver reached level 3",
      action_count: preplayed ? 65 : 45,
      changed_pixels: 1,
      state: {
        current_level: 3,
        levels_completed: 2,
        win_levels: 7,
        state: "NOT_FINISHED",
        total_steps: preplayed ? 65 : 45,
        current_attempt_steps: preplayed ? 12 : 45,
        last_action_name: "ACTION4"
      }
    }],
    evidence_bundle_id: preplayed ? "bundle_preplayed_l3" : "bundle_live_l3",
    evidence_bundle_path: preplayed ? "/tmp/bundle_preplayed_l3" : "/tmp/bundle_live_l3"
  }));
});`, "utf8");
    await fs.chmod(observePath, 0o755);

    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_multilevel.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  status_after: { current_level: 3, levels_completed: 2, state: "NOT_FINISHED", win_levels: 7 },
  compare_payload: {
    ok: true,
    action: "compare_sequences",
    level: 3,
    frontier_level: 3,
    all_match: true,
    compared_sequences: 3,
    eligible_sequences: 3,
    diverged_sequences: 0,
    covered_sequence_ids: ["level_1:seq_0001", "level_2:seq_0001", "level_3:seq_0001"],
    reports: [
      { level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true, report_file: "level_1/report.md" },
      { level: 2, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 3, sequence_completed_level: true, report_file: "level_2/report.md" },
      { level: 3, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 3, sequence_completed_level: false, report_file: "level_3/report.md" }
    ]
  },
  tool_results: []
})));`, "utf8");
    await fs.chmod(rehearsePath, 0o755);

    const replayPath = path.join(workspaceRoot, "scripts", "replay_multilevel.js");
    await fs.writeFile(replayPath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    replay_ok: true,
    tool_results: [],
    evidence: [{
      summary: "seed replay reaches level 3",
      state: {
        current_level: 3,
        levels_completed: 2,
        win_levels: 7,
        state: "NOT_FINISHED",
        total_steps: 65,
        current_attempt_steps: 0,
        last_action_name: "ACTION4"
      }
    }],
    instance: input.instance || {}
  }));
});`, "utf8");
    await fs.chmod(replayPath, 0o755);

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_multilevel.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const modelOutput = input.modelOutput || {};
  const decision = String(modelOutput.decision || "");
  if (decision === "checked_current_model") {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "current model still behind frontier",
      model_output: modelOutput,
      compare_payload: {
        level: 1,
        all_match: false,
        reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 2, divergence_reason: "intermediate_frame_mismatch" }]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: modelOutput.summary || "accepted",
    model_output: modelOutput,
    compare_payload: {
      level: 3,
      frontier_level: 3,
      all_match: true,
      compared_sequences: 3,
      eligible_sequences: 3,
      diverged_sequences: 0,
      covered_sequence_ids: ["level_1:seq_0001", "level_2:seq_0001", "level_3:seq_0001"],
      reports: [
        { level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true },
        { level: 2, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 3, sequence_completed_level: true },
        { level: 3, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 3, sequence_completed_level: false }
      ]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);

    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/observe_evidence:\n    command: \["[^"]*"\]/, `observe_evidence:\n    command: ["${observePath}"]`)
      .replace(/rehearse_seed_on_model:\n    command: \["[^"]*"\]/, `rehearse_seed_on_model:\n    command: ["${rehearsePath}"]`)
      .replace(/replay_seed_on_real_game:\n    command: \["[^"]*"\]/, `replay_seed_on_real_game:\n    command: ["${replayPath}"]`)
      .replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");

    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "MODELER_PROMPT",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "model now covers solved levels through frontier 3",
          message_for_bootstrapper: "levels 1 and 2 are solved; frontier is level 3",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_multilevel",
        }),
      },
      {
        contains: "BOOTSTRAP_PROMPT",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "seed now explains solved levels and level 3 frontier",
          seed_bundle_updated: true,
          notes: "write multi-level seed",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "level_completion_advanced",
        }),
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "50";

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

      const initialSolverPromise = runSolverQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_solver_multilevel",
          sessionType: "solver",
          createdAt: new Date().toISOString(),
          reason: "initial_solver_attempt",
          payload: {},
        },
      });

      let modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
      const queueDeadline = Date.now() + 2000;
      while (Date.now() < queueDeadline && modelerQueue.items.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
      }
      expect(modelerQueue.items.length).toBeGreaterThan(0);

      const solverSessionsDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
      let solverSessions: string[] = [];
      while (Date.now() < queueDeadline && solverSessions.length === 0) {
        try {
          solverSessions = (await fs.readdir(solverSessionsDir)).filter((name) => name.startsWith("solver_attempt_")).sort();
        } catch {
          solverSessions = [];
        }
        if (solverSessions.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(solverSessions).toHaveLength(1);
      requestActiveSolverInterrupt(solverSessions[0]!);
      await initialSolverPromise;

      await runModelerQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: modelerQueue.items[modelerQueue.items.length - 1]!,
      });

      let bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items).toHaveLength(1);
      expect((bootstrapQueue.items[0]?.payload.coverageSummary as Record<string, unknown>)?.frontierLevel).toBe(3);

      await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "candidate.json"), JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        syntheticMessages: [
          { role: "assistant", text: "Solved level 1 route is preserved from the run start." },
          { role: "assistant", text: "Solved level 2 route is preserved and the frontier is now level 3." },
          { role: "assistant", text: "Level 3 frontier branch should continue from the preplayed frontier state." },
        ],
        replayPlan: [
          { tool: "shell", args: { cmd: ["arc_action", "ACTION1"] } },
          { tool: "shell", args: { cmd: ["arc_action", "ACTION4"] } },
        ],
        assertions: ["levels 1 and 2 solved before the level 3 frontier"],
      }, null, 2), "utf8");

      await runBootstrapperQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: bootstrapQueue.items[0]!,
      });

      const solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
      expect(solverQueue.items).toHaveLength(1);
      expect(typeof (solverQueue.items[0]?.payload.preplayedInstance as Record<string, unknown> | undefined)?.instance_id).toBe("string");
      expect((solverQueue.items[0]?.payload.preplayedReplayResult as Record<string, unknown> | undefined)?.replay_ok).toBe(true);
      const currentSeed = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "seed", "current.json"), "utf8"));
      expect(currentSeed.syntheticMessages.some((msg: Record<string, unknown>) => String(msg.text ?? "").includes("Solved level 2 route"))).toBe(true);

      const replacementSolverPromise = runSolverQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: solverQueue.items[0]!,
      });

      let replacementSessions: string[] = [];
      const replacementDeadline = Date.now() + 2000;
      while (Date.now() < replacementDeadline && replacementSessions.length < 2) {
        try {
          replacementSessions = (await fs.readdir(solverSessionsDir)).filter((name) => name.startsWith("solver_attempt_")).sort();
        } catch {
          replacementSessions = [];
        }
        if (replacementSessions.length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(replacementSessions.length).toBeGreaterThanOrEqual(2);
      const replacementSessionId = replacementSessions.find((sessionId) => !solverSessions.includes(sessionId));
      expect(replacementSessionId).toBeTruthy();
      if (!replacementSessionId) {
        throw new Error("replacement solver session not found");
      }
      const messagesPath = path.join(workspaceRoot, ".ai-flux", "sessions", "solver", replacementSessionId, "messages.jsonl");
      let messages = "";
      while (Date.now() < replacementDeadline) {
        try {
          messages = await fs.readFile(messagesPath, "utf8");
        } catch {
          messages = "";
        }
        if (messages.includes("Current live state after preplay: level 3")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(messages).toContain("Seed preplay already ran on this instance.");
      expect(messages).toContain("Current live state after preplay: level 3");
      requestActiveSolverInterrupt(replacementSessionId);
      await replacementSolverPromise;
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  }, 20000);
});
