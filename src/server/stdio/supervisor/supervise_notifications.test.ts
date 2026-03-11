import { describe, expect, it } from "bun:test";
import {
  emitContextStats,
  emitSupervisorRunEnd,
  emitSupervisorRunStart,
  emitSupervisorTurnDecision,
} from "./supervise_notifications.js";

describe("supervise_notifications", () => {
  it("forwards structured notifications with expected methods", () => {
    const notes: any[] = [];
    const ctx: any = {
      sendNotification(note: any) {
        notes.push(note);
      },
    };

    emitContextStats(ctx, {
      docPath: "/tmp/session.md",
      contextLimit: 200000,
      strategy: "balanced",
      fullPrompt: false,
      compacted: true,
      sourceBytes: 10000,
      trimmedBlocks: 2,
      droppedItemStartedEvents: 1,
      droppedEmptySuccessfulCommands: 0,
      droppedReasoningSnapshots: 0,
      droppedOverflowEvents: 0,
      offloadedBlocks: 1,
      offloadedBytes: 2000,
    });
    emitSupervisorTurnDecision(ctx, {
      turn: 3,
      mode: "hard",
      reasons: ["agent_stop"],
      streamEnded: true,
      cadenceHit: false,
      hadError: false,
      interrupted: false,
    });
    emitSupervisorRunStart(ctx, { turn: 3, mode: "hard", reasons: ["agent_stop"], stopDetails: ["Agent stopped"] });
    emitSupervisorRunEnd(ctx, {
      turn: 3,
      mode: "hard",
      action: "continue",
      resume: true,
      reasons: ["agent_stop"],
      edits: 1,
      appendEdits: 1,
      replaceEdits: 0,
      blocks: 2,
      violations: 0,
    });

    expect(notes.map((n) => n.method)).toEqual([
      "conversation.context_stats",
      "conversation.supervisor_turn_decision",
      "conversation.supervisor_run_start",
      "conversation.supervisor_run_end",
    ]);
    expect(notes[0].params.compacted).toBe(true);
    expect(notes[3].params.action).toBe("continue");
  });
});
