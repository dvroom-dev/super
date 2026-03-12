import { buildModeContractJson, type SupervisorModeGuidance } from "./compile_mode_contract.js";

export type AgentModeContextInput = {
  currentMode?: string;
  allowedNextModes?: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  modeGuidanceByMode?: Record<string, SupervisorModeGuidance>;
  availableToolsMarkdown?: string;
};

export function appendAgentModeContext(promptParts: string[], input: AgentModeContextInput): void {
  const currentMode = String(input.currentMode ?? "").trim();
  const allowedNextModes = (input.allowedNextModes ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
  if (currentMode) {
    const modeContractJson = buildModeContractJson({
      currentMode,
      allowedNextModes,
      modePayloadFieldsByMode: input.modePayloadFieldsByMode,
      modeGuidanceByMode: input.modeGuidanceByMode,
    });
    promptParts.push(
      "Mode Contract (agent-visible):",
      "",
      modeContractJson,
      "",
      "Use the `switch_mode` CLI only when you need to move to another mode. Choose `--target-mode` from `candidate_modes` and include a concise `--reason`.",
      "",
    );
  }
  const availableTools = input.availableToolsMarkdown == null
    ? ""
    : String(input.availableToolsMarkdown).trim();
  if (availableTools) promptParts.push("Available tools (current mode):", "", availableTools, "");
}
