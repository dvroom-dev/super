import { describe, expect, test } from "bun:test";
import { reduceFluxProjection } from "./projections.js";
import type { FluxEvent } from "./types.js";

describe("flux projections", () => {
  test("reduces run lifecycle and pending slot events into state and queue projections", () => {
    const events: FluxEvent[] = [
      {
        eventId: "evt_1",
        ts: "2026-04-09T10:00:00.000Z",
        kind: "projection.run_initialized",
        workspaceRoot: "/tmp/run",
        summary: "start",
        payload: {
          configPath: "/tmp/run/flux.yaml",
          pid: 123,
          startedAt: "2026-04-09T10:00:00.000Z",
        },
      },
      {
        eventId: "evt_2",
        ts: "2026-04-09T10:00:01.000Z",
        kind: "projection.queue_updated",
        workspaceRoot: "/tmp/run",
        sessionType: "solver",
        summary: "queue solver",
        payload: {
          item: {
            id: "q_solver",
            sessionType: "solver",
            createdAt: "2026-04-09T10:00:01.000Z",
            reason: "initial_solver_attempt",
            payload: {},
          },
        },
      },
      {
        eventId: "evt_3",
        ts: "2026-04-09T10:00:02.000Z",
        kind: "projection.slot_updated",
        workspaceRoot: "/tmp/run",
        sessionType: "solver",
        sessionId: "solver_attempt_1",
        invocationId: "q_solver",
        summary: "slot running",
        payload: {
          active: {
            sessionId: "solver_attempt_1",
            invocationId: "q_solver",
            status: "running",
            queueItemId: "q_solver",
            pid: 123,
            attemptId: "attempt_1",
            instanceId: "instance_1",
            updatedAt: "2026-04-09T10:00:02.000Z",
          },
        },
      },
      {
        eventId: "evt_4",
        ts: "2026-04-09T10:00:03.000Z",
        kind: "projection.queue_updated",
        workspaceRoot: "/tmp/run",
        sessionType: "solver",
        summary: "queue cleared",
        payload: { item: null },
      },
      {
        eventId: "evt_5",
        ts: "2026-04-09T10:00:04.000Z",
        kind: "projection.run_stop_requested",
        workspaceRoot: "/tmp/run",
        summary: "stop requested",
        payload: {},
      },
    ];

    const projection = reduceFluxProjection({
      workspaceRoot: "/tmp/run",
      configPath: "/tmp/run/flux.yaml",
      events,
    });

    expect(projection.state.status).toBe("stopping");
    expect(projection.state.stopRequested).toBe(true);
    expect(projection.state.active.solver.status).toBe("running");
    expect(projection.state.active.solver.invocationId).toBe("q_solver");
    expect(projection.queues.solver.items).toHaveLength(0);
    expect(projection.state.pid).toBe(123);
  });
});
