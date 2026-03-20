import { executeTool } from "../../../tools/tools.js";
import type { RenderedRunConfig } from "../../../supervisor/run_config.js";

export type ValidatorResult = {
  key: string;
  ok: boolean;
  summary: string;
  outputText: string;
};

function readJsonField(payload: unknown, field: string): unknown {
  const parts = String(field ?? "").split(".").filter(Boolean);
  let current: unknown = payload;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function cwdForScope(workspaceRoot: string, args: { agentWorkspaceRoot: string; supervisorWorkspaceRoot: string }, scope?: string): string {
  if (scope === "agent") return args.agentWorkspaceRoot;
  if (scope === "supervisor") return args.supervisorWorkspaceRoot;
  return workspaceRoot;
}

export async function runConfiguredValidators(args: {
  workspaceRoot: string;
  agentWorkspaceRoot: string;
  supervisorWorkspaceRoot: string;
  renderedRunConfig: RenderedRunConfig | null;
  validatorKeys: string[];
}): Promise<ValidatorResult[]> {
  const results: ValidatorResult[] = [];
  for (const key of args.validatorKeys) {
    const validator = args.renderedRunConfig?.validators?.[key];
    if (!validator) continue;
    const output = await executeTool(
      args.workspaceRoot,
      { name: "shell", args: { cmd: ["zsh", "-lc", validator.command], cwd: cwdForScope(args.workspaceRoot, args, validator.cwdScope) } },
    );
    const outputText = String(output.output ?? "").trim();
    let ok = Number(output.exitCode ?? 0) === 0;
    if (validator.success?.type === "json_field_truthy") {
      try {
        ok = Boolean(readJsonField(JSON.parse(outputText || "{}"), validator.success.field));
      } catch {
        ok = false;
      }
    } else if (validator.success?.type === "json_field_equals") {
      try {
        ok = readJsonField(JSON.parse(outputText || "{}"), validator.success.field) === validator.success.equals;
      } catch {
        ok = false;
      }
    } else if (validator.success?.type === "text_contains") {
      ok = outputText.includes(validator.success.contains);
    } else if (validator.success?.type === "text_not_contains") {
      ok = !outputText.includes(validator.success.contains);
    } else if (validator.success?.type === "exit_code") {
      ok = Number(output.exitCode ?? 0) === Number(validator.success.equals ?? 0);
    }
    results.push({
      key,
      ok,
      summary: ok
        ? `validator ${key} passed`
        : `validator ${key} failed`,
      outputText,
    });
  }
  return results;
}

export function buildValidatorFailureUserMessage(results: ValidatorResult[]): string {
  const failures = results.filter((entry) => !entry.ok);
  if (failures.length === 0) return "";
  const lines = [
    "Post-turn validator failures:",
    "",
    ...failures.flatMap((entry) => [
      `Validator: ${entry.key}`,
      `Summary: ${entry.summary}`,
      entry.outputText ? "Output:" : "",
      entry.outputText ? "```text" : "",
      entry.outputText || "",
      entry.outputText ? "```" : "",
      "",
    ]),
    "Do not advance the process yet. Resolve these validator failures first.",
  ];
  return lines.filter(Boolean).join("\n");
}
