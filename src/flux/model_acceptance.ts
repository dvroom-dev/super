import { runFluxProblemCommand } from "./problem_shell.js";
import type { FluxConfig } from "./types.js";

export type FluxModelAcceptanceResult = {
  accepted: boolean;
  message: string;
  payload: Record<string, unknown>;
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
  };
}
