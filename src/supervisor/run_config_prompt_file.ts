import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  normalizeUserMessage,
  type RunConfigUserMessage,
  type RenderedRunConfigUserMessage,
} from "./run_config.js";
import { renderUserMessage, type RenderScopeRoots } from "./run_config_render.js";
import { interpolateRunConfigVariables } from "./run_config_vars.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolvePromptFileRaw(parsed: unknown): unknown {
  const obj = asRecord(parsed);
  if (!obj) return parsed;
  const agentObj = asRecord(obj.agent);
  if (agentObj?.user_message != null) {
    return agentObj.user_message;
  }
  if (obj.operation != null || obj.parts != null) {
    return obj;
  }
  return parsed;
}

export type PromptFileInterpolationOptions = {
  inheritedVars?: Record<string, string>;
  overrideVars?: Record<string, string>;
};

export async function loadPromptFile(
  promptFilePath: string,
  options?: PromptFileInterpolationOptions,
): Promise<RunConfigUserMessage> {
  const resolved = path.resolve(promptFilePath);
  const raw = await fs.readFile(resolved, "utf8");
  const parsed = YAML.parse(raw) as unknown;
  const interpolated = interpolateRunConfigVariables({
    raw: parsed,
    sourcePath: resolved,
    inheritedVars: options?.inheritedVars,
    overrideVars: options?.overrideVars,
  });
  const promptRaw = resolvePromptFileRaw(interpolated.value);
  const user = normalizeUserMessage(promptRaw, resolved);
  if (user) return user;
  throw new Error(`${resolved}: prompt file must define agent.user_message or a message object with operation`);
}

export async function renderPromptFile(
  promptFilePath: string,
  roots?: RenderScopeRoots,
  options?: PromptFileInterpolationOptions,
): Promise<RenderedRunConfigUserMessage> {
  const loaded = await loadPromptFile(promptFilePath, options);
  const rendered = await renderUserMessage(loaded, undefined, roots);
  if (!rendered) {
    return { operation: loaded.operation, text: "", content: [] };
  }
  return rendered;
}
