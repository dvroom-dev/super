import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FluxConfig, FluxRunState } from "./types.js";
import { loadFluxState, mutateFluxState, saveFluxState } from "./state.js";

function testConfig(workspaceRoot: string): FluxConfig {
  return {
    schemaVersion: 1,
    runtimeDefaults: {
      provider: "mock",
      model: "mock-model",
      reasoningEffort: "medium",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      env: {},
    },
    storage: {
      fluxRoot: "flux",
      aiRoot: ".ai-flux",
    },
    orchestrator: {
      tickMs: 10,
      solverPreemptGraceMs: 10,
      evidencePollMs: 10,
      modelerIdleBackoffMs: 10,
      bootstrapperIdleBackoffMs: 10,
    },
    problem: {
      provisionInstance: { command: ["echo", "{}"] },
      destroyInstance: { command: ["echo", "{}"] },
      observeEvidence: { command: ["echo", "{}"] },
      rehearseSeedOnModel: { command: ["echo", "{}"] },
      replaySeedOnRealGame: { command: ["echo", "{}"] },
      mergeEvidence: { strategy: "dedupe_by_fingerprint" },
    },
    solver: {
      promptFile: path.join(workspaceRoot, "solver.md"),
      sessionScope: "per_attempt",
      resumePolicy: "never",
      cadenceMs: 10,
      queueReplacementGraceMs: 10,
      tools: { builtin: ["shell"], custom: [] },
    },
    modeler: {
      promptFile: path.join(workspaceRoot, "modeler.md"),
      sessionScope: "run",
      resumePolicy: "always",
      triggers: { onNewEvidence: true, onSolverStopped: true, periodicMs: 10 },
      outputSchema: "model_update_v1",
      acceptance: { command: ["echo", "{}"], parseAs: "json", continueMessageTemplateFile: path.join(workspaceRoot, "modeler_continue.md") },
    },
    bootstrapper: {
      promptFile: path.join(workspaceRoot, "bootstrapper.md"),
      sessionScope: "run",
      resumePolicy: "always",
      outputSchema: "bootstrap_seed_decision_v1",
      seedBundlePath: "flux/seed/current.json",
      requireModelRehearsalBeforeFinalize: true,
      replay: { maxAttemptsPerEvent: 1, continueMessageTemplateFile: path.join(workspaceRoot, "bootstrapper_continue.md") },
    },
    observability: {
      capturePrompts: true,
      captureRawProviderEvents: true,
      captureToolCalls: true,
      captureToolResults: true,
      captureQueueSnapshots: true,
      captureTimingMetrics: true,
    },
    retention: {
      keepAllEvents: true,
      keepAllSessions: true,
      keepAllAttempts: true,
    },
  };
}

describe("flux state mutation", () => {
  test("serializes concurrent active-slot updates without clobbering newer state", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flux-state-"));
    const config = testConfig(workspaceRoot);
    const ts = new Date().toISOString();
    const initial: FluxRunState = {
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
          sessionId: "solver_old",
          status: "running",
          queueItemId: "q_old",
          pid: process.pid,
          attemptId: "attempt_old",
          instanceId: "instance_old",
          updatedAt: ts,
        },
        modeler: { sessionId: "modeler_run", status: "idle", updatedAt: ts },
        bootstrapper: { sessionId: "bootstrapper_run", status: "running", queueItemId: "q_boot", pid: process.pid, updatedAt: ts },
      },
    };
    await saveFluxState(workspaceRoot, config, initial);

    await Promise.all([
      mutateFluxState(workspaceRoot, config, async (current) => {
        const next = current!;
        next.active.solver = {
          sessionId: "solver_new",
          status: "running",
          queueItemId: "q_new",
          pid: process.pid,
          attemptId: "attempt_new",
          instanceId: "instance_new",
          updatedAt: "2026-04-04T23:08:21.562Z",
        };
        return next;
      }),
      mutateFluxState(workspaceRoot, config, async (current) => {
        const next = current!;
        next.active.bootstrapper = {
          sessionId: "bootstrapper_run",
          status: "idle",
          updatedAt: "2026-04-04T23:18:16.581Z",
        };
        return next;
      }),
    ]);

    const state = await loadFluxState(workspaceRoot, config);
    expect(state?.active.solver.sessionId).toBe("solver_new");
    expect(state?.active.solver.status).toBe("running");
    expect(state?.active.bootstrapper.status).toBe("idle");
  });
});
