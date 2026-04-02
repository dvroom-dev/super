import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import pathSync from "node:path";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { readFluxEvents } from "./events.js";
import { requestFluxStop, runFluxOrchestrator } from "./orchestrator.js";
import { fluxRunLockPath } from "./paths.js";
import { loadFluxState } from "./state.js";

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
    const events = await readFluxEvents(workspaceRoot, config);
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
});
