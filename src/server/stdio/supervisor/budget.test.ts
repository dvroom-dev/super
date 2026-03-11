import { describe, expect, it } from "bun:test";
import { sendBudgetUpdateNotification } from "./budget.js";

describe("sendBudgetUpdateNotification", () => {
  it("emits conversation.budget notification with remaining values", () => {
    const notes: any[] = [];
    const startedAt = Date.now() - 1000;
    const cadenceAnchorAt = Date.now() - 200;
    const ctx: any = {
      sendNotification(note: any) {
        notes.push(note);
      },
    };

    sendBudgetUpdateNotification({
      ctx,
      startedAt,
      budget: {
        startedAt,
        timeBudgetMs: 60000,
        tokenBudgetAdjusted: 1000,
        cadenceTimeMs: 10000,
        cadenceTokensAdjusted: 250,
        adjustedTokensUsed: 120,
        budgetMultiplier: 1.5,
        cadenceAnchorAt,
        cadenceTokensAnchor: 20,
        timeBudgetHit: false,
        tokenBudgetHit: false,
        modelCost: 20,
        minCost: 10,
        cheapestModel: "cheap-model",
      },
      currentModel: "agent-model",
      supervisorModel: "supervisor-model",
      timeBudgetMs: 60000,
      tokenBudgetAdjusted: 1000,
      cadenceTimeMs: 10000,
      cadenceTokensAdjusted: 250,
    });

    expect(notes).toHaveLength(1);
    expect(notes[0].method).toBe("conversation.budget");
    expect(notes[0].params.agentModel).toBe("agent-model");
    expect(notes[0].params.supervisorModel).toBe("supervisor-model");
    expect(notes[0].params.adjustedTokensUsed).toBe(120);
    expect(notes[0].params.tokenBudgetRemaining).toBe(880);
    expect(notes[0].params.cadenceTokensRemaining).toBe(150);
    expect(notes[0].params.multiplier).toBe(1.5);
  });
});
