import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { runModelerQueueItem } from "./modeler_runtime.js";
import { runBootstrapperQueueItem } from "./bootstrapper_runtime.js";
import { loadFluxQueue } from "./queue.js";
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
});
