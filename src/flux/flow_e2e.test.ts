import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { requestActiveModelerInterrupt, runModelerQueueItem } from "./modeler_runtime.js";
import { runBootstrapperQueueItem } from "./bootstrapper_runtime.js";
import { loadFluxQueue, saveFluxQueue } from "./queue.js";
import { loadFluxSession } from "./session_store.js";
import { requestFluxStop, runFluxOrchestrator } from "./orchestrator.js";
import { loadFluxState, saveFluxState } from "./state.js";
import { requestActiveSolverInterrupt, runSolverQueueItem } from "./solver_runtime.js";
import type { FluxRunState } from "./types.js";

describe("flux mocked flow", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-flow-e2e-"));
    await fs.mkdir(path.join(workspaceRoot, "model_workspace"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "prompts"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "prompts", "solver.md"), "SOLVER_PROMPT", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler.md"), "MODELER_PROMPT", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler_boxes.md"), "MODELER_BOXES_PROMPT", "utf8");
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
  const path = require("node:path");
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
      frontier_level: 2,
      all_match: true,
      compared_sequences: 1,
      diverged_sequences: 0,
      reports: [{ level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }]
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
  working_directory: model_workspace
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
    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_level1_complete.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  status_after: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", win_levels: 7 },
  compare_payload: {
    ok: true,
    action: "compare_sequences",
    level: 2,
    frontier_level: 2,
    all_match: true,
    compared_sequences: 1,
    eligible_sequences: 1,
    diverged_sequences: 0,
    reports: [{ level: 2, sequence_id: "seq_0001", matched: true, report_file: "level_2/report.md" }]
  },
  tool_results: []
})));`, "utf8");
    await fs.chmod(rehearsePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/rehearse_seed_on_model:\n    command: \["[^"]*"\]/, `rehearse_seed_on_model:\n    command: ["${rehearsePath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");

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
      const promptsDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver", sessionId, "prompts");
      let messages = "";
      let promptText = "";
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          messages = await fs.readFile(messagesPath, "utf8");
        } catch {
          messages = "";
        }
        try {
          const promptFiles = (await fs.readdir(promptsDir)).sort();
          if (promptFiles[0]) {
            const promptPayload = JSON.parse(await fs.readFile(path.join(promptsDir, promptFiles[0]!), "utf8"));
            promptText = String(promptPayload.promptText ?? "");
          }
        } catch {
          promptText = "";
        }
        if (messages.includes("Seed preplay already ran on this instance.")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(messages).toContain("Seed preplay already ran on this instance.");
      expect(messages).toContain("Current live state after preplay: level 2");
      expect(messages).toContain("Seed knowledge");
      expect(promptText).toContain("Seed knowledge");
      expect(promptText).toContain("Synthetic transcript to inherit:");
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

  test.skip("does not self-loop modeler on deeper rejected same-sequence failures", async () => {
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
        contains: "Continue model.",
        text: JSON.stringify({
          decision: "blocked",
          summary: "need newer evidence to continue pushing the same sequence",
          message_for_bootstrapper: "",
          artifacts_updated: [],
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
    await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_2", "sequences"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "model_workspace", "level_2", "sequences", "seq_0001.json"),
      JSON.stringify({ level: 2, sequence_id: "seq_0001" }, null, 2),
      "utf8",
    );

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
    expect(bootstrapQueue.items).toHaveLength(0);
    expect(modelerQueue.items).toHaveLength(0);
    expect(events.some((event) =>
      event.kind === "modeler.progress_advanced"
      && event.payload?.firstFailingSequenceId === "seq_0001"
      && event.payload?.firstFailingStep === 8
    )).toBe(true);
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
        contains: "Continue model.",
        text: JSON.stringify({
          decision: "blocked",
          summary: "need newer evidence to continue pushing the same sequence",
          message_for_bootstrapper: "",
          artifacts_updated: [],
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
    expect(bootstrapQueue.items).toHaveLength(0);
    expect(modelerQueue.items).toHaveLength(0);
    expect(events.some((event) =>
      event.kind === "modeler.progress_advanced"
      && event.payload?.firstFailingSequenceId === "seq_0001"
      && event.payload?.firstFailingStep === 14
    )).toBe(true);
  }, 15000);

  test.skip("chains solver to modeler to bootstrapper across multiple solved levels and queues a frontier seed", async () => {
    const observePath = path.join(workspaceRoot, "scripts", "observe_multilevel.js");
    await fs.writeFile(observePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const path = require("node:path");
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
      await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_1", "sequences"), { recursive: true });
      await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_2", "sequences"), { recursive: true });
      await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_3", "sequences"), { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"), JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2), "utf8");
      await fs.writeFile(path.join(workspaceRoot, "model_workspace", "level_2", "sequences", "seq_0001.json"), JSON.stringify({ level: 2, sequence_id: "seq_0001" }, null, 2), "utf8");
      await fs.writeFile(path.join(workspaceRoot, "model_workspace", "level_3", "sequences", "seq_0001.json"), JSON.stringify({ level: 3, sequence_id: "seq_0001" }, null, 2), "utf8");

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

  test.skip("frontier discovery acceptance uses the queued evidence snapshot and drives a replacement solver", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "MODELER_PROMPT",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "frontier discovered from snapshot",
          message_for_bootstrapper: "level 2 is visible after the accepted level 1 route",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_frontier_bundle",
        }),
      },
      {
        contains: "BOOTSTRAP_PROMPT",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "frontier seed is ready",
          seed_bundle_updated: false,
          notes: "finalize best known frontier seed",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "frontier_branch_improved",
        }),
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "10";

    const syncPath = path.join(workspaceRoot, "scripts", "sync_snapshot.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", async () => {
  const input = JSON.parse(data || "{}");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const sourceRoot = path.join(String(input.evidenceBundlePath || ""), "workspace", "game_ls20");
  const targetRoot = String(input.targetWorkspaceDir || input.workspaceRoot);
  await fs.writeFile(path.join(input.workspaceRoot, "flux", "sync_bundle_path.txt"), String(input.evidenceBundlePath || ""), "utf8");
  for (const levelName of ["level_1", "level_2"]) {
    const source = path.join(sourceRoot, levelName);
    const target = path.join(targetRoot, levelName);
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true });
  }
  process.stdout.write(JSON.stringify({ synced: true, bundle: input.evidenceBundlePath || "" }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);

    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_frontier.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  status_after: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", win_levels: 7 },
  compare_payload: {
    ok: true,
    action: "compare_sequences",
    level: 2,
    all_match: true,
    compared_sequences: 1,
    eligible_sequences: 1,
    diverged_sequences: 0,
    reports: [{ sequence_id: "seq_0001", matched: true, report_file: "level_2/report.md" }]
  },
  tool_results: []
})));`, "utf8");
    await fs.chmod(rehearsePath, 0o755);

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_frontier_discovery.js");
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
      message: "need provider turn",
      model_output: modelOutput,
      compare_payload: {
        level: 1,
        all_match: false,
        reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "needs_update" }]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: modelOutput.summary || "frontier accepted",
    model_output: modelOutput,
    compare_payload: {
      level: 1,
      frontier_level: 2,
      frontier_discovery: true,
      all_match: true,
      requested_sequences: 2,
      eligible_sequences: 1,
      compared_sequences: 1,
      diverged_sequences: 0,
      skipped_sequences: [
        { level: 2, sequence_id: "seq_0001", sequence_file: "seq_0001.json", end_reason: "open", reason: "wrong_level" }
      ],
      reports: [{ level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);

    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    const fluxText = (await fs.readFile(fluxPath, "utf8"))
      .replace(/observe_evidence:\n    command: \["[^"]*observe\.js"\]/, `observe_evidence:\n    command: ["${path.join(workspaceRoot, "scripts", "observe.js")}"]`)
      .replace(/rehearse_seed_on_model:\n    command: \["[^"]*rehearse\.js"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]\n  rehearse_seed_on_model:\n    command: ["${rehearsePath}"]`)
      .replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
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
    await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "current.json"), JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      syntheticMessages: [{ role: "assistant", text: "Seed knowledge" }],
      replayPlan: [{ tool: "shell", args: { cmd: ["arc_action", "ACTION1"] } }],
      assertions: ["frontier-discovery"],
    }, null, 2), "utf8");

    const bundlePath = path.join(workspaceRoot, "flux", "evidence_bundles", "bundle_live");
    await fs.mkdir(path.join(bundlePath, "workspace", "game_ls20", "level_1", "sequences"), { recursive: true });
    await fs.mkdir(path.join(bundlePath, "workspace", "game_ls20", "level_2", "sequences"), { recursive: true });
    await fs.writeFile(
      path.join(bundlePath, "workspace", "game_ls20", "level_1", "sequences", "seq_0001.json"),
      JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(bundlePath, "workspace", "game_ls20", "level_2", "sequences", "seq_0001.json"),
      JSON.stringify({ level: 2, sequence_id: "seq_0001" }, null, 2),
      "utf8",
    );
    await expect(fs.access(path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"))).rejects.toThrow();

    try {
      await runModelerQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_model_frontier_bundle",
          sessionType: "modeler",
          createdAt: new Date().toISOString(),
          reason: "solver_new_evidence",
          payload: {
            evidenceWatermark: "wm_frontier_bundle",
            evidenceBundlePath: bundlePath,
            latestEvidence: {
              summary: "current_level=2",
              state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", win_levels: 7 },
            },
          },
        },
      });

      expect(await fs.readFile(path.join(workspaceRoot, "flux", "sync_bundle_path.txt"), "utf8")).toBe(bundlePath);
      expect(JSON.parse(await fs.readFile(path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"), "utf8"))).toEqual({
        level: 1,
        sequence_id: "seq_0001",
      });
      expect(JSON.parse(await fs.readFile(path.join(workspaceRoot, "model_workspace", "level_2", "sequences", "seq_0001.json"), "utf8"))).toEqual({
        level: 2,
        sequence_id: "seq_0001",
      });

      const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items).toHaveLength(1);

      await runBootstrapperQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: bootstrapQueue.items[0]!,
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
      const messagesPath = path.join(solverDir, sessionId, "messages.jsonl");
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
      requestActiveSolverInterrupt(sessionId);
      await runPromise;

      const events = await readFluxEvents(workspaceRoot, config);
      expect(events.some((event) => event.kind === "modeler.acceptance_passed")).toBe(true);
      expect(events.some((event) => event.kind === "bootstrapper.attested_satisfactory")).toBe(true);
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  }, 15000);

  test.skip("orchestrator handles level-1 acceptance, failed level-2 rehearsal, capped level-2 modeling, then replacement solver handoff", async () => {
    const observePath = path.join(workspaceRoot, "scripts", "observe_long_mixed.js");
    await fs.writeFile(observePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const instance = input.instance || {};
  const instanceId = String(instance.instance_id || input.attemptId || "instance_1");
  const counterPath = path.join(input.workspaceRoot, "flux", \`observe_\${instanceId}.txt\`);
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.mkdirSync(path.dirname(counterPath), { recursive: true });
  fs.writeFileSync(counterPath, String(count));
  const headPath = path.join(input.workspaceRoot, "flux", "head_level.txt");
  let headLevel = 0;
  try { headLevel = Number(fs.readFileSync(headPath, "utf8")) || 0; } catch {}
  const preplayed = instanceId.startsWith("seed_rev_");
  let evidence;
  if (preplayed) {
    evidence = {
      summary: "replacement solver after attested seed",
      action_count: 40,
      changed_pixels: 1,
      state: {
        current_level: 3,
        levels_completed: 3,
        win_levels: 3,
        state: "WIN",
        total_steps: 40,
        current_attempt_steps: 0,
        last_action_name: "ACTION1"
      }
    };
  } else if (headLevel === 0) {
    evidence = {
      summary: "phase_level1",
      action_count: count,
      changed_pixels: 1,
      state: {
        current_level: 1,
        levels_completed: 0,
        win_levels: 3,
        state: "NOT_FINISHED",
        total_steps: count,
        current_attempt_steps: count,
        last_action_name: "ACTION1"
      }
    };
  } else if (headLevel === 1) {
    evidence = {
      summary: "phase_level3_frontier",
      action_count: 20 + count,
      changed_pixels: 1,
      state: {
        current_level: 3,
        levels_completed: 2,
        win_levels: 3,
        state: "NOT_FINISHED",
        total_steps: 20 + count,
        current_attempt_steps: 5 + count,
        last_action_name: "ACTION4"
      }
    };
  } else {
    evidence = {
      summary: "phase_level3_after_level2_accept",
      action_count: 30 + count,
      changed_pixels: 1,
      state: {
        current_level: 3,
        levels_completed: 2,
        win_levels: 3,
        state: "NOT_FINISHED",
        total_steps: 30 + count,
        current_attempt_steps: 4 + count,
        last_action_name: "ACTION2"
      }
    };
  }
  const bundleId = preplayed ? "bundle_replacement" : (headLevel === 0 ? "bundle_level1" : (headLevel === 1 ? "bundle_level3" : "bundle_level3_after_level2"));
  const bundlePath = path.join(input.workspaceRoot, "flux", "evidence_bundles", bundleId);
  fs.mkdirSync(bundlePath, { recursive: true });
  process.stdout.write(JSON.stringify({
    evidence: [evidence],
    evidence_bundle_id: bundleId,
    evidence_bundle_path: bundlePath
  }));
});`, "utf8");
    await fs.chmod(observePath, 0o755);

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_long_mixed.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const modelOutput = input.modelOutput || {};
  const acceptanceTarget = input.acceptanceTarget || {};
  const headPath = path.join(input.workspaceRoot, "flux", "head_level.txt");
  let headLevel = 0;
  try { headLevel = Number(fs.readFileSync(headPath, "utf8")) || 0; } catch {}
  const logPath = path.join(input.workspaceRoot, "flux", "acceptance_targets.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ headLevel, decision: modelOutput.decision || "", target: acceptanceTarget }) + "\\n");
  const summary = String(modelOutput.summary || "");
  if (modelOutput.decision === "checked_current_model") {
    if (headLevel === 0) {
      process.stdout.write(JSON.stringify({
        accepted: false,
        message: "compare mismatch at level 1 sequence seq_0001 step 2: intermediate_frame_mismatch",
        model_output: modelOutput,
        compare_payload: {
          level: 1,
          frontier_level: 1,
          all_match: false,
          compared_sequences: 1,
          eligible_sequences: 1,
          diverged_sequences: 1,
          reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 2, divergence_reason: "intermediate_frame_mismatch" }]
        }
      }));
      return;
    }
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "compare mismatch at level 2 sequence seq_0001 step 1: intermediate_frame_mismatch",
      model_output: modelOutput,
      compare_payload: {
        level: 2,
        frontier_level: 2,
        all_match: false,
        compared_sequences: 1,
        eligible_sequences: 1,
        diverged_sequences: 1,
        reports: [{ level: 2, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "intermediate_frame_mismatch" }]
      }
    }));
    return;
  }
  if (summary.includes("LEVEL1_ACCEPT")) {
    fs.writeFileSync(headPath, "1");
    process.stdout.write(JSON.stringify({
      accepted: true,
      message: summary,
      model_output: modelOutput,
      compare_payload: {
        level: 1,
        frontier_level: 2,
        all_match: true,
        compared_sequences: 5,
        eligible_sequences: 5,
        diverged_sequences: 0,
        covered_sequence_ids: ["level_1:seq_0001","level_1:seq_0002","level_1:seq_0003","level_1:seq_0004","level_1:seq_0005"],
        reports: [
          { level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 1, sequence_completed_level: false },
          { level: 1, sequence_id: "seq_0002", matched: true, frontier_level_after_sequence: 1, sequence_completed_level: false },
          { level: 1, sequence_id: "seq_0003", matched: true, frontier_level_after_sequence: 1, sequence_completed_level: false },
          { level: 1, sequence_id: "seq_0004", matched: true, frontier_level_after_sequence: 1, sequence_completed_level: false },
          { level: 1, sequence_id: "seq_0005", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }
        ]
      }
    }));
    return;
  }
  if (summary.includes("LEVEL2_ACCEPT")) {
    fs.writeFileSync(headPath, "2");
    process.stdout.write(JSON.stringify({
      accepted: true,
      message: summary,
      model_output: modelOutput,
      compare_payload: {
        level: 2,
        frontier_level: 3,
        all_match: true,
        compared_sequences: 1,
        eligible_sequences: 1,
        diverged_sequences: 0,
        covered_sequence_ids: ["level_1:seq_0001","level_1:seq_0002","level_1:seq_0003","level_1:seq_0004","level_1:seq_0005","level_2:seq_0001"],
        reports: [
          { level: 1, sequence_id: "seq_0005", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true },
          { level: 2, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 3, sequence_completed_level: true }
        ]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "unexpected model output",
    model_output: modelOutput,
    compare_payload: {
      level: 1,
      all_match: false,
      compared_sequences: 1,
      eligible_sequences: 1,
      diverged_sequences: 1,
      reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "unexpected" }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);

    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_long_mixed.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const counterPath = path.join(input.workspaceRoot, "flux", "rehearse_count.txt");
  const headPath = path.join(input.workspaceRoot, "flux", "head_level.txt");
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.mkdirSync(path.dirname(counterPath), { recursive: true });
  fs.writeFileSync(counterPath, String(count));
  let headLevel = 0;
  try { headLevel = Number(fs.readFileSync(headPath, "utf8")) || 0; } catch {}
  if (headLevel < 2) {
    process.stdout.write(JSON.stringify({
      rehearsal_ok: true,
      status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 3 },
      status_after: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", win_levels: 3 },
      compare_payload: {
        level: 2,
        frontier_level: 2,
        all_match: false,
        compared_sequences: 1,
        eligible_sequences: 1,
        reports: [{ level: 2, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "intermediate_frame_mismatch" }]
      },
      tool_results: []
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    rehearsal_ok: true,
    status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 3 },
    status_after: { current_level: 3, levels_completed: 2, state: "NOT_FINISHED", win_levels: 3 },
    compare_payload: {
      level: 3,
      frontier_level: 3,
      all_match: true,
      compared_sequences: 1,
      eligible_sequences: 1,
      reports: [{ level: 3, sequence_id: "seq_0001", matched: true }]
    },
    tool_results: []
  }));
});`, "utf8");
    await fs.chmod(rehearsePath, 0o755);

    const replayPath = path.join(workspaceRoot, "scripts", "replay_long_mixed.js");
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
      summary: "preplayed frontier",
      state: {
        current_level: 3,
        levels_completed: 2,
        win_levels: 3,
        state: "NOT_FINISHED",
        total_steps: 20,
        current_attempt_steps: 0,
        last_action_name: "ACTION1"
      }
    }],
    instance: input.instance || {}
  }));
});`, "utf8");
    await fs.chmod(replayPath, 0o755);

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
        contains: "BOOTSTRAP_LEVEL1",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "bootstrap after level 1",
          seed_bundle_updated: false,
          notes: "too early to finalize",
          solver_action: "no_action",
          seed_delta_kind: "no_useful_change",
        }),
      },
      {
        contains: "BOOTSTRAP_LEVEL2",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "bootstrap after level 2",
          seed_bundle_updated: false,
          notes: "frontier seed ready",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "level_completion_advanced",
        }),
      },
      {
        contains: "phase_level3_frontier",
        text: JSON.stringify({
          decision: "accept",
          summary: "LEVEL2_ACCEPT",
          message_for_bootstrapper: "BOOTSTRAP_LEVEL2",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_level2",
        }),
      },
      {
        contains: "phase_level1",
        text: JSON.stringify({
          decision: "accept",
          summary: "LEVEL1_ACCEPT",
          message_for_bootstrapper: "BOOTSTRAP_LEVEL1",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_level1",
        }),
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "20";

    try {
      const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
      await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_1", "sequences"), { recursive: true });
      await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_2", "sequences"), { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"), JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2), "utf8");
      await fs.writeFile(path.join(workspaceRoot, "model_workspace", "level_2", "sequences", "seq_0001.json"), JSON.stringify({ level: 2, sequence_id: "seq_0001" }, null, 2), "utf8");
      const runPromise = runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config);
      const deadline = Date.now() + 15000;
      let events = await readFluxEvents(workspaceRoot, config);
      while (Date.now() < deadline && !events.some((event) => event.kind === "bootstrapper.attested_satisfactory")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        events = await readFluxEvents(workspaceRoot, config);
      }
      expect(events.some((event) => event.kind === "bootstrapper.model_rehearsal_failed")).toBe(true);
      const acceptancePassedIndexes = events
        .map((event, index) => event.kind === "modeler.acceptance_passed" ? index : -1)
        .filter((index) => index >= 0);
      expect(acceptancePassedIndexes.length).toBeGreaterThanOrEqual(2);
      const attestedIndexes = events
        .map((event, index) => event.kind === "bootstrapper.attested_satisfactory" ? index : -1)
        .filter((index) => index >= 0);
      const attestedIndex = attestedIndexes.at(-1) ?? -1;
      expect(attestedIndex).toBeGreaterThan(acceptancePassedIndexes[1] ?? -1);

      const targetLog = await fs.readFile(path.join(workspaceRoot, "flux", "acceptance_targets.jsonl"), "utf8");
      const targets = targetLog.trim().split("\n").map((line) => JSON.parse(line));
      expect(targets.some((row) => row.headLevel === 0 && row.target?.maxLevel === 1)).toBe(true);
      expect(targets.some((row) => row.headLevel === 1 && row.target?.maxLevel === 2)).toBe(true);
      expect(targets.some((row) => row.headLevel === 1 && row.target?.maxLevel > 2)).toBe(false);

      const solverDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
      let solverSessions: string[] = [];
      const solverDeadline = Date.now() + 4000;
      while (Date.now() < solverDeadline && solverSessions.length < 2) {
        try {
          solverSessions = (await fs.readdir(solverDir)).filter((name) => name.startsWith("solver_attempt_")).sort();
        } catch {
          solverSessions = [];
        }
        if (solverSessions.length < 2) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(solverSessions.length).toBeGreaterThanOrEqual(2);
      let sawReplacementPreplay = false;
      for (const sessionId of solverSessions) {
        const replacementMessages = await fs.readFile(path.join(solverDir, sessionId, "messages.jsonl"), "utf8");
        if (
          replacementMessages.includes("Seed preplay already ran on this instance.")
          && replacementMessages.includes("Current live state after preplay: level 3")
        ) {
          sawReplacementPreplay = true;
          break;
        }
      }
      expect(sawReplacementPreplay).toBe(true);

      await requestFluxStop(workspaceRoot, config);
      const stopDeadline = Date.now() + 5000;
      while (Date.now() < stopDeadline) {
        const latestState = await loadFluxState(workspaceRoot, config);
        const activeModelerSessionId = latestState?.active.modeler.sessionId;
        if (activeModelerSessionId && latestState?.active.modeler.status === "running") {
          requestActiveModelerInterrupt(activeModelerSessionId);
        }
        if (latestState?.status === "stopped") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await runPromise;
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  }, 20000);

  test("same accepted seed but stronger model coverage still queues a replacement solver", async () => {
    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_same_seed_stronger_model.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const modelRevisionId = String(input.modelRevisionId || "");
  const level = modelRevisionId.includes("level2") ? 3 : 2;
  process.stdout.write(JSON.stringify({
    rehearsal_ok: true,
    status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 3 },
    status_after: { current_level: level, levels_completed: level - 1, state: "NOT_FINISHED", win_levels: 3 },
    compare_payload: {
      level,
      frontier_level: level,
      all_match: true,
      compared_sequences: 1,
      eligible_sequences: 1,
      reports: [{ level, sequence_id: "seq_0001", matched: true }]
    },
    tool_results: []
  }));
});`, "utf8");
    await fs.chmod(rehearsePath, 0o755);

    const replayPath = path.join(workspaceRoot, "scripts", "replay_same_seed_stronger_model.js");
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
      summary: "preplayed frontier",
      state: {
        current_level: 3,
        levels_completed: 2,
        win_levels: 3,
        state: "NOT_FINISHED",
        total_steps: 20,
        current_attempt_steps: 0,
        last_action_name: "ACTION1"
      }
    }],
    instance: input.instance || {}
  }));
});`, "utf8");
    await fs.chmod(replayPath, 0o755);

    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/rehearse_seed_on_model:\n    command: \["[^"]*"\]/, `rehearse_seed_on_model:\n    command: ["${rehearsePath}"]`)
      .replace(/replay_seed_on_real_game:\n    command: \["[^"]*"\]/, `replay_seed_on_real_game:\n    command: ["${replayPath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");

    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "LEVEL1_BOOTSTRAP",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "same seed initial attestation",
          seed_bundle_updated: false,
          notes: "attest seed without replacement",
          solver_action: "no_action",
          seed_delta_kind: "no_useful_change",
        }),
      },
      {
        contains: "LEVEL2_BOOTSTRAP",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "same seed stronger model",
          seed_bundle_updated: false,
          notes: "same seed but stronger model",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "level_completion_advanced",
        }),
      },
      {
        contains: "MODELER_PROMPT",
        text: JSON.stringify({
          decision: "accept",
          summary: "LEVEL1_ACCEPT",
          message_for_bootstrapper: "LEVEL1_BOOTSTRAP",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_same_seed_l1",
        }),
      },
      {
        contains: "current_level=2",
        text: JSON.stringify({
          decision: "accept",
          summary: "LEVEL2_ACCEPT",
          message_for_bootstrapper: "LEVEL2_BOOTSTRAP",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_same_seed_l2",
        }),
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "10";

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
      await fs.writeFile(path.join(workspaceRoot, "flux", "seed", "current.json"), JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        syntheticMessages: [{ role: "assistant", text: "same seed" }],
        replayPlan: [{ tool: "shell", args: { cmd: ["arc_action", "ACTION1"] } }],
        assertions: [],
      }, null, 2), "utf8");
      await runBootstrapperQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_boot_same_seed_l1",
          sessionType: "bootstrapper",
          createdAt: new Date().toISOString(),
          reason: "model_accepted",
          payload: {
            modelRevisionId: "model_rev_level1",
            baselineModelRevisionId: "model_rev_level1",
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
            modelOutput: { message_for_bootstrapper: "LEVEL1_BOOTSTRAP" },
          },
        },
      });
      let solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
      expect(solverQueue.items).toHaveLength(0);

      await runBootstrapperQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_boot_same_seed_l2",
          sessionType: "bootstrapper",
          createdAt: new Date().toISOString(),
          reason: "model_accepted",
          payload: {
            modelRevisionId: "model_rev_level2",
            baselineModelRevisionId: "model_rev_level2",
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
            modelOutput: { message_for_bootstrapper: "LEVEL2_BOOTSTRAP" },
          },
        },
      });
      solverQueue = await loadFluxQueue(workspaceRoot, config, "solver");
      expect(solverQueue.items).toHaveLength(1);
      expect(String(solverQueue.items[0]?.payload.seedRevisionId || "")).toMatch(/^seed_rev_/);
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
    }
  }, 15000);

  test.skip("orchestrator drives solver, modeler retry, bootstrapper, and replacement solver in one mocked flow", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "prompts", "modeler_continue.md"),
      "Continue model: {{acceptance_message}}",
      "utf8",
    );
    const observePath = path.join(workspaceRoot, "scripts", "observe_full_loop.js");
    await fs.writeFile(observePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const instance = input.instance || {};
  const instanceId = String(instance.instance_id || "");
  const counterPath = path.join(input.workspaceRoot, "flux", \`observe_\${instanceId || "default"}.txt\`);
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.mkdirSync(path.dirname(counterPath), { recursive: true });
  fs.writeFileSync(counterPath, String(count));
  const preplayed = instanceId.startsWith("seed_rev_");
  const evidence = preplayed
    ? {
        summary: "replacement solver resumed at level 2",
        action_count: 17,
        changed_pixels: 1,
        state: {
          current_level: 2,
          levels_completed: 1,
          win_levels: 7,
          state: "NOT_FINISHED",
          total_steps: 17,
          current_attempt_steps: 0,
          last_action_name: "ACTION1"
        }
      }
    : {
        summary: count >= 3 ? "solver kept advancing the frontier" : "solver found one real opening action",
        action_count: count,
        changed_pixels: 1,
        state: {
          current_level: 1,
          levels_completed: 0,
          win_levels: 7,
          state: "NOT_FINISHED",
          total_steps: count,
          current_attempt_steps: count,
          last_action_name: "ACTION1"
        }
      };
  const bundleId = preplayed ? "bundle_replacement_l2" : (count === 1 ? "bundle_initial_l1" : "bundle_initial_l1");
  process.stdout.write(JSON.stringify({
    evidence: [evidence],
    evidence_bundle_id: bundleId,
    evidence_bundle_path: path.join(input.workspaceRoot, "flux", "evidence_bundles", bundleId)
  }));
});`, "utf8");
    await fs.chmod(observePath, 0o755);

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_full_loop.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const counterPath = path.join(input.workspaceRoot, "flux", "accept_full_loop_count.txt");
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  const modelOutput = input.modelOutput || {};
  const preflight = modelOutput.decision === "checked_current_model";
  if (preflight) {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "compare mismatch at level 1 sequence seq_0001 step 2: intermediate_frame_mismatch",
      model_output: modelOutput,
      compare_payload: {
        level: 1,
        all_match: false,
        compared_sequences: 1,
        diverged_sequences: 1,
        reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 2, divergence_reason: "intermediate_frame_mismatch" }]
      }
    }));
    return;
  }
  count += 1;
  fs.mkdirSync(path.dirname(counterPath), { recursive: true });
  fs.writeFileSync(counterPath, String(count));
  const accepted = count >= 2;
  process.stdout.write(JSON.stringify({
    accepted,
    message: accepted ? "accepted after second modeler turn" : "compare mismatch at level 1 sequence seq_0001 step 2: intermediate_frame_mismatch",
    model_output: modelOutput,
    compare_payload: accepted
      ? {
          level: 1,
          frontier_level: 1,
          all_match: true,
          compared_sequences: 1,
          eligible_sequences: 1,
          diverged_sequences: 0,
          covered_sequence_ids: ["level_1:seq_0001"],
          reports: [{ level: 1, sequence_id: "seq_0001", matched: true }]
        }
      : {
          level: 1,
          all_match: false,
          compared_sequences: 1,
          diverged_sequences: 1,
          reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 2, divergence_reason: "intermediate_frame_mismatch" }]
        }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);

    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/observe_evidence:\n    command: \["[^"]*"\]/, `observe_evidence:\n    command: ["${observePath}"]`)
      .replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`)
      .replace(/evidence_poll_ms: 10/, "evidence_poll_ms: 10000");
    await fs.writeFile(fluxPath, fluxText, "utf8");

    process.env.MOCK_PROVIDER_STREAMED_TEXT = "solver output";
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "MODELER_PROMPT",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "first model patch",
          message_for_bootstrapper: "",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_full_loop",
        }),
      },
      {
        contains: "Continue model:",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "second model patch",
          message_for_bootstrapper: "seed now ready",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_full_loop",
        }),
      },
      {
        contains: "BOOTSTRAP_PROMPT",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "seed is ready",
          seed_bundle_updated: true,
          notes: "finalize and interrupt",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "mechanic_explanation_added",
        }),
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "50";

    try {
      const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
      await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_1", "sequences"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"),
        JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2),
        "utf8",
      );
      const runPromise = runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config);
      const deadline = Date.now() + 15000;
      let events = await readFluxEvents(workspaceRoot, config);
      while (
        Date.now() < deadline
        && !events.some((event) => event.kind === "bootstrapper.attested_satisfactory")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        events = await readFluxEvents(workspaceRoot, config);
      }
      expect(events.some((event) => event.kind === "modeler.acceptance_passed")).toBe(true);
      expect(events.some((event) => event.kind === "bootstrapper.attested_satisfactory")).toBe(true);

      const modelerPromptsDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
      const modelerPromptFiles = (await fs.readdir(modelerPromptsDir)).sort();
      expect(modelerPromptFiles.length).toBeGreaterThanOrEqual(2);
      const secondPrompt = JSON.parse(await fs.readFile(path.join(modelerPromptsDir, modelerPromptFiles[1]!), "utf8"));
      expect(String(secondPrompt.promptText)).toContain("compare mismatch at level 1 sequence seq_0001 step 2: intermediate_frame_mismatch");

      const bootstrapSession = await loadFluxSession(workspaceRoot, config, "bootstrapper", "bootstrapper_run");
      expect(bootstrapSession?.status).toBe("idle");

      const solverDir = path.join(workspaceRoot, ".ai-flux", "sessions", "solver");
      let solverSessions: string[] = [];
      const solverDeadline = Date.now() + 4000;
      while (Date.now() < solverDeadline && solverSessions.length < 2) {
        try {
          solverSessions = (await fs.readdir(solverDir)).filter((name) => name.startsWith("solver_attempt_")).sort();
        } catch {
          solverSessions = [];
        }
        if (solverSessions.length < 2) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(solverSessions.length).toBeGreaterThanOrEqual(2);
      let sawReplacementPreplay = false;
      for (const sessionId of solverSessions) {
        const replacementMessages = await fs.readFile(path.join(solverDir, sessionId, "messages.jsonl"), "utf8");
        if (
          replacementMessages.includes("Seed preplay already ran on this instance.")
          && replacementMessages.includes("Current live state after preplay: level 2")
        ) {
          sawReplacementPreplay = true;
          break;
        }
      }
      expect(sawReplacementPreplay).toBe(true);

      await requestFluxStop(workspaceRoot, config);
      await runPromise;
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  }, 20000);

  test("propagates solver theories through modeler handoff into bootstrapper and queues replacement solver", async () => {
    const observePath = path.join(workspaceRoot, "scripts", "observe_theory_flow.js");
    await fs.writeFile(observePath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const root = input.workspaceRoot || process.cwd();
  const counterPath = path.join(root, "observe-theory-count.txt");
  const solverTheoryPath = path.join(root, "solver_handoff", "untrusted_theories.md");
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.writeFileSync(counterPath, String(count), "utf8");
  const bundleName = fs.existsSync(solverTheoryPath) ? "bundle_with_theory" : "bundle_without_theory";
  const bundleRoot = path.join(root, "flux", "evidence_bundles", bundleName);
  const bundleWorkspace = path.join(bundleRoot, "workspace", "model_workspace");
  fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(bundleWorkspace, "level_1", "sequences"), { recursive: true });
  fs.mkdirSync(path.join(bundleWorkspace, "level_current"), { recursive: true });
  fs.writeFileSync(path.join(bundleWorkspace, "level_current", "meta.json"), JSON.stringify({ level: 2 }, null, 2));
  fs.writeFileSync(path.join(bundleWorkspace, "level_1", "sequences", "seq_0001.json"), JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2));
  if (fs.existsSync(solverTheoryPath)) {
    fs.mkdirSync(path.join(bundleWorkspace, "solver_handoff"), { recursive: true });
    fs.copyFileSync(solverTheoryPath, path.join(bundleWorkspace, "solver_handoff", "untrusted_theories.md"));
  }
  fs.mkdirSync(path.join(bundleRoot, "arc_state"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), JSON.stringify({
    bundle_id: bundleName,
    attempt_id: "attempt_theory",
    instance_id: "instance_theory",
    workspace_dir: bundleWorkspace,
    arc_state_dir: path.join(bundleRoot, "arc_state"),
    bundle_completeness: {
      frontier_level: 2,
      has_level_sequences: true,
      has_frontier_initial_state: true,
      has_frontier_sequences: true,
      has_compare_surface: true,
      status: "ready_for_compare"
    }
  }, null, 2));
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: fs.existsSync(solverTheoryPath) ? "solver wrote theory handoff" : "solver reached level 2",
      action_count: count,
      changed_pixels: 1,
      state: {
        current_level: 2,
        levels_completed: 1,
        win_levels: 7,
        state: "NOT_FINISHED",
        total_steps: count,
        current_attempt_steps: count,
        last_action_name: "ACTION1"
      }
    }],
    evidence_bundle_id: bundleName,
    evidence_bundle_path: bundleRoot
  }));
});`, "utf8");
    await fs.chmod(observePath, 0o755);

    const syncPath = path.join(workspaceRoot, "scripts", "sync_theory_flow.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const bundlePath = String(input.evidenceBundlePath || "");
  const target = String(input.targetWorkspaceDir || "");
  const bundleWorkspace = path.join(bundlePath, "workspace", "model_workspace");
  fs.mkdirSync(target, { recursive: true });
  if (fs.existsSync(path.join(bundleWorkspace, "solver_handoff", "untrusted_theories.md"))) {
    fs.mkdirSync(path.join(target, "solver_handoff"), { recursive: true });
    fs.copyFileSync(
      path.join(bundleWorkspace, "solver_handoff", "untrusted_theories.md"),
      path.join(target, "solver_handoff", "untrusted_theories.md")
    );
    fs.writeFileSync(path.join(target, "untrusted_theories_level_1.json"), JSON.stringify({
      schema_version: "flux.solver_untrusted_theory_handoff.v1",
      level: 1,
      frontier_level: 2,
      attempt_id: "attempt_theory",
      evidence_bundle_id: "bundle_with_theory",
      solver_handoff_markdown_path: "solver_handoff/untrusted_theories.md"
    }, null, 2));
  }
  fs.mkdirSync(path.join(target, "level_1", "sequences"), { recursive: true });
  fs.writeFileSync(path.join(target, "level_1", "sequences", "seq_0001.json"), JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2));
  process.stdout.write(JSON.stringify({ synced: true }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_theory_flow.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const modelOutput = input.modelOutput || {};
  if (String(modelOutput.decision || "") === "checked_current_model") {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "current model is behind accepted level 1",
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
    message: "accepted level 1",
    model_output: modelOutput,
    compare_payload: {
      level: 1,
      frontier_level: 2,
      all_match: true,
      compared_sequences: 1,
      eligible_sequences: 1,
      diverged_sequences: 0,
      reports: [{ level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);

    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_theory_flow.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  status_after: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", win_levels: 7 },
  compare_payload: {
    ok: true,
    level: 2,
    frontier_level: 2,
    all_match: true,
    compared_sequences: 1,
    eligible_sequences: 1,
    diverged_sequences: 0,
    reports: [{ level: 2, sequence_id: "seq_0001", matched: true }]
  },
  tool_results: []
})));`, "utf8");
    await fs.chmod(rehearsePath, 0o755);

    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/observe_evidence:\n    command: \["[^"]*"\]/, `observe_evidence:\n    command: ["${observePath}"]`)
      .replace(/rehearse_seed_on_model:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]\n  rehearse_seed_on_model:\n    command: ["${rehearsePath}"]`)
      .replace(/acceptance:\n    command: \["[^"]*"\]/, `acceptance:\n    command: ["${acceptancePath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");

    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      { contains: "SOLVER_PROMPT", text: "solver frontier reached" },
      {
        contains: "Pending required handoff",
        bashCommands: [
          "mkdir -p solver_handoff",
          "printf '%s\\n' '# Solver theory' 'Validated level 1: moving through the cross changes the completion symbol.' > solver_handoff/untrusted_theories.md"
        ],
        text: "solver wrote theory handoff"
      },
      {
        contains: "New solver handoff theory is available.",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\\n' '# Level 1 modeler theory' 'Trusted so far: cross contact changes the symbol that controls completion.' > modeler_handoff/untrusted_theories_level_1.md"
        ],
        text: JSON.stringify({
          decision: "updated_model",
          summary: "accepted level 1 with theory handoff",
          message_for_bootstrapper: "validated level 1 theory",
          artifacts_updated: ["model_lib.py", "modeler_handoff/untrusted_theories_level_1.md"],
          evidence_watermark: "wm_theory_flow"
        })
      },
      {
        contains: "Modeler handoff files to read before finalizing mechanics:",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "seed now includes validated level 1 mechanics",
          seed_bundle_updated: false,
          notes: "validated and self-criticized mechanics from the modeler handoff",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "mechanic_explanation_improved"
        })
      }
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "40";
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
      const solverPromise = runSolverQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_solver_theory",
          sessionType: "solver",
          createdAt: new Date().toISOString(),
          reason: "theory_flow",
          payload: {},
        },
      });
      let solverSessionId = "";
      let theoryQueueItem = null;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const latestState = await loadFluxState(workspaceRoot, config);
        solverSessionId = latestState?.active.solver.sessionId ?? solverSessionId;
        const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
        theoryQueueItem = modelerQueue.items.find((item) => item.payload?.evidenceBundleId === "bundle_with_theory") ?? null;
        if (theoryQueueItem) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(theoryQueueItem).toBeTruthy();
      requestActiveSolverInterrupt(solverSessionId);
      await solverPromise;

      await runModelerQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: theoryQueueItem!,
      });
      const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items.length).toBeGreaterThan(0);

      await runBootstrapperQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: bootstrapQueue.items[bootstrapQueue.items.length - 1]!,
      });

      const replacementQueue = await loadFluxQueue(workspaceRoot, config, "solver");
      const modelerPromptsDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
      const modelerPromptFiles = (await fs.readdir(modelerPromptsDir)).sort();
      const bootstrapPromptsDir = path.join(workspaceRoot, ".ai-flux", "sessions", "bootstrapper", "bootstrapper_run", "prompts");
      const bootstrapPromptFiles = (await fs.readdir(bootstrapPromptsDir)).sort();
      const modelerPromptText = String(JSON.parse(await fs.readFile(path.join(modelerPromptsDir, modelerPromptFiles[0]!), "utf8")).promptText ?? "");
      const bootstrapPromptText = String(JSON.parse(await fs.readFile(path.join(bootstrapPromptsDir, bootstrapPromptFiles[0]!), "utf8")).promptText ?? "");
      expect(modelerPromptText).toContain("New solver handoff theory is available.");
      expect(modelerPromptText).toContain("solver_handoff/untrusted_theories.md");
      expect(bootstrapPromptText).toContain("Modeler handoff files to read before finalizing mechanics:");
      expect(bootstrapPromptText).toContain("model_workspace/modeler_handoff/untrusted_theories_level_1.md");
      expect(replacementQueue.items.length).toBeGreaterThan(0);
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  }, 20000);

  test("two-phase modeler happy path accepts natural feature_names labeling and reaches bootstrap finalize", async () => {
    const observePath = path.join(workspaceRoot, "scripts", "observe_feature_box_flow.js");
    await fs.writeFile(observePath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const root = input.workspaceRoot || process.cwd();
  const counterPath = path.join(root, "observe-feature-count.txt");
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.writeFileSync(counterPath, String(count), "utf8");
  const bundleRoot = path.join(root, "flux", "evidence_bundles", "bundle_feature_flow");
  const bundleWorkspace = path.join(bundleRoot, "workspace", "model_workspace");
  fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleWorkspace, { recursive: true });
  fs.mkdirSync(path.join(bundleWorkspace, "level_1", "sequences"), { recursive: true });
  fs.mkdirSync(path.join(bundleWorkspace, "level_current"), { recursive: true });
  fs.writeFileSync(path.join(bundleWorkspace, "level_current", "meta.json"), JSON.stringify({ level: 1 }, null, 2));
  fs.writeFileSync(path.join(bundleWorkspace, "level_1", "sequences", "seq_0001.json"), JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2));
  fs.writeFileSync(path.join(bundleWorkspace, "feature_boxes_level_1.json"), JSON.stringify({
    schema_version: "flux.feature_boxes.v1",
    level: 1,
    box_spec_hash: "feature_flow_hash",
    boxes: [
      { box_id: "box_01", bbox: [10, 10, 14, 14] },
      { box_id: "box_02", bbox: [61, 13, 62, 18] }
    ]
  }, null, 2));
  fs.mkdirSync(path.join(bundleRoot, "arc_state"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), JSON.stringify({
    bundle_id: "bundle_feature_flow",
    attempt_id: "attempt_feature_flow",
    instance_id: "instance_feature_flow",
    workspace_dir: bundleWorkspace,
    arc_state_dir: path.join(bundleRoot, "arc_state"),
    bundle_completeness: {
      frontier_level: 1,
      has_level_sequences: true,
      has_frontier_initial_state: true,
      has_frontier_sequences: true,
      has_compare_surface: true,
      status: "ready_for_compare"
    }
  }, null, 2));
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: "level 1 evidence ready for boxing",
      action_count: count,
      changed_pixels: 1,
      state: {
        current_level: 1,
        levels_completed: 0,
        win_levels: 7,
        state: "NOT_FINISHED",
        total_steps: count,
        current_attempt_steps: count,
        last_action_name: "ACTION1"
      }
    }],
    evidence_bundle_id: "bundle_feature_flow",
    evidence_bundle_path: bundleRoot
  }));
});`, "utf8");
    await fs.chmod(observePath, 0o755);

    const syncPath = path.join(workspaceRoot, "scripts", "sync_feature_box_flow.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const bundlePath = String(input.evidenceBundlePath || "");
  const target = String(input.targetWorkspaceDir || "");
  const bundleWorkspace = path.join(bundlePath, "workspace", "model_workspace");
  fs.mkdirSync(target, { recursive: true });
  for (const name of ["feature_boxes_level_1.json"]) {
    fs.copyFileSync(path.join(bundleWorkspace, name), path.join(target, name));
  }
  fs.mkdirSync(path.join(target, "level_1", "sequences"), { recursive: true });
  fs.copyFileSync(path.join(bundleWorkspace, "level_1", "sequences", "seq_0001.json"), path.join(target, "level_1", "sequences", "seq_0001.json"));
  process.stdout.write(JSON.stringify({ synced: true }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_feature_box_flow.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const modelOutput = input.modelOutput || {};
  if (String(modelOutput.decision || "") === "checked_current_model") {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "current model needs a level 1 mechanic patch",
      model_output: modelOutput,
      compare_payload: {
        level: 1,
        all_match: false,
        reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "intermediate_frame_mismatch" }]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted level 1 after feature labeling",
    model_output: modelOutput,
    compare_payload: {
      level: 1,
      frontier_level: 2,
      all_match: true,
      compared_sequences: 1,
      eligible_sequences: 1,
      diverged_sequences: 0,
      reports: [{ level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);

    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_feature_box_flow.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  status_after: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED", win_levels: 7 },
  compare_payload: {
    ok: true,
    level: 2,
    frontier_level: 2,
    all_match: true,
    compared_sequences: 1,
    eligible_sequences: 1,
    diverged_sequences: 0,
    reports: [{ level: 2, sequence_id: "seq_0001", matched: true }]
  },
  tool_results: []
})));`, "utf8");
    await fs.chmod(rehearsePath, 0o755);

    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/observe_evidence:\n    command: \["[^"]*"\]/, `observe_evidence:\n    command: ["${observePath}"]`)
      .replace(/rehearse_seed_on_model:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]\n  rehearse_seed_on_model:\n    command: ["${rehearsePath}"]`)
      .replace(/acceptance:\n    command: \["[^"]*"\]/, `acceptance:\n    command: ["${acceptancePath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");

    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      { contains: "SOLVER_PROMPT", text: "solver frontier reached" },
      {
        contains: "MODELER_BOXES_PROMPT",
        text: JSON.stringify({
          level: 1,
          summary: "natural label response",
          boxes: [
            { box_id: "box_01", feature_names: ["five_by_five_stack"], tags: ["movable"] },
            { box_id: "box_02", feature_names: ["bottom_pair_bar"], tags: ["ui_like", "stable"] }
          ]
        })
      },
      {
        contains: "MODELER_PROMPT",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\\n' '# Level 1 modeler theory' 'The stack moves and the bottom pair bar changes.' > modeler_handoff/untrusted_theories_level_1.md"
        ],
        text: JSON.stringify({
          decision: "updated_model",
          summary: "accepted level 1 after box phase",
          message_for_bootstrapper: "validated level 1 mechanics from feature boxes",
          artifacts_updated: ["model_lib.py", "modeler_handoff/untrusted_theories_level_1.md"],
          evidence_watermark: "wm_feature_flow"
        })
      },
      {
        contains: "Modeler handoff files to read before finalizing mechanics:",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "seed finalized after feature-box happy path",
          seed_bundle_updated: false,
          notes: "validated mechanics from the modeler handoff after natural feature_names labeling",
          solver_action: "queue_and_interrupt",
          seed_delta_kind: "mechanic_explanation_improved"
        })
      }
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "40";
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
      const solverPromise = runSolverQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_solver_feature_flow",
          sessionType: "solver",
          createdAt: new Date().toISOString(),
          reason: "feature_box_flow",
          payload: {},
        },
      });
      let solverSessionId = "";
      let modelerQueueItem = null;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const latestState = await loadFluxState(workspaceRoot, config);
        solverSessionId = latestState?.active.solver.sessionId ?? solverSessionId;
        const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
        modelerQueueItem = modelerQueue.items[0] ?? null;
        if (modelerQueueItem) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(modelerQueueItem).toBeTruthy();
      requestActiveSolverInterrupt(solverSessionId);
      await solverPromise;

      await runModelerQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: modelerQueueItem!,
      });
      const labelsPath = path.join(workspaceRoot, "flux", "model", "feature_labels", "feature_labels_level_1.json");
      const labels = JSON.parse(await fs.readFile(labelsPath, "utf8"));
      expect(labels.boxes[0].features).toEqual(["five_by_five_stack"]);
      expect(labels.boxes[1].features).toEqual(["bottom_pair_bar"]);

      const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items.length).toBeGreaterThan(0);

      await runBootstrapperQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: bootstrapQueue.items[bootstrapQueue.items.length - 1]!,
      });

      const replacementQueue = await loadFluxQueue(workspaceRoot, config, "solver");
      const modelerPromptsDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
      const modelerPromptFiles = (await fs.readdir(modelerPromptsDir)).sort();
      expect(modelerPromptFiles.length).toBeGreaterThanOrEqual(2);
      const firstPromptText = String(JSON.parse(await fs.readFile(path.join(modelerPromptsDir, modelerPromptFiles[0]!), "utf8")).promptText ?? "");
      const secondPromptText = String(JSON.parse(await fs.readFile(path.join(modelerPromptsDir, modelerPromptFiles[1]!), "utf8")).promptText ?? "");
      expect(firstPromptText).toContain("Current box-label phase target: level 1.");
      expect(secondPromptText).toContain("MODELER_PROMPT");
      const bootstrapPromptsDir = path.join(workspaceRoot, ".ai-flux", "sessions", "bootstrapper", "bootstrapper_run", "prompts");
      const bootstrapPromptFiles = (await fs.readdir(bootstrapPromptsDir)).sort();
      const bootstrapPromptText = String(JSON.parse(await fs.readFile(path.join(bootstrapPromptsDir, bootstrapPromptFiles[0]!), "utf8")).promptText ?? "");
      expect(bootstrapPromptText).toContain("Modeler handoff files to read before finalizing mechanics:");
      expect(replacementQueue.items.length).toBeGreaterThan(0);
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  }, 20000);

  test("orchestrator does not self-loop bootstrapper when an unchanged seed still fails rehearsal", async () => {
    const observePath = path.join(workspaceRoot, "scripts", "observe_bootstrap_wait_flow.js");
    await fs.writeFile(observePath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const root = input.workspaceRoot || process.cwd();
  const counterPath = path.join(root, "observe-bootstrap-wait-count.txt");
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.writeFileSync(counterPath, String(count), "utf8");
  const bundleRoot = path.join(root, "flux", "evidence_bundles", "bundle_bootstrap_wait");
  const bundleWorkspace = path.join(bundleRoot, "workspace", "model_workspace");
  fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleWorkspace, { recursive: true });
  fs.mkdirSync(path.join(bundleWorkspace, "level_1", "sequences"), { recursive: true });
  fs.mkdirSync(path.join(bundleWorkspace, "level_current"), { recursive: true });
  fs.writeFileSync(path.join(bundleWorkspace, "level_current", "meta.json"), JSON.stringify({ level: 1 }, null, 2));
  fs.writeFileSync(path.join(bundleWorkspace, "level_1", "sequences", "seq_0001.json"), JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2));
  fs.writeFileSync(path.join(bundleWorkspace, "feature_boxes_level_1.json"), JSON.stringify({
    schema_version: "flux.feature_boxes.v1",
    level: 1,
    box_spec_hash: "bootstrap_wait_hash",
    boxes: [
      { box_id: "box_01", bbox: [10, 10, 14, 14] },
      { box_id: "box_02", bbox: [61, 13, 62, 18] }
    ]
  }, null, 2));
  fs.mkdirSync(path.join(bundleRoot, "arc_state"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), JSON.stringify({
    bundle_id: "bundle_bootstrap_wait",
    attempt_id: "attempt_bootstrap_wait",
    instance_id: "instance_bootstrap_wait",
    workspace_dir: bundleWorkspace,
    arc_state_dir: path.join(bundleRoot, "arc_state"),
    bundle_completeness: {
      frontier_level: 1,
      has_level_sequences: true,
      has_frontier_initial_state: true,
      has_frontier_sequences: true,
      has_compare_surface: true,
      status: "ready_for_compare"
    }
  }, null, 2));
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: "level 1 evidence ready for bootstrap wait flow",
      action_count: count,
      changed_pixels: 1,
      state: {
        current_level: 1,
        levels_completed: 0,
        win_levels: 7,
        state: "NOT_FINISHED",
        total_steps: count,
        current_attempt_steps: count,
        last_action_name: "ACTION1"
      }
    }],
    evidence_bundle_id: "bundle_bootstrap_wait",
    evidence_bundle_path: bundleRoot
  }));
});`, "utf8");
    await fs.chmod(observePath, 0o755);

    const syncPath = path.join(workspaceRoot, "scripts", "sync_bootstrap_wait_flow.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const bundlePath = String(input.evidenceBundlePath || "");
  const target = String(input.targetWorkspaceDir || "");
  const bundleWorkspace = path.join(bundlePath, "workspace", "model_workspace");
  fs.mkdirSync(target, { recursive: true });
  for (const name of ["feature_boxes_level_1.json"]) {
    fs.copyFileSync(path.join(bundleWorkspace, name), path.join(target, name));
  }
  fs.mkdirSync(path.join(target, "level_1", "sequences"), { recursive: true });
  fs.copyFileSync(path.join(bundleWorkspace, "level_1", "sequences", "seq_0001.json"), path.join(target, "level_1", "sequences", "seq_0001.json"));
  process.stdout.write(JSON.stringify({ synced: true }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_bootstrap_wait_flow.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const modelOutput = input.modelOutput || {};
  if (String(modelOutput.decision || "") === "checked_current_model") {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "current model needs a level 1 mechanic patch",
      model_output: modelOutput,
      compare_payload: {
        level: 1,
        all_match: false,
        reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "intermediate_frame_mismatch" }]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted level 1 before bootstrap wait",
    model_output: modelOutput,
    compare_payload: {
      level: 1,
      frontier_level: 2,
      all_match: true,
      compared_sequences: 1,
      eligible_sequences: 1,
      diverged_sequences: 0,
      reports: [{ level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);

    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_bootstrap_wait_flow.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  status_after: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  compare_payload: {
    ok: true,
    level: 1,
    frontier_level: 1,
    all_match: false,
    compared_sequences: 1,
    eligible_sequences: 1,
    diverged_sequences: 1,
    reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "intermediate_frame_mismatch" }]
  },
  tool_results: []
})));`, "utf8");
    await fs.chmod(rehearsePath, 0o755);

    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/observe_evidence:\n    command: \["[^"]*"\]/, `observe_evidence:\n    command: ["${observePath}"]`)
      .replace(/rehearse_seed_on_model:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]\n  rehearse_seed_on_model:\n    command: ["${rehearsePath}"]`)
      .replace(/acceptance:\n    command: \["[^"]*"\]/, `acceptance:\n    command: ["${acceptancePath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");

    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      { contains: "SOLVER_PROMPT", text: "solver frontier reached" },
      {
        contains: "MODELER_BOXES_PROMPT",
        text: JSON.stringify({
          level: 1,
          summary: "natural label response",
          boxes: [
            { box_id: "box_01", feature_names: ["five_by_five_stack"], tags: ["movable"] },
            { box_id: "box_02", feature_names: ["bottom_pair_bar"], tags: ["ui_like", "stable"] }
          ]
        })
      },
      {
        contains: "MODELER_PROMPT",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\\n' '# Level 1 modeler theory' 'Mechanics refined but level 2 still needs model work.' > modeler_handoff/untrusted_theories_level_1.md"
        ],
        text: JSON.stringify({
          decision: "updated_model",
          summary: "accepted level 1 before bootstrap wait",
          message_for_bootstrapper: "BOOTSTRAP_WAIT",
          artifacts_updated: ["model_lib.py", "modeler_handoff/untrusted_theories_level_1.md"],
          evidence_watermark: "wm_bootstrap_wait"
        })
      },
      {
        contains: "BOOTSTRAP_WAIT",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "no useful new seed change",
          seed_bundle_updated: false,
          notes: "seed already captures the best known route; wait for a stronger model",
          solver_action: "no_action",
          seed_delta_kind: "no_useful_change"
        })
      }
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "25";

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

      const runPromise = runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config);
      const deadline = Date.now() + 12000;
      let events = await readFluxEvents(workspaceRoot, config);
      while (
        Date.now() < deadline
        && !events.some((event) => event.kind === "bootstrapper.waiting_for_new_inputs")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        events = await readFluxEvents(workspaceRoot, config);
      }

      const rehearsalStartedCount = events.filter((event) => event.kind === "bootstrapper.model_rehearsal_started").length;
      const rehearsalFailedCount = events.filter((event) => event.kind === "bootstrapper.model_rehearsal_failed").length;
      const waitingCount = events.filter((event) => event.kind === "bootstrapper.waiting_for_new_inputs").length;
      expect(events.some((event) => event.kind === "modeler.acceptance_passed")).toBe(true);
      expect(rehearsalStartedCount).toBe(1);
      expect(rehearsalFailedCount).toBe(1);
      expect(waitingCount).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 250));
      const laterEvents = await readFluxEvents(workspaceRoot, config);
      expect(laterEvents.filter((event) => event.kind === "bootstrapper.model_rehearsal_started")).toHaveLength(1);
      expect(laterEvents.filter((event) => event.kind === "bootstrapper.waiting_for_new_inputs")).toHaveLength(1);
      const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items).toHaveLength(0);
      const latestState = await loadFluxState(workspaceRoot, config);
      expect(latestState?.active.bootstrapper.status).toBe("idle");

      await requestFluxStop(workspaceRoot, config);
      await runPromise;
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  }, 20000);

  test("bootstrapper attests a seed when fresh replay completes the accepted solved levels even if deeper compare still mismatches", async () => {
    const observePath = path.join(workspaceRoot, "scripts", "observe_bootstrap_attest_flow.js");
    await fs.writeFile(observePath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const root = input.workspaceRoot || process.cwd();
  const counterPath = path.join(root, "observe-bootstrap-attest-count.txt");
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.writeFileSync(counterPath, String(count), "utf8");
  const bundleRoot = path.join(root, "flux", "evidence_bundles", "bundle_bootstrap_attest");
  const bundleWorkspace = path.join(bundleRoot, "workspace", "model_workspace");
  fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleWorkspace, { recursive: true });
  fs.mkdirSync(path.join(bundleWorkspace, "level_1", "sequences"), { recursive: true });
  fs.mkdirSync(path.join(bundleWorkspace, "level_2", "sequences"), { recursive: true });
  fs.mkdirSync(path.join(bundleWorkspace, "level_current"), { recursive: true });
  fs.writeFileSync(path.join(bundleWorkspace, "level_current", "meta.json"), JSON.stringify({ level: 3 }, null, 2));
  fs.writeFileSync(path.join(bundleWorkspace, "level_1", "sequences", "seq_0001.json"), JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2));
  fs.writeFileSync(path.join(bundleWorkspace, "level_2", "sequences", "seq_0001.json"), JSON.stringify({ level: 2, sequence_id: "seq_0001" }, null, 2));
  fs.writeFileSync(path.join(bundleWorkspace, "feature_boxes_level_2.json"), JSON.stringify({
    schema_version: "flux.feature_boxes.v1",
    level: 2,
    box_spec_hash: "bootstrap_attest_hash",
    boxes: [
      { box_id: "box_01", bbox: [10, 10, 14, 14] },
      { box_id: "box_02", bbox: [61, 13, 62, 18] }
    ]
  }, null, 2));
  fs.mkdirSync(path.join(bundleRoot, "arc_state"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), JSON.stringify({
    bundle_id: "bundle_bootstrap_attest",
    attempt_id: "attempt_bootstrap_attest",
    instance_id: "instance_bootstrap_attest",
    workspace_dir: bundleWorkspace,
    arc_state_dir: path.join(bundleRoot, "arc_state"),
    bundle_completeness: {
      frontier_level: 3,
      has_level_sequences: true,
      has_frontier_initial_state: true,
      has_frontier_sequences: true,
      has_compare_surface: true,
      status: "ready_for_compare"
    }
  }, null, 2));
  process.stdout.write(JSON.stringify({
    evidence: [{
      summary: "levels 1 and 2 accepted; level 3 visible frontier exists",
      action_count: count,
      changed_pixels: 1,
      state: {
        current_level: 3,
        levels_completed: 2,
        win_levels: 7,
        state: "NOT_FINISHED",
        total_steps: count,
        current_attempt_steps: count,
        last_action_name: "ACTION1"
      }
    }],
    evidence_bundle_id: "bundle_bootstrap_attest",
    evidence_bundle_path: bundleRoot
  }));
});`, "utf8");
    await fs.chmod(observePath, 0o755);

    const syncPath = path.join(workspaceRoot, "scripts", "sync_bootstrap_attest_flow.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const bundlePath = String(input.evidenceBundlePath || "");
  const target = String(input.targetWorkspaceDir || "");
  const bundleWorkspace = path.join(bundlePath, "workspace", "model_workspace");
  fs.mkdirSync(target, { recursive: true });
  for (const name of ["feature_boxes_level_2.json"]) {
    fs.copyFileSync(path.join(bundleWorkspace, name), path.join(target, name));
  }
  for (const level of ["level_1", "level_2"]) {
    fs.mkdirSync(path.join(target, level, "sequences"), { recursive: true });
    fs.copyFileSync(path.join(bundleWorkspace, level, "sequences", "seq_0001.json"), path.join(target, level, "sequences", "seq_0001.json"));
  }
  process.stdout.write(JSON.stringify({ synced: true }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_bootstrap_attest_flow.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const modelOutput = input.modelOutput || {};
  if (String(modelOutput.decision || "") === "checked_current_model") {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "current model needs a level 2 mechanic patch",
      model_output: modelOutput,
      compare_payload: {
        level: 2,
        all_match: false,
        reports: [{ level: 2, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "intermediate_frame_mismatch" }]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted level 2 before bootstrap attest",
    model_output: modelOutput,
    compare_payload: {
      level: 2,
      frontier_level: 3,
      all_match: true,
      compared_sequences: 2,
      eligible_sequences: 2,
      diverged_sequences: 0,
      reports: [
        { level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 1, sequence_completed_level: true },
        { level: 2, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 3, sequence_completed_level: true }
      ]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);

    const rehearsePath = path.join(workspaceRoot, "scripts", "rehearse_bootstrap_attest_flow.js");
    await fs.writeFile(rehearsePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  rehearsal_ok: true,
  status_before: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED", win_levels: 7 },
  status_after: { current_level: 3, levels_completed: 2, state: "NOT_FINISHED", win_levels: 7 },
  compare_payload: {
    ok: true,
    level: 3,
    frontier_level: 3,
    all_match: false,
    compared_sequences: 1,
    eligible_sequences: 1,
    diverged_sequences: 1,
    reports: [{ level: 3, sequence_id: "seq_0001", matched: false, divergence_step: 8, divergence_reason: "frame_count_mismatch" }]
  },
  tool_results: []
})));`, "utf8");
    await fs.chmod(rehearsePath, 0o755);

    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/observe_evidence:\n    command: \["[^"]*"\]/, `observe_evidence:\n    command: ["${observePath}"]`)
      .replace(/rehearse_seed_on_model:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]\n  rehearse_seed_on_model:\n    command: ["${rehearsePath}"]`)
      .replace(/acceptance:\n    command: \["[^"]*"\]/, `acceptance:\n    command: ["${acceptancePath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");

    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      { contains: "SOLVER_PROMPT", text: "solver frontier reached" },
      {
        contains: "MODELER_BOXES_PROMPT",
        text: JSON.stringify({
          level: 2,
          summary: "label level 2 boxes",
          boxes: [
            { box_id: "box_01", feature_names: ["five_by_five_stack"], tags: ["movable"] },
            { box_id: "box_02", feature_names: ["bottom_pair_bar"], tags: ["ui_like", "stable"] }
          ]
        })
      },
      {
        contains: "MODELER_PROMPT",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\\n' '# Level 2 modeler theory' 'Levels 1 and 2 are trusted; level 3 remains exploratory.' > modeler_handoff/untrusted_theories_level_2.md"
        ],
        text: JSON.stringify({
          decision: "accept",
          summary: "accepted level 2 before bootstrap attest",
          message_for_bootstrapper: "BOOTSTRAP_ATTEST",
          artifacts_updated: ["model_lib.py", "modeler_handoff/untrusted_theories_level_2.md"],
          evidence_watermark: "wm_bootstrap_attest"
        })
      },
      {
        contains: "BOOTSTRAP_ATTEST",
        text: JSON.stringify({
          decision: "finalize_seed",
          summary: "attest seed through accepted level 2",
          seed_bundle_updated: false,
          notes: "level 3 still mismatches, but the seed replay through accepted level 2 is valid",
          solver_action: "no_action",
          seed_delta_kind: "no_useful_change"
        })
      }
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "25";

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

      const runPromise = runFluxOrchestrator(workspaceRoot, path.join(workspaceRoot, "flux.yaml"), config);
      const deadline = Date.now() + 12000;
      let events = await readFluxEvents(workspaceRoot, config);
      while (
        Date.now() < deadline
        && !events.some((event) => event.kind === "bootstrapper.attested_satisfactory")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        events = await readFluxEvents(workspaceRoot, config);
      }

      expect(events.some((event) => event.kind === "modeler.acceptance_passed")).toBe(true);
      expect(events.some((event) => event.kind === "bootstrapper.model_rehearsal_passed")).toBe(true);
      expect(events.some((event) => event.kind === "bootstrapper.auto_accepted_after_rehearsal")).toBe(true);
      expect(events.some((event) => event.kind === "bootstrapper.attested_satisfactory")).toBe(true);
      expect(events.some((event) => event.kind === "bootstrapper.waiting_for_new_inputs")).toBe(false);

      const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items).toHaveLength(0);

      await requestFluxStop(workspaceRoot, config);
      await runPromise;
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
      delete process.env.MOCK_PROVIDER_DELAY_MS;
    }
  }, 20000);
});
