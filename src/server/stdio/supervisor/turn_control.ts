export type SupervisorTurnDecision = {
  supervisorMode: "hard" | "soft" | null;
};

function hasHardStopReason(reasons: string[]): boolean {
  return (
    reasons.includes("time_budget") ||
    reasons.includes("token_budget") ||
    reasons.includes("error") ||
    reasons.includes("return_control") ||
    reasons.includes("interrupted")
  );
}

export function decideSupervisorTurn(args: {
  supervisorEnabled: boolean;
  reasons: string[];
  cadenceHit: boolean;
  streamEnded: boolean;
  hadError: boolean;
  interrupted: boolean;
}): SupervisorTurnDecision {
  if (!args.supervisorEnabled) return { supervisorMode: null };
  const hardStop = hasHardStopReason(args.reasons);
  const naturalAgentStop =
    args.streamEnded && !args.cadenceHit && !args.hadError && !args.interrupted;
  if (hardStop) return { supervisorMode: "hard" };
  if (args.cadenceHit) return { supervisorMode: "soft" };
  if (naturalAgentStop) return { supervisorMode: "hard" };
  return { supervisorMode: null };
}
