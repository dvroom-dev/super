import type { RuntimeContext } from "../requests/context.js";
import type { BudgetState } from "./agent_turn.js";

export function sendBudgetUpdateNotification(args: {
  ctx: RuntimeContext;
  startedAt: number;
  budget: BudgetState;
  currentModel: string;
  supervisorModel: string;
  timeBudgetMs: number;
  tokenBudgetAdjusted: number;
  cadenceTimeMs: number;
  cadenceTokensAdjusted: number;
}): void {
  const elapsed = Date.now() - args.startedAt;
  const cadenceElapsed = Date.now() - args.budget.cadenceAnchorAt;
  const cadenceTokensUsed = args.budget.adjustedTokensUsed - args.budget.cadenceTokensAnchor;
  const timeRemaining = args.timeBudgetMs ? Math.max(0, args.timeBudgetMs - elapsed) : null;
  const tokenRemaining = args.tokenBudgetAdjusted
    ? Math.max(0, args.tokenBudgetAdjusted - args.budget.adjustedTokensUsed)
    : null;
  const cadenceTimeRemaining = args.cadenceTimeMs ? Math.max(0, args.cadenceTimeMs - cadenceElapsed) : null;
  const cadenceTokensRemaining = args.cadenceTokensAdjusted
    ? Math.max(0, args.cadenceTokensAdjusted - cadenceTokensUsed)
    : null;
  args.ctx.sendNotification({
    method: "conversation.budget",
    params: {
      timeUsedMs: elapsed,
      adjustedTokensUsed: args.budget.adjustedTokensUsed,
      multiplier: args.budget.budgetMultiplier,
      agentModel: args.currentModel,
      supervisorModel: args.supervisorModel,
      modelCost: args.budget.modelCost,
      minCost: args.budget.minCost,
      cheapestModel: args.budget.cheapestModel,
      timeBudgetMs: args.timeBudgetMs || null,
      tokenBudgetAdjusted: args.tokenBudgetAdjusted || null,
      cadenceTimeMs: args.cadenceTimeMs || null,
      cadenceTokensAdjusted: args.cadenceTokensAdjusted || null,
      timeBudgetRemainingMs: timeRemaining,
      tokenBudgetRemaining: tokenRemaining,
      cadenceTimeRemainingMs: cadenceTimeRemaining,
      cadenceTokensRemaining: cadenceTokensRemaining,
    },
  });
}
