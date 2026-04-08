import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFluxConfig } from "./config.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { loadFluxSession, saveFluxSession } from "./session_store.js";
import type { FluxSessionRecord } from "./types.js";

describe("flux provider session", () => {
  let workspaceRoot = "";
  const clearMockProviderEnv = () => {
    delete process.env.MOCK_PROVIDER_FORCE;
    delete process.env.MOCK_PROVIDER_STREAMED_ERROR_IF_THREAD_ID_SET;
    delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    delete process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON;
    delete process.env.MOCK_PROVIDER_RUNONCE_ERROR;
    delete process.env.MOCK_PROVIDER_STREAMED_TERMINAL_ERROR;
  };

  beforeEach(async () => {
    clearMockProviderEnv();
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-provider-session-"));
    await fs.mkdir(path.join(workspaceRoot, "prompts"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "prompts", "solver.md"), "Solve.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "modeler.md"), "Model.", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "prompts", "bootstrapper.md"), "Bootstrap.", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "scripts"), { recursive: true });
    const noopPath = path.join(workspaceRoot, "scripts", "noop.js");
    await fs.writeFile(noopPath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.stdout.write("{}"));`, "utf8");
    await fs.chmod(noopPath, 0o755);
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
    command: ["${noopPath}"]
  destroy_instance:
    command: ["${noopPath}"]
  observe_evidence:
    command: ["${noopPath}"]
  rehearse_seed_on_model:
    command: ["${noopPath}"]
  replay_seed_on_real_game:
    command: ["${noopPath}"]
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
    continue_message_template_file: prompts/modeler.md
bootstrapper:
  prompt_file: prompts/bootstrapper.md
  session_scope: run
  resume_policy: always
  output_schema: bootstrap_seed_decision_v1
  seed_bundle_path: flux/seed/current.json
  require_model_rehearsal_before_finalize: true
  replay:
    max_attempts_per_event: 1
    continue_message_template_file: prompts/bootstrapper.md
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

  test("retries once on stale provider thread state and persists the fresh thread id", async () => {
    process.env.MOCK_PROVIDER_STREAMED_ERROR_IF_THREAD_ID_SET = "codex app-server exited (signal SIGTERM)\nstate db missing rollout path for thread old_thread";
    process.env.MOCK_PROVIDER_STREAMED_TEXT = JSON.stringify({ ok: true, retried: true });
    try {
      const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
      const session: FluxSessionRecord = {
        sessionId: "modeler_run",
        sessionType: "modeler",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provider: "mock",
        model: "mock-model",
        resumePolicy: "always",
        sessionScope: "run",
        providerThreadId: "stale_thread_id",
      };
      await saveFluxSession(workspaceRoot, config, session);

      const result = await runFluxProviderTurn({
        workspaceRoot,
        config,
        session,
        sessionType: "modeler",
        promptText: "repair model",
        workingDirectory: workspaceRoot,
      });

      expect(result.assistantText).toContain("\"retried\":true");
      expect(result.providerThreadId).toMatch(/^mock_thread_/);
      expect(result.providerThreadId).not.toBe("stale_thread_id");
      const saved = await loadFluxSession(workspaceRoot, config, "modeler", "modeler_run");
      expect(saved?.providerThreadId).toBe(result.providerThreadId);
    } finally {
      delete process.env.MOCK_PROVIDER_STREAMED_ERROR_IF_THREAD_ID_SET;
      delete process.env.MOCK_PROVIDER_STREAMED_TEXT;
    }
  });

  test("classifies Claude rate limits as non-retryable provider failures", async () => {
    process.env.MOCK_PROVIDER_FORCE = "1";
    process.env.MOCK_PROVIDER_PROVIDER_EVENTS_JSON = JSON.stringify([
      {
        type: "provider_item",
        item: { provider: "claude", kind: "other", type: "event", summary: "rate limit", includeInTranscript: false },
        raw: { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
      },
      {
        type: "assistant_message",
        text: "You've hit your limit · resets 1am (America/Los_Angeles)",
      },
    ]);
    process.env.MOCK_PROVIDER_STREAMED_TERMINAL_ERROR = "Claude Code process exited with code 1";
    try {
      const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
      const session: FluxSessionRecord = {
        sessionId: "solver_attempt_test",
        sessionType: "solver",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provider: "claude",
        model: "claude-opus-4-6",
        resumePolicy: "never",
        sessionScope: "per_attempt",
      };
      await expect(runFluxProviderTurn({
        workspaceRoot,
        config,
        session,
        sessionType: "solver",
        promptText: "solve",
        workingDirectory: workspaceRoot,
      })).rejects.toThrow(/provider_rate_limited: You've hit your limit/i);
    } finally {
      clearMockProviderEnv();
    }
  });

  test("caps persisted latestAssistantText to keep session saves bounded", async () => {
    process.env.MOCK_PROVIDER_STREAMED_TEXT = "x".repeat(20_000);
    try {
      const config = await loadFluxConfig(workspaceRoot, "flux.yaml");
      const session: FluxSessionRecord = {
        sessionId: "modeler_run",
        sessionType: "modeler",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provider: "mock",
        model: "mock-model",
        resumePolicy: "always",
        sessionScope: "run",
      };
      const result = await runFluxProviderTurn({
        workspaceRoot,
        config,
        session,
        sessionType: "modeler",
        promptText: "repair model",
        workingDirectory: workspaceRoot,
      });
      expect(result.assistantText.length).toBe(20_000);
      const saved = await loadFluxSession(workspaceRoot, config, "modeler", "modeler_run");
      expect(saved?.latestAssistantText?.length ?? 0).toBeLessThanOrEqual(16_000);
      expect(saved?.latestAssistantText?.endsWith("...[truncated]")).toBe(true);
    } finally {
      clearMockProviderEnv();
    }
  });
});
