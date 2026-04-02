import { runFluxProblemCommand } from "./problem_shell.js";
import type { FluxConfig } from "./types.js";

export type FluxModelAcceptanceResult = {
  accepted: boolean;
  message: string;
  payload: Record<string, unknown>;
  infrastructureFailure: Record<string, unknown> | null;
};

export async function runModelAcceptance(args: {
  workspaceRoot: string;
  config: FluxConfig;
  modelOutput: Record<string, unknown>;
}): Promise<FluxModelAcceptanceResult> {
  const result = await runFluxProblemCommand(args.config.modeler.acceptance, {
    workspaceRoot: args.workspaceRoot,
    modelOutput: args.modelOutput,
  });
  return {
    accepted: Boolean(result.accepted),
    message: String(result.message ?? ""),
    payload: result,
    infrastructureFailure: result.infrastructure_failure && typeof result.infrastructure_failure === "object" && !Array.isArray(result.infrastructure_failure)
      ? result.infrastructure_failure as Record<string, unknown>
      : null,
  };
}
