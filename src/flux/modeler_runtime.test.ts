import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { deriveAcceptanceTargetLevelFromState, deriveContinuationAcceptanceTarget, runModelerQueueItem } from "./modeler_runtime.js";
import { enqueueFluxQueueItem, loadFluxQueue, saveFluxQueue } from "./queue.js";
import { loadFluxSession, saveFluxSession } from "./session_store.js";
import { saveFluxState } from "./state.js";
import type { FluxRunState, FluxSessionRecord } from "./types.js";

describe("modeler runtime", () => {
  let workspaceRoot = "";

  beforeEach(async () => {
    delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
    delete process.env.MOCK_PROVIDER_DELAY_MS;
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-modeler-"));
    await fs.mkdir(path.join(workspaceRoot, "model_workspace"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "prompts"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "prompts", "solver.md"), "Solve.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler.md"), "Model.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler_boxes.md"), "Label boxes.", "utf8");
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

  test("derives the modeler acceptance ceiling from accepted coverage, not raw frontier evidence", () => {
    const maxLevel = deriveAcceptanceTargetLevelFromState({
      promptPayload: {
        latestEvidence: {
          state: { current_level: 3, levels_completed: 2, state: "NOT_FINISHED" },
        },
      },
      currentCoverageSummary: {
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
    expect(maxLevel).toBe(2);
  });

  test("does not let retry targeting promote the modeler past its invocation ceiling", () => {
    const target = deriveContinuationAcceptanceTarget({
      invocationAcceptanceMaxLevel: 2,
      currentProgress: {
        level: 3,
        contiguousMatchedSequences: 1,
        firstFailingSequenceId: "seq_0002",
        firstFailingStep: 8,
        firstFailingReason: "intermediate_frame_mismatch",
      },
      priorTarget: null,
    });
    expect(target).toEqual({
      maxLevel: 2,
      level: 2,
    });
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
    const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    const events = await readFluxEvents(workspaceRoot, config);
    const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
    expect(bootstrapQueue.items).toHaveLength(0);
    expect(modelerQueue.items).toHaveLength(1);
    expect(modelerQueue.items[0]?.reason).toBe("modeler_continue_until_level1_solved");
    expect(events.some((event) => event.kind === "modeler.bootstrap_deferred")).toBe(true);
    expect(events.some((event) => event.kind === "modeler.acceptance_passed")).toBe(true);
    expect(await fs.readdir(promptDir)).toHaveLength(0);
  });

  test("does not queue bootstrapper before level 1 is solved and accepted", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "frontier discovered but level 1 not solved",
      message_for_bootstrapper: "not ready yet",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_pre_l1",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_pre_level1.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted current frontier slice",
    model_output: input.modelOutput,
    compare_payload: {
      level: 1,
      frontier_level: 2,
      all_match: true,
      compared_sequences: 1,
      eligible_sequences: 1,
      diverged_sequences: 0,
      reports: [
        { level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 1, sequence_completed_level: false }
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
        id: "q_pre_l1",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_pre_l1" },
      },
    });
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(bootstrapQueue.items).toHaveLength(0);
    expect(modelerQueue.items).toHaveLength(1);
    expect(modelerQueue.items[0]?.reason).toBe("modeler_continue_until_level1_solved");
    expect(events.some((event) => event.kind === "modeler.bootstrap_deferred")).toBe(true);
  });

  test("injects new solver theory files into the next modeler prompt", async () => {
    const syncPath = path.join(workspaceRoot, "scripts", "sync_with_solver_theory.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const target = String(input.targetWorkspaceDir || "");
  fs.mkdirSync(path.join(target, "solver_handoff"), { recursive: true });
  fs.writeFileSync(path.join(target, "solver_handoff", "untrusted_theories.md"), "# Solver theory\\nCross changes the symbol.\\n", "utf8");
  fs.writeFileSync(path.join(target, "untrusted_theories_level_1.json"), JSON.stringify({
    schema_version: "flux.solver_untrusted_theory_handoff.v1",
    level: 1,
    frontier_level: 2,
    attempt_id: "attempt_x",
    evidence_bundle_id: "bundle_x",
    solver_handoff_markdown_path: "solver_handoff/untrusted_theories.md"
  }, null, 2), "utf8");
  fs.mkdirSync(path.join(target, "level_1", "sequences"), { recursive: true });
  fs.writeFileSync(path.join(target, "level_1", "sequences", "seq_0001.json"), JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2), "utf8");
  process.stdout.write(JSON.stringify({ synced: true }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_with_retry.js");
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
      message: "need a model update",
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
    accepted: false,
    message: "blocked after reading solver theory",
    model_output: modelOutput,
    compare_payload: {}
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        text: JSON.stringify({
          decision: "blocked",
          summary: "read the new solver theory and continue",
          message_for_bootstrapper: "",
          artifacts_updated: [],
          evidence_watermark: "wm_theory"
        }),
      },
    ]);
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    config.problem.syncModelWorkspace = { command: [syncPath] };
    config.modeler.acceptance.command = [acceptancePath];
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
        id: "q_theory_prompt",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_theory",
          evidenceBundleId: "bundle_x",
          evidenceBundlePath: "/tmp/bundle_x",
          latestEvidence: {
            state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED" },
          },
        },
      },
    });
    const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
    const promptFiles = (await fs.readdir(promptDir)).sort();
    expect(promptFiles.length).toBeGreaterThan(0);
    const firstPrompt = JSON.parse(await fs.readFile(path.join(promptDir, promptFiles[0]!), "utf8"));
    const promptText = String(firstPrompt.promptText ?? "");
    expect(promptText).toContain("New solver handoff theory is available.");
    expect(promptText).toContain("untrusted_theories_level_1.json");
    expect(promptText).toContain("solver_handoff/untrusted_theories.md");
  });

  test("runs the feature-box labeling phase before mechanic patching for a newly reached level", async () => {
    const syncPath = path.join(workspaceRoot, "scripts", "sync_with_feature_boxes.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const target = String(input.targetWorkspaceDir || "");
  fs.mkdirSync(path.join(target, "level_2", "sequences"), { recursive: true });
  fs.writeFileSync(path.join(target, "level_2", "sequences", "seq_0001.json"), JSON.stringify({ level: 2, sequence_id: "seq_0001" }, null, 2), "utf8");
  fs.writeFileSync(path.join(target, "feature_boxes_level_2.json"), JSON.stringify({
    schema_version: "flux.feature_boxes.v1",
    level: 2,
    box_spec_hash: "box_hash_2",
    boxes: [
      { box_id: "box_01", bbox: [10, 10, 14, 14] },
      { box_id: "box_02", bbox: [61, 13, 62, 42] }
    ]
  }, null, 2), "utf8");
  process.stdout.write(JSON.stringify({ synced: true }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_after_boxes.js");
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
      message: "compare mismatch at level 2 sequence seq_0001 step 1: intermediate_frame_mismatch",
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
    message: "accepted after labeling",
    model_output: modelOutput,
    compare_payload: {
      level: 2,
      frontier_level: 2,
      all_match: true,
      compared_sequences: 1,
      eligible_sequences: 1,
      diverged_sequences: 0,
      reports: [{ level: 2, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: false }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Label boxes.",
        text: JSON.stringify({
          level: 2,
          summary: "labeled the moving stack and the bottom bar",
          boxes: [
            { box_id: "box_01", features: ["five_by_five_stack"], tags: ["movable"] },
            { box_id: "box_02", features: ["bottom_pair_bar"], tags: ["ui_like", "stable"] }
          ]
        }),
      },
      {
        contains: "Model.",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\\n' '# Level 2 theory' 'Box labels confirm the moving stack and bottom bar.' > modeler_handoff/untrusted_theories_level_2.md"
        ],
        text: JSON.stringify({
          decision: "updated_model",
          summary: "now ready to patch mechanics",
          message_for_bootstrapper: "",
          artifacts_updated: ["model_lib.py", "modeler_handoff/untrusted_theories_level_2.md"],
          evidence_watermark: "wm_boxes",
        }),
      },
    ]);
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    config.problem.syncModelWorkspace = { command: [syncPath] };
    config.modeler.acceptance.command = [acceptancePath];
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
        id: "q_boxes",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_boxes",
          evidenceBundleId: "bundle_boxes",
          evidenceBundlePath: "/tmp/bundle_boxes",
          latestEvidence: {
            state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED" },
          },
        },
      },
    });
    const labelsPath = path.join(workspaceRoot, "flux", "model", "feature_labels", "feature_labels_level_2.json");
    const labels = JSON.parse(await fs.readFile(labelsPath, "utf8"));
    expect(labels.feature_boxes_hash).toBe("box_hash_2");
    expect(labels.boxes).toHaveLength(2);
    const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
    const promptFiles = (await fs.readdir(promptDir)).sort();
    expect(promptFiles.length).toBeGreaterThanOrEqual(2);
    const firstPrompt = JSON.parse(await fs.readFile(path.join(promptDir, promptFiles[0]!), "utf8"));
    const secondPrompt = JSON.parse(await fs.readFile(path.join(promptDir, promptFiles[1]!), "utf8"));
    expect(String(firstPrompt.promptText ?? "")).toContain("Current box-label phase target: level 2.");
    expect(String(firstPrompt.promptText ?? "")).toContain("Read feature_boxes_level_<n>.json");
    expect(String(secondPrompt.promptText ?? "")).toContain("Model.");
  });

  test("requires a modeler handoff markdown before publishing a newly accepted level", async () => {
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_requires_handoff.js");
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
      message: "need model update",
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
    message: "accepted",
    model_output: modelOutput,
    compare_payload: {
      level: 1,
      frontier_level: 2,
      all_match: true,
      compared_sequences: 1,
      eligible_sequences: 1,
      diverged_sequences: 0,
      reports: [
        { level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }
      ]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "accepted mechanics without handoff yet",
          message_for_bootstrapper: "not yet",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_handoff"
        }),
      },
      {
        contains: "required modeler handoff file is missing",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\n' '# Level 1 theory' 'Validated: cross changes the completion condition.' > modeler_handoff/untrusted_theories_level_1.md"
        ],
        text: JSON.stringify({
          decision: "updated_model",
          summary: "accepted mechanics with handoff",
          message_for_bootstrapper: "use validated level 1 mechanics",
          artifacts_updated: ["model_lib.py", "modeler_handoff/untrusted_theories_level_1.md"],
          evidence_watermark: "wm_handoff"
        }),
      },
    ]);
    const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
    config.modeler.acceptance.command = [acceptancePath];
    await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_1", "sequences"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"),
      JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2),
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
    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_modeler_handoff",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_handoff",
          latestEvidence: {
            state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED" },
          },
        },
      },
    });
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "modeler.handoff_missing")).toBe(true);
    const currentMeta = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "model", "current", "meta.json"), "utf8"));
    expect(currentMeta.summary.level).toBe(1);
    await fs.access(path.join(workspaceRoot, "model_workspace", "modeler_handoff", "untrusted_theories_level_1.md"));
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items.length).toBeGreaterThan(0);
  });

  test("keeps rejected draft evidence out of the durable model workspace", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "blocked",
      summary: "draft updated but blocked on mismatch",
      message_for_bootstrapper: "",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_draft_reject",
    });
    const syncPath = path.join(workspaceRoot, "scripts", "sync_to_draft_only.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const payload = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const targetRoot = String(payload.targetWorkspaceDir || payload.workspaceRoot);
  const seqPath = path.join(targetRoot, "level_1", "sequences", "seq_0001.json");
  fs.mkdirSync(path.dirname(seqPath), { recursive: true });
  fs.writeFileSync(seqPath, JSON.stringify({ level: 1, sequence_id: "seq_0001", draft: true }, null, 2));
  process.stdout.write(JSON.stringify({ synced: true, targetWorkspaceDir: targetRoot }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_rejected_draft.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "blocked",
    model_output: input.modelOutput,
    compare_payload: { level: 1, all_match: false, reports: [] }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/sync_model_workspace:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]`)
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
    await fs.writeFile(path.join(workspaceRoot, "model_workspace", "model_lib.py"), "# durable\n", "utf8");

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_draft_reject",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_draft_reject",
          evidenceBundleId: "bundle_reject",
          evidenceBundlePath: "/tmp/bundle_reject",
          latestEvidence: {
            summary: "current_level=1",
            state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED" },
          },
        },
      },
    });

    expect(await fs.readFile(path.join(workspaceRoot, "model_workspace", "model_lib.py"), "utf8")).toBe("# durable\n");
    await expect(fs.access(path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"))).rejects.toThrow();
    const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
    const promptFiles = await fs.readdir(promptDir);
    const promptPayload = JSON.parse(await fs.readFile(path.join(promptDir, promptFiles[0]!), "utf8"));
    const workingDirectory = String(promptPayload.workingDirectory || "");
    expect(workingDirectory).toContain(path.join("flux", "model", "drafts", "q_draft_reject"));
    const draftSequencePath = path.join(workingDirectory, "level_1", "sequences", "seq_0001.json");
    expect(JSON.parse(await fs.readFile(draftSequencePath, "utf8"))).toEqual({ level: 1, sequence_id: "seq_0001", draft: true });
  });

  test("publishes accepted draft content into the durable model workspace", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "accepted draft",
      message_for_bootstrapper: "ready",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_draft_accept",
    });
    const syncPath = path.join(workspaceRoot, "scripts", "sync_publishable_draft.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const payload = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const targetRoot = String(payload.targetWorkspaceDir || payload.workspaceRoot);
  const seqPath = path.join(targetRoot, "level_1", "sequences", "seq_0001.json");
  fs.mkdirSync(path.dirname(seqPath), { recursive: true });
  fs.writeFileSync(seqPath, JSON.stringify({ level: 1, sequence_id: "seq_0001", published: true }, null, 2));
  process.stdout.write(JSON.stringify({ synced: true, targetWorkspaceDir: targetRoot }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_published_draft.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const path = require("node:path");
  const fs = require("node:fs");
  const seqPath = path.join(String(input.targetWorkspaceDir || input.workspaceRoot), "level_1", "sequences", "seq_0001.json");
  const payload = JSON.parse(fs.readFileSync(seqPath, "utf8"));
  const accepted = Boolean(payload.published);
  process.stdout.write(JSON.stringify({
    accepted,
    message: accepted ? "accepted published draft" : "rejected",
    model_output: input.modelOutput,
    compare_payload: {
      level: 2,
      frontier_level: 2,
      all_match: true,
      compared_sequences: 1,
      diverged_sequences: 0,
      reports: [{ level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/sync_model_workspace:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]`)
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
    await fs.writeFile(path.join(workspaceRoot, "model_workspace", "model_lib.py"), "# durable\n", "utf8");

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_draft_accept",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_draft_accept",
          evidenceBundleId: "bundle_accept",
          evidenceBundlePath: "/tmp/bundle_accept",
          latestEvidence: {
            summary: "current_level=2",
            state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED" },
          },
        },
      },
    });

    expect(JSON.parse(await fs.readFile(path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"), "utf8"))).toEqual({
      level: 1,
      sequence_id: "seq_0001",
      published: true,
    });
    const currentMeta = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "model", "current", "meta.json"), "utf8"));
    expect(currentMeta.summary.coveredSequenceIds).toContain("level_1:seq_0001");
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(1);
  });

  test("re-syncs the model workspace after the modeler turn before acceptance", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "model patched after reviewing evidence",
      message_for_bootstrapper: "use refreshed evidence",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_resync",
    });
    const syncPath = path.join(workspaceRoot, "scripts", "sync_post_turn.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const payload = JSON.parse(data || "{}");
  const workspaceRoot = payload.workspaceRoot;
  const counterPath = require("node:path").join(workspaceRoot, "flux", "sync_count.txt");
  const bundlePathRecord = require("node:path").join(workspaceRoot, "flux", "sync_bundle_path.txt");
  const fs = require("node:fs");
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.mkdirSync(require("node:path").dirname(counterPath), { recursive: true });
  fs.writeFileSync(counterPath, String(count));
  fs.writeFileSync(bundlePathRecord, String(payload.evidenceBundlePath || ""));
  const targetRoot = String(payload.targetWorkspaceDir || workspaceRoot);
  const seqPath = require("node:path").join(targetRoot, "level_1", "sequences", "seq_0001.json");
  fs.mkdirSync(require("node:path").dirname(seqPath), { recursive: true });
  const payloadOut = count >= 2
    ? { level: 1, sequence_id: "seq_0001", sequence_number: 1, start_action_index: 1, end_action_index: 3, end_reason: "reset_level", action_count: 3, actions: [{ action_index: 1 }, { action_index: 2 }, { action_index: 3 }] }
    : { level: 1, sequence_id: "seq_0001", sequence_number: 1, start_action_index: 45, end_action_index: 45, end_reason: "reset_level", action_count: 1, actions: [{ action_index: 45 }] };
  fs.writeFileSync(seqPath, JSON.stringify(payloadOut, null, 2));
  process.stdout.write(JSON.stringify({ synced: true, reason: payload.reason || "", count }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_after_resync.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const seqPath = path.join(String(input.targetWorkspaceDir || input.workspaceRoot), "level_1", "sequences", "seq_0001.json");
  const payload = JSON.parse(fs.readFileSync(seqPath, "utf8"));
  const accepted = Number(payload.start_action_index || 0) === 1;
  process.stdout.write(JSON.stringify({
    accepted,
    message: accepted ? "accepted after post-turn sync" : "stale synced evidence",
    model_output: input.modelOutput,
    compare_payload: accepted
      ? { level: 1, all_match: true, compared_sequences: 1, diverged_sequences: 0, reports: [{ level: 1, sequence_id: "seq_0001", matched: true }] }
      : { level: 1, all_match: false, compared_sequences: 1, diverged_sequences: 1, reports: [{ level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "before_state_mismatch" }] }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/sync_model_workspace:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]`)
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

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_resync",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_resync",
          evidenceBundleId: "bundle_resync",
          evidenceBundlePath: "/tmp/bundle_resync",
          latestEvidence: {
            summary: "current_level=2",
            state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED" },
          },
        },
      },
    });

    const syncCount = Number(await fs.readFile(path.join(workspaceRoot, "flux", "sync_count.txt"), "utf8"));
    expect(syncCount).toBe(3);
    const seenBundlePath = await fs.readFile(path.join(workspaceRoot, "flux", "sync_bundle_path.txt"), "utf8");
    expect(seenBundlePath).toBe("/tmp/bundle_resync");
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(0);
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "modeler.acceptance_passed")).toBe(true);
    expect(events.some((event) => event.kind === "modeler.bootstrap_deferred")).toBe(true);
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

  test("keeps retrying blocked modeler turns when acceptance still provides a concrete sequence mismatch", async () => {
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        text: JSON.stringify({
          decision: "blocked",
          summary: "need exact frames",
          message_for_bootstrapper: "",
          artifacts_updated: [],
          evidence_watermark: "wm_blocked_retry",
        }),
      },
      {
        contains: "Continue model:",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "after direct frame replay",
          message_for_bootstrapper: "",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_blocked_retry",
        }),
      },
    ]);
    const syncPath = path.join(workspaceRoot, "scripts", "sync_blocked_retry.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const payload = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const targetRoot = String(payload.targetWorkspaceDir || payload.workspaceRoot);
  const seqPath = path.join(targetRoot, "level_1", "sequences", "seq_0003.json");
  fs.mkdirSync(path.dirname(seqPath), { recursive: true });
  fs.writeFileSync(seqPath, JSON.stringify({ level: 1, sequence_id: "seq_0003" }, null, 2));
  process.stdout.write(JSON.stringify({ synced: true, targetWorkspaceDir: targetRoot }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_blocked_retry.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const countPath = path.join(input.workspaceRoot, "flux", "blocked_retry_count.txt");
  let count = 0;
  try { count = Number(fs.readFileSync(countPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.mkdirSync(path.dirname(countPath), { recursive: true });
  fs.writeFileSync(countPath, String(count));
  if (count <= 3) {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "compare mismatch at level 1 sequence seq_0003 step 7: frame_count_mismatch",
      model_output: input.modelOutput,
      compare_payload: {
        level: 1,
        all_match: false,
        reports: [
          { level: 1, sequence_id: "seq_0003", matched: false, divergence_step: 7, divergence_reason: "frame_count_mismatch", frame_count_game: 6, frame_count_model: 1 }
        ]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted after blocked retry",
    model_output: input.modelOutput,
    compare_payload: {
      level: 1,
      all_match: true,
      reports: [{ level: 1, sequence_id: "seq_0003", matched: true, sequence_completed_level: true, frontier_level_after_sequence: 2 }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/sync_model_workspace:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]`)
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
    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_blocked_retry",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_blocked_retry" },
      },
    });
    const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
    const promptFiles = (await fs.readdir(promptDir)).sort();
    expect(promptFiles.length).toBeGreaterThanOrEqual(2);
    const secondPrompt = JSON.parse(await fs.readFile(path.join(promptDir, promptFiles[1]!), "utf8"));
    expect(String(secondPrompt.promptText)).toContain("level 1 sequence seq_0003 step 7");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "modeler.acceptance_passed")).toBe(true);
  });

  test("passes an acceptance ceiling based on accepted coverage instead of deeper frontier evidence", async () => {
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "first pass still fails",
          message_for_bootstrapper: "",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_ceiling",
        }),
      },
      {
        contains: "Continue model:",
        text: JSON.stringify({
          decision: "blocked",
          summary: "stopping after one retry",
          message_for_bootstrapper: "",
          artifacts_updated: [],
          evidence_watermark: "wm_ceiling",
        }),
      },
    ]);
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_record_ceiling.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const outPath = path.join(input.workspaceRoot, "flux", "acceptance_targets.jsonl");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, JSON.stringify(input.acceptanceTarget || null) + "\\n");
  const modelOutput = input.modelOutput || {};
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "compare mismatch at level 2 sequence seq_0001 step 1: intermediate_frame_mismatch",
    model_output: modelOutput,
    compare_payload: {
      level: 2,
      all_match: false,
      compared_sequences: 1,
      diverged_sequences: 1,
      reports: [{ level: 2, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "intermediate_frame_mismatch" }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "current"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "current", "meta.json"),
      JSON.stringify({
        revisionId: "model_rev_level_1",
        summary: {
          level: 1,
          frontierLevel: 1,
          allMatch: true,
          coveredSequenceIds: ["level_1:seq_0001"],
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
        id: "q_ceiling",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_ceiling",
          latestEvidence: {
            summary: "current_level=3",
            state: { current_level: 3, levels_completed: 2, state: "NOT_FINISHED" },
          },
        },
      },
    });
    const targetsText = await fs.readFile(path.join(workspaceRoot, "flux", "acceptance_targets.jsonl"), "utf8");
    const targets = targetsText.trim().split("\n").map((line) => JSON.parse(line));
    expect(targets.length).toBeGreaterThanOrEqual(1);
    expect(targets[0]).toEqual({ maxLevel: 2, level: 2 });
    delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
  });

  test("absorbs newer queued evidence into the same active session before retrying acceptance", async () => {
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "first patch from older evidence",
          message_for_bootstrapper: "",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_old",
        }),
      },
      {
        contains: "Continue model:",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\n' '# Level 2 theory' 'Accepted from newer evidence.' > modeler_handoff/untrusted_theories_level_2.md"
        ],
        text: JSON.stringify({
          decision: "updated_model",
          summary: "second patch from newer evidence",
          message_for_bootstrapper: "bootstrap from the newer evidence",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_new",
        }),
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "20";

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_superseding.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const modelOutput = input.modelOutput || {};
  if (modelOutput.decision === "checked_current_model") {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "current model still mismatches level 1 sequence seq_0001 step 2",
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
  const fluxDir = path.join(input.workspaceRoot, "flux");
  const counterPath = path.join(fluxDir, "post_turn_accept_count.txt");
  const startedPath = path.join(fluxDir, "first_turn_acceptance_started");
  const releasePath = path.join(fluxDir, "allow_modeler_continue");
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.mkdirSync(fluxDir, { recursive: true });
  fs.writeFileSync(counterPath, String(count));
  if (count === 1) {
    fs.writeFileSync(startedPath, "ready");
    const respond = () => process.stdout.write(JSON.stringify({
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
    const waitForRelease = () => {
      if (fs.existsSync(releasePath)) {
        respond();
        return;
      }
      setTimeout(waitForRelease, 10);
    };
    waitForRelease();
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted against the newest queued evidence",
    model_output: modelOutput,
    compare_payload: {
      level: 2,
      frontier_level: 2,
      all_match: true,
      compared_sequences: 2,
      eligible_sequences: 2,
      diverged_sequences: 0,
      covered_sequence_ids: ["level_1:seq_0001", "level_2:seq_0001"],
      reports: [
        { level: 1, sequence_id: "seq_0001", matched: true },
        { level: 2, sequence_id: "seq_0001", matched: true }
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
    await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_1", "sequences"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_2", "sequences"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"),
      JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRoot, "model_workspace", "level_2", "sequences", "seq_0001.json"),
      JSON.stringify({ level: 2, sequence_id: "seq_0001" }, null, 2),
      "utf8",
    );

    try {
      const runPromise = runModelerQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_old",
          sessionType: "modeler",
          createdAt: new Date().toISOString(),
          reason: "solver_new_evidence",
          payload: {
            evidenceWatermark: "wm_old",
            evidenceBundlePath: "/tmp/bundle_old",
            latestEvidence: {
              summary: "current_level=1",
              state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED" },
            },
          },
        },
      });

      const startedPath = path.join(workspaceRoot, "flux", "first_turn_acceptance_started");
      const waitDeadline = Date.now() + 3000;
      while (Date.now() < waitDeadline) {
        try {
          await fs.access(startedPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await fs.access(startedPath);

      await enqueueFluxQueueItem(workspaceRoot, config, "modeler", {
        id: "q_new",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_new",
          evidenceBundlePath: "/tmp/bundle_new",
          latestEvidence: {
            summary: "current_level=2",
            state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED" },
          },
        },
      });
      await fs.writeFile(path.join(workspaceRoot, "flux", "allow_modeler_continue"), "ok", "utf8");
      await runPromise;

      const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
      const promptFiles = (await fs.readdir(promptDir)).sort();
      expect(promptFiles.length).toBeGreaterThanOrEqual(2);
      const secondPrompt = JSON.parse(await fs.readFile(path.join(promptDir, promptFiles[1]!), "utf8"));
      expect(String(secondPrompt.promptText)).toContain("compare mismatch at level 1 sequence seq_0001 step 2: intermediate_frame_mismatch");
      expect(String(secondPrompt.promptText)).toContain("Current target evidence watermark: wm_new.");
      expect(String(secondPrompt.promptText)).toContain("python3 model.py compare_sequences --game-id ... --level 1 --sequence seq_0001 --include-reset-ended");

      const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items).toHaveLength(1);
      expect(bootstrapQueue.items[0]?.payload.sourceEvidenceWatermark).toBe("wm_new");
      expect((bootstrapQueue.items[0]?.payload.sourceEvidence as Record<string, unknown>)?.summary).toBe("current_level=2");

      const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
      expect(modelerQueue.items).toHaveLength(0);

      const modelerSession = await loadFluxSession(workspaceRoot, config, "modeler", "modeler_run");
      expect(modelerSession?.status).toBe("idle");
      expect(modelerSession?.stopReason).toBeUndefined();

      const sessionEntries = await fs.readdir(path.join(workspaceRoot, ".ai-flux", "sessions", "modeler"));
      expect(sessionEntries).toEqual(["modeler_run"]);
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
    }
  });

  test("stops after accepting the current batch and leaves newer evidence queued for a fresh invocation", async () => {
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\n' '# Level 1 theory' 'Accepted older target.' > modeler_handoff/untrusted_theories_level_1.md"
        ],
        text: JSON.stringify({
          decision: "updated_model",
          summary: "accepted older target",
          message_for_bootstrapper: "",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_old_accept",
        }),
      },
      {
        contains: "Continue model:",
        text: JSON.stringify({
          decision: "blocked",
          summary: "need to inspect the newer evidence next",
          message_for_bootstrapper: "",
          artifacts_updated: [],
          evidence_watermark: "wm_new_accept",
        }),
      },
    ]);
    process.env.MOCK_PROVIDER_DELAY_MS = "20";

    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_superseded_accept.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const modelOutput = input.modelOutput || {};
  if (modelOutput.decision === "checked_current_model") {
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
  const startedPath = path.join(input.workspaceRoot, "flux", "accepted_turn_waiting");
  const releasePath = path.join(input.workspaceRoot, "flux", "allow_accepted_turn");
  fs.mkdirSync(path.dirname(startedPath), { recursive: true });
  fs.writeFileSync(startedPath, "ready");
  const respond = () => process.stdout.write(JSON.stringify({
    accepted: true,
    message: "accepted older target",
    model_output: modelOutput,
    compare_payload: {
      level: 1,
      frontier_level: 1,
      all_match: true,
      compared_sequences: 1,
      eligible_sequences: 1,
      diverged_sequences: 0,
      reports: [{ level: 1, sequence_id: "seq_0001", matched: true }]
    }
  }));
  const waitForRelease = () => {
    if (fs.existsSync(releasePath)) {
      respond();
      return;
    }
    setTimeout(waitForRelease, 10);
  };
  waitForRelease();
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
    await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_1", "sequences"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"),
      JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2),
      "utf8",
    );

    try {
      const runPromise = runModelerQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_accept_old",
          sessionType: "modeler",
          createdAt: new Date().toISOString(),
          reason: "solver_new_evidence",
          payload: {
            evidenceWatermark: "wm_old_accept",
            latestEvidence: {
              summary: "current_level=1 older target",
              state: { current_level: 1, levels_completed: 0, state: "NOT_FINISHED" },
            },
          },
        },
      });

      const waitPath = path.join(workspaceRoot, "flux", "accepted_turn_waiting");
      const waitDeadline = Date.now() + 3000;
      while (Date.now() < waitDeadline) {
        try {
          await fs.access(waitPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await fs.access(waitPath);

      await enqueueFluxQueueItem(workspaceRoot, config, "modeler", {
        id: "q_accept_new",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "solver_new_evidence",
        payload: {
          evidenceWatermark: "wm_new_accept",
          latestEvidence: {
            summary: "current_level=2 newer target",
            state: { current_level: 2, levels_completed: 1, state: "NOT_FINISHED" },
          },
        },
      });
      await fs.writeFile(path.join(workspaceRoot, "flux", "allow_accepted_turn"), "ok", "utf8");
      await runPromise;

      const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
      const promptFiles = (await fs.readdir(promptDir)).sort();
      expect(promptFiles).toHaveLength(1);

      const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items).toHaveLength(0);

      const modelerQueue = await loadFluxQueue(workspaceRoot, config, "modeler");
      expect(modelerQueue.items).toHaveLength(1);
      expect(modelerQueue.items[0]?.payload.evidenceWatermark).toBe("wm_new_accept");
    } finally {
      delete process.env.MOCK_PROVIDER_DELAY_MS;
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
    }
  });

  test("does not wake bootstrapper for a rejected partial compare slice", async () => {
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
    expect(bootstrapQueue.items).toHaveLength(0);
    expect(modelerQueue.items).toHaveLength(0);
    expect(events.some((event) => event.kind === "modeler.progress_advanced")).toBe(false);
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
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\n' '# Level 1 theory' 'Recovered after stale thread.' > modeler_handoff/untrusted_theories_level_1.md"
        ],
        text: JSON.stringify({
          decision: "updated_model",
          summary: "recovered after stale thread",
          message_for_bootstrapper: "fresh thread recovery worked",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm-stale-thread",
        }),
      },
    ]);
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
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
    }
  });

  test("does not wake bootstrapper for deeper rejected same-sequence failures", async () => {
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "same sequence fails later",
          message_for_bootstrapper: "earliest mismatch moved deeper in the same sequence",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_same_seq_1",
        }),
      },
      {
        contains: "Continue model:",
        text: JSON.stringify({
          decision: "blocked",
          summary: "need newer evidence to keep pushing the same sequence",
          message_for_bootstrapper: "",
          artifacts_updated: [],
          evidence_watermark: "wm_same_seq_1",
        }),
      },
    ]);
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
    expect(bootstrapQueue.items).toHaveLength(0);

    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "same sequence fails later",
          message_for_bootstrapper: "earliest mismatch moved deeper in the same sequence",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_same_seq_2",
        }),
      },
      {
        contains: "Continue model:",
        text: JSON.stringify({
          decision: "blocked",
          summary: "need newer evidence to keep pushing the same sequence",
          message_for_bootstrapper: "",
          artifacts_updated: [],
          evidence_watermark: "wm_same_seq_2",
        }),
      },
    ]);

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
    expect(bootstrapQueue.items).toHaveLength(0);
    expect(events.some((event) => event.kind === "modeler.progress_advanced")).toBe(false);
    delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
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

  test("treats missing level dirs from compare as infrastructure failures", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "compare surface missing level dir",
      message_for_bootstrapper: "",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_missing_level_dir",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_missing_level_dir.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "compare_sequences failed at level 2",
    compare_payload: {
      ok: false,
      action: "compare_sequences",
      error: {
        type: "missing_level_dir",
        message: "missing level dir for level 2"
      }
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
        id: "q_missing_level_dir",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_missing_level_dir" },
      },
    });
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(bootstrapQueue.items).toHaveLength(0);
    expect(events.some((event) =>
      event.kind === "modeler.acceptance_failed"
      && (event.payload?.infrastructureFailure as Record<string, unknown> | undefined)?.type === "missing_level_dir"
    )).toBe(true);
  });

  test("treats compare reports that reference missing synced sequences as infrastructure failures", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "report points at missing synced sequences",
      message_for_bootstrapper: "",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_missing_sequence_surface",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_missing_sequence_surface.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "compare referenced seq_0002 and seq_0003",
    compare_payload: {
      level: 1,
      all_match: false,
      reports: [
        { level: 1, sequence_id: "seq_0002", matched: false, divergence_step: 6, divergence_reason: "frame_count_mismatch" },
        { level: 1, sequence_id: "seq_0003", matched: false, divergence_step: 1, divergence_reason: "intermediate_frame_mismatch" }
      ]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const syncPath = path.join(workspaceRoot, "scripts", "sync_only_seq1.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const payload = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const seqPath = path.join(String(payload.targetWorkspaceDir || payload.workspaceRoot), "level_1", "sequences", "seq_0001.json");
  fs.mkdirSync(path.dirname(seqPath), { recursive: true });
  fs.writeFileSync(seqPath, JSON.stringify({ sequence_id: "seq_0001", level: 1 }, null, 2));
  process.stdout.write(JSON.stringify({ synced: true }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/sync_model_workspace:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]`)
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
    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_missing_sequence_surface",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_missing_sequence_surface" },
      },
    });
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    const events = await readFluxEvents(workspaceRoot, config);
    expect(bootstrapQueue.items).toHaveLength(0);
    expect(events.some((event) =>
      event.kind === "modeler.acceptance_failed"
      && (event.payload?.infrastructureFailure as Record<string, unknown> | undefined)?.type === "missing_sequence_surface"
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

  test("keeps retrying normal acceptance failures until a later turn is accepted", async () => {
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "first retry patch",
          message_for_bootstrapper: "",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_retry_forever",
        }),
      },
      {
        contains: "Continue model:",
        bashCommands: [
          "mkdir -p modeler_handoff",
          "printf '%s\n' '# Level 1 theory' 'Accepted after repeated retries.' > modeler_handoff/untrusted_theories_level_1.md"
        ],
        text: JSON.stringify({
          decision: "updated_model",
          summary: "continued retry patch",
          message_for_bootstrapper: "accepted after enough retries",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_retry_forever",
        }),
      },
    ]);
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_after_many_retries.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const modelOutput = input.modelOutput || {};
  if (modelOutput.decision === "checked_current_model") {
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
  const counterPath = path.join(input.workspaceRoot, "flux", "many_retry_count.txt");
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.mkdirSync(path.dirname(counterPath), { recursive: true });
  fs.writeFileSync(counterPath, String(count));
  const accepted = count >= 5;
  process.stdout.write(JSON.stringify({
    accepted,
    message: accepted ? "accepted after fifth retry" : "compare mismatch at level 1 sequence seq_0001 step 2: intermediate_frame_mismatch",
    model_output: modelOutput,
    compare_payload: accepted
      ? {
          level: 1,
          frontier_level: 2,
          all_match: true,
          compared_sequences: 1,
          eligible_sequences: 1,
          diverged_sequences: 0,
          reports: [{ level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }]
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
    await fs.mkdir(path.join(workspaceRoot, "model_workspace", "level_1", "sequences"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "model_workspace", "level_1", "sequences", "seq_0001.json"),
      JSON.stringify({ level: 1, sequence_id: "seq_0001" }, null, 2),
      "utf8",
    );

    try {
      await runModelerQueueItem({
        workspaceRoot,
        config,
        state,
        queueItem: {
          id: "q_retry_forever",
          sessionType: "modeler",
          createdAt: new Date().toISOString(),
          reason: "new_evidence",
          payload: { evidenceWatermark: "wm_retry_forever" },
        },
      });

      const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
      const promptFiles = (await fs.readdir(promptDir)).sort();
      expect(promptFiles.length).toBeGreaterThanOrEqual(5);
      const secondPrompt = JSON.parse(await fs.readFile(path.join(promptDir, promptFiles[1]!), "utf8"));
      expect(String(secondPrompt.promptText)).toContain("Focus the next retry on level 1 sequence seq_0001 first.");
      expect(String(secondPrompt.promptText)).toContain("python3 model.py compare_sequences --game-id ... --level 1 --sequence seq_0001 --include-reset-ended");
      expect(String(secondPrompt.promptText)).toContain("--level 1 --sequence seq_0001");
      const retryCount = Number(await fs.readFile(path.join(workspaceRoot, "flux", "many_retry_count.txt"), "utf8"));
      expect(retryCount).toBe(5);

      const session = await loadFluxSession(workspaceRoot, config, "modeler", "modeler_run");
      expect(session?.status).toBe("idle");
      expect(session?.stopReason).toBeUndefined();

      const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
      expect(bootstrapQueue.items).toHaveLength(1);

      const invocationResult = JSON.parse(await fs.readFile(
        path.join(workspaceRoot, "flux", "invocations", "q_retry_forever", "result.json"),
        "utf8",
      )) as Record<string, unknown>;
      expect(invocationResult.status).toBe("completed");
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON;
    }
  });

  test("does not use a self-reported compare success string as the acceptance-failed event summary", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "python3 model.py compare_sequences returned all_match: true in the workspace",
      message_for_bootstrapper: "",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_misleading_summary",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_misleading_summary.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "compare_sequences still fails on seq_0002 step 7",
    compare_payload: {
      level: 1,
      all_match: false,
      reports: [
        { level: 1, sequence_id: "seq_0002", matched: false, divergence_step: 7, divergence_reason: "frame_count_mismatch" }
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
        id: "q_misleading_summary",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_misleading_summary" },
      },
    });
    const events = await readFluxEvents(workspaceRoot, config);
    const failed = events.find((event) => event.kind === "modeler.acceptance_failed");
    expect(failed).toBeDefined();
    expect(failed?.summary).not.toContain("all_match: true");
    expect(failed?.summary ?? "").toContain("compare_sequences still fails on seq_0002 step 7");
  });

  test("continuation prompt forces direct transient-frame replay for multi-frame count mismatches", async () => {
    process.env.MOCK_PROVIDER_STREAMED_MATCHERS_JSON = JSON.stringify([
      {
        contains: "Model.",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "first patch",
          message_for_bootstrapper: "",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_frame_retry",
        }),
      },
      {
        contains: "Continue model:",
        text: JSON.stringify({
          decision: "updated_model",
          summary: "second patch",
          message_for_bootstrapper: "",
          artifacts_updated: ["model_lib.py"],
          evidence_watermark: "wm_frame_retry",
        }),
      },
    ]);
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_frame_retry.js");
    const syncPath = path.join(workspaceRoot, "scripts", "sync_frame_retry.js");
    await fs.writeFile(syncPath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const payload = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const targetRoot = String(payload.targetWorkspaceDir || payload.workspaceRoot);
  for (const seq of ["seq_0001", "seq_0002"]) {
    const seqPath = path.join(targetRoot, "level_1", "sequences", seq + ".json");
    fs.mkdirSync(path.dirname(seqPath), { recursive: true });
    fs.writeFileSync(seqPath, JSON.stringify({ level: 1, sequence_id: seq }, null, 2));
  }
  process.stdout.write(JSON.stringify({ synced: true, targetWorkspaceDir: targetRoot }));
});`, "utf8");
    await fs.chmod(syncPath, 0o755);
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const fs = require("node:fs");
  const path = require("node:path");
  const countPath = path.join(input.workspaceRoot, "flux", "frame_retry_count.txt");
  let count = 0;
  try { count = Number(fs.readFileSync(countPath, "utf8")) || 0; } catch {}
  count += 1;
  fs.mkdirSync(path.dirname(countPath), { recursive: true });
  fs.writeFileSync(countPath, String(count));
  if (count <= 3) {
    process.stdout.write(JSON.stringify({
      accepted: false,
      message: "compare mismatch at level 1 sequence seq_0002 step 7: frame_count_mismatch",
      model_output: input.modelOutput,
      compare_payload: {
        level: 1,
        all_match: false,
        reports: [
          { level: 1, sequence_id: "seq_0002", matched: false, divergence_step: 7, divergence_reason: "frame_count_mismatch", frame_count_game: 6, frame_count_model: 1 }
        ]
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
      reports: [{ level: 1, sequence_id: "seq_0002", matched: true }]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText
      .replace(/sync_model_workspace:\n    command: \["[^"]*"\]/, `sync_model_workspace:\n    command: ["${syncPath}"]`)
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
    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_frame_retry",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_frame_retry" },
      },
    });
    const promptDir = path.join(workspaceRoot, ".ai-flux", "sessions", "modeler", "modeler_run", "prompts");
    const promptFiles = (await fs.readdir(promptDir)).sort();
    expect(promptFiles.length).toBeGreaterThanOrEqual(2);
    const secondPrompt = JSON.parse(await fs.readFile(path.join(promptDir, promptFiles[1]!), "utf8"));
    expect(String(secondPrompt.promptText)).toContain("Current failing step: level 1 sequence seq_0002 step 7 (frame_count_mismatch).");
    expect(String(secondPrompt.promptText)).toContain("make your model emit the full transient frame sequence for that step");
    expect(String(secondPrompt.promptText)).toContain("temporarily copy the exact transient frames from evidence for that step via `last_step_frames`");
  });

  test("does not rerun bootstrapper for identical accepted frontier state", async () => {
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_same_frontier.js");
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
      frontier_level: 2,
      all_match: true,
      reports: [
        { level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }
      ]
    }
  }));
});`, "utf8");
    await fs.chmod(acceptancePath, 0o755);
    const fluxPath = path.join(workspaceRoot, "flux.yaml");
    let fluxText = await fs.readFile(fluxPath, "utf8");
    fluxText = fluxText.replace(/command: \["[^"]*accept\.js"\]/, `command: ["${acceptancePath}"]`);
    await fs.writeFile(fluxPath, fluxText, "utf8");
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

  test("queues bootstrapper when acceptance passes via frontier discovery with no eligible frontier sequences", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({
      decision: "updated_model",
      summary: "frontier level discovered",
      message_for_bootstrapper: "level 2 is visible but still open",
      artifacts_updated: ["model_lib.py"],
      evidence_watermark: "wm_frontier_discovery",
    });
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_frontier_discovery.js");
    await fs.writeFile(acceptancePath, `#!/usr/bin/env node
process.stdin.resume();
let data = "";
process.stdin.on("data", (chunk) => data += chunk.toString());
process.stdin.on("end", () => {
  const input = JSON.parse(data || "{}");
  const preflight = input.modelOutput?.decision === "checked_current_model";
  process.stdout.write(JSON.stringify({
    accepted: true,
    message: preflight ? "current model reaches frontier" : "frontier level discovered",
    model_output: input.modelOutput,
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
        { level: 2, sequence_id: "seq_0001", reason: "wrong_level", end_reason: "open" }
      ],
      reports: [
        { level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }
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
        id: "q_frontier_discovery",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_frontier_discovery" },
      },
    });
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(1);
    expect((bootstrapQueue.items[0]?.payload.coverageSummary as Record<string, unknown>)?.frontierLevel).toBe(2);
    expect((bootstrapQueue.items[0]?.payload.coverageSummary as Record<string, unknown>)?.frontierDiscovered).toBe(true);
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
          { level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true },
          { level: 2, sequence_id: "seq_0002", matched: true, frontier_level_after_sequence: 3, sequence_completed_level: true }
        ]
      }
    : {
        level: 1,
        frontier_level: 2,
        all_match: true,
        reports: [{ level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }]
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
          frontierLevel: 2,
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
      frontier_level: 2,
      all_match: true,
      reports: [{ level: 1, sequence_id: "seq_0001", matched: true, frontier_level_after_sequence: 2, sequence_completed_level: true }]
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
          frontierLevel: 2,
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
    expect(currentMeta.revisionId).toBe("model_rev_strong");
    expect(currentMeta.summary.level).toBe(2);
    expect(currentMeta.summary.frontierLevel).toBe(2);
    expect(currentMeta.summary.coveredSequenceIds).toEqual(["level_1:seq_0001", "level_1:seq_0002"]);
    expect(currentMeta.summary.contiguousMatchedSequences).toBe(2);
  });

  test("does not let a rejected frontier-progress revision overwrite the current accepted model head", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```json",
      JSON.stringify({
        decision: "updated_model",
        summary: "frontier progress exists but acceptance still fails",
        message_for_bootstrapper: "frontier progressed",
        artifacts_updated: ["model_lib.py"],
        evidence_watermark: "wm_rejected_progress",
      }, null, 2),
      "```",
    ].join("\n");
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_rejected_progress.js");
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
      message: "current accepted model still fails earliest ordered blocker",
      model_output: input.modelOutput,
      compare_payload: {
        level: 1,
        frontier_level: 1,
        all_match: false,
        reports: [
          { level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 13, divergence_reason: "intermediate_frame_mismatch" }
        ]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "new frontier progress is still rejected",
    model_output: input.modelOutput,
    compare_payload: {
      level: 3,
      frontier_level: 3,
      all_match: false,
      covered_sequence_ids: ["level_3:seq_0001"],
      reports: [
        { level: 3, sequence_id: "seq_0001", matched: true }
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
    const acceptedSummary = {
      level: 1,
      frontierLevel: 1,
      allMatch: true,
      coveredSequenceIds: ["level_1:seq_0001"],
      contiguousMatchedSequences: 1,
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
        lastQueuedBootstrapModelRevisionId: "model_rev_accept",
        lastQueuedBootstrapCoverageSummary: acceptedSummary,
        lastBootstrapperModelRevisionId: "model_rev_accept",
        lastBootstrapperCoverageSummary: acceptedSummary,
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_accept"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_accept", "summary.json"),
      JSON.stringify(acceptedSummary, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "current"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "current", "meta.json"),
      JSON.stringify({ revisionId: "model_rev_accept", summary: acceptedSummary }, null, 2),
      "utf8",
    );

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_rejected_progress",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_rejected_progress" },
      },
    });

    const currentMeta = JSON.parse(await fs.readFile(path.join(workspaceRoot, "flux", "model", "current", "meta.json"), "utf8"));
    expect(currentMeta.revisionId).toBe("model_rev_accept");
    expect(currentMeta.summary).toEqual(acceptedSummary);
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(0);
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "modeler.progress_advanced")).toBe(false);
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

  test("does not requeue bootstrapper for later rejected frontier levels when the earliest blocker regresses to seq_0001 step 1", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = [
      "```json",
      JSON.stringify({
        decision: "updated_model",
        summary: "later frontier still blocked by the same earliest ordered failure",
        message_for_bootstrapper: "do not churn the seed",
        artifacts_updated: ["model_lib.py"],
        evidence_watermark: "wm_same_blocker_later_level",
      }, null, 2),
      "```",
    ].join("\n");
    const acceptancePath = path.join(workspaceRoot, "scripts", "accept_same_blocker_later_level.js");
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
      message: "current model still needs a provider turn",
      model_output: input.modelOutput,
      compare_payload: {
        level: 1,
        frontier_level: 1,
        all_match: false,
        reports: [
          { level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 7, divergence_reason: "frame_count_mismatch" }
        ]
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    accepted: false,
    message: "later frontier is still blocked by the same earliest ordered failure",
    model_output: input.modelOutput,
    compare_payload: {
      level: 4,
      frontier_level: 4,
      all_match: false,
      reports: [
        { level: 1, sequence_id: "seq_0001", matched: false, divergence_step: 1, divergence_reason: "intermediate_frame_mismatch" }
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
    const acceptedSummary = {
      level: 1,
      frontierLevel: 1,
      allMatch: true,
      coveredSequenceIds: ["level_1:seq_0001"],
      contiguousMatchedSequences: 1,
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
        lastQueuedBootstrapModelRevisionId: "model_rev_accept",
        lastQueuedBootstrapCoverageSummary: acceptedSummary,
        lastBootstrapperModelRevisionId: "model_rev_accept",
        lastBootstrapperCoverageSummary: acceptedSummary,
      }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_accept"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "revisions", "model_rev_accept", "summary.json"),
      JSON.stringify(acceptedSummary, null, 2),
      "utf8",
    );
    await fs.mkdir(path.join(workspaceRoot, "flux", "model", "current"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "flux", "model", "current", "meta.json"),
      JSON.stringify({ revisionId: "model_rev_accept", summary: acceptedSummary }, null, 2),
      "utf8",
    );

    await runModelerQueueItem({
      workspaceRoot,
      config,
      state,
      queueItem: {
        id: "q_same_blocker_later_level",
        sessionType: "modeler",
        createdAt: new Date().toISOString(),
        reason: "new_evidence",
        payload: { evidenceWatermark: "wm_same_blocker_later_level" },
      },
    });
    const bootstrapQueue = await loadFluxQueue(workspaceRoot, config, "bootstrapper");
    expect(bootstrapQueue.items).toHaveLength(0);
    const events = await readFluxEvents(workspaceRoot, config);
    expect(events.some((event) => event.kind === "modeler.progress_advanced")).toBe(false);
  });
});
