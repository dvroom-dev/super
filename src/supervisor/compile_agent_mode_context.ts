import type { ProviderName } from "../providers/types.js";
import type { ProviderFilesystemPolicy } from "../providers/filesystem_permissions.js";
import type { ShellInvocationPolicy } from "../tools/shell_invocation_policy.js";
import { buildModeContractJson, type SupervisorModeGuidance } from "./compile_mode_contract.js";
import type { ActiveProcessState } from "../server/stdio/supervisor/process_runtime.js";

export type AgentModeContextInput = {
  currentMode?: string;
  allowedNextModes?: string[];
  modePayloadFieldsByMode?: Record<string, string[]>;
  modeGuidanceByMode?: Record<string, SupervisorModeGuidance>;
  availableToolsMarkdown?: string;
  provider?: ProviderName;
  providerFilesystemPolicy?: ProviderFilesystemPolicy;
  shellInvocationPolicy?: ShellInvocationPolicy;
  activeProcessState?: ActiveProcessState;
};

function backtickedList(values: string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}

function appendModePermissions(promptParts: string[], input: AgentModeContextInput): void {
  const provider = String(input.provider ?? "").trim();
  const policy = input.providerFilesystemPolicy;
  if (!provider || !policy) return;

  const lines: string[] = [];
  const readAllow = policy.read?.allow ?? [];
  const writeAllow = policy.write?.allow ?? [];
  const createAllow = policy.create?.allow ?? [];
  const readDeny = policy.read?.deny ?? [];
  const writeDeny = policy.write?.deny ?? [];
  const createDeny = policy.create?.deny ?? [];

  lines.push(`Provider filesystem policy (${provider}, enforced at runtime):`);
  if (readAllow.length) {
    lines.push(`- Readable paths: ${backtickedList(readAllow)}`);
  } else {
    lines.push("- Readable paths: workspace-relative paths allowed unless otherwise blocked.");
  }
  if (readDeny.length) {
    lines.push(`- Read denied for: ${backtickedList(readDeny)}`);
  }
  if (writeAllow.length) {
    lines.push(`- Writable existing paths: ${backtickedList(writeAllow)}`);
  } else {
    lines.push("- Writable existing paths: none explicitly allowed by mode policy.");
  }
  if (writeDeny.length) {
    lines.push(`- Write denied for: ${backtickedList(writeDeny)}`);
  }
  if (policy.allowNewFiles === false) {
    lines.push("- New file creation: blocked.");
  } else if (createAllow.length) {
    lines.push(`- Creatable paths: ${backtickedList(createAllow)}`);
  } else {
    lines.push("- New file creation: allowed subject to workspace boundaries and tool policy.");
  }
  if (createDeny.length) {
    lines.push(`- Create denied for: ${backtickedList(createDeny)}`);
  }
  lines.push("- If a file/path is absent from the allowed write/create lists, do not attempt to modify it.");
  promptParts.push("Mode Permissions (agent-visible):", "", ...lines, "");
}

function summarizeShellRule(rule: { matchType: string; pattern: string; caseSensitive?: boolean }): string {
  const sensitivity = rule.caseSensitive === false ? " (case-insensitive)" : "";
  return `- ${rule.matchType}: \`${rule.pattern}\`${sensitivity}`;
}

function appendShellPolicy(promptParts: string[], input: AgentModeContextInput): void {
  const policy = input.shellInvocationPolicy;
  if (!policy) return;
  const allow = policy.allow ?? [];
  const disallow = policy.disallow ?? [];
  if (!allow.length && !disallow.length) return;
  const lines: string[] = [];
  lines.push("Shell command policy (enforced at runtime):");
  if (allow.length) {
    lines.push("- Allowed shell command shapes:");
    for (const rule of allow) lines.push(summarizeShellRule(rule));
  } else {
    lines.push("- Allowed shell command shapes: none explicitly allowlisted.");
  }
  if (disallow.length) {
    lines.push("- Explicitly blocked shell patterns:");
    for (const rule of disallow) lines.push(summarizeShellRule(rule));
  }
  promptParts.push("Shell Policy (agent-visible):", "", ...lines, "");
}

export function appendAgentModeContext(promptParts: string[], input: AgentModeContextInput): void {
  const currentMode = String(input.currentMode ?? "").trim();
  const allowedNextModes = (input.allowedNextModes ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
  const processOwnedProgression = Boolean(input.activeProcessState?.stageId || input.activeProcessState?.profileId);
  if (currentMode) {
    const modeContractJson = processOwnedProgression
      ? JSON.stringify(
          {
            worker_mode: currentMode,
            progression_owner: "supervisor",
          },
          null,
          2,
        )
      : buildModeContractJson({
          currentMode,
          allowedNextModes,
          modePayloadFieldsByMode: input.modePayloadFieldsByMode,
          modeGuidanceByMode: input.modeGuidanceByMode,
        });
    promptParts.push(
      processOwnedProgression ? "Worker Profile Contract (agent-visible):" : "Mode Contract (agent-visible):",
      "",
      modeContractJson,
      "",
      processOwnedProgression
        ? "Progression is supervisor-owned on this run. Do not use `switch_mode`. When this task packet is complete, blocked, or contradicted, use `report_process_result` so the supervisor can choose the next worker invocation."
        : "Use the `switch_mode` CLI only when you need to move to another mode. Choose `--target-mode` from `candidate_modes` and include a concise `--reason`.",
      "",
    );
  }
  appendModePermissions(promptParts, input);
  appendShellPolicy(promptParts, input);
  const availableTools = input.availableToolsMarkdown == null
    ? ""
    : String(input.availableToolsMarkdown).trim();
  if (availableTools) promptParts.push("Available tools (current mode):", "", availableTools, "");
}
