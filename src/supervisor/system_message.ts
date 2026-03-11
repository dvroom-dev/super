import {
  BASE_PROMPT,
  PROMPT_WITH_APPLY_PATCH,
  GPT_5_1_PROMPT,
  GPT_5_2_PROMPT,
  GPT_5_2_CODEX_PROMPT,
} from "./system_messages.js";
import type { ProviderName } from "../providers/types.js";

type SystemMessageSelection = {
  message: string;
  source: string;
};

function normalizeModel(model?: string): string {
  return (model ?? "").trim().toLowerCase();
}

function modelSupportsApplyPatch(model?: string): boolean {
  const m = normalizeModel(model);
  if (!m) return false;
  return (
    m.startsWith("gpt-5") ||
    m.startsWith("gpt-4o") ||
    m.startsWith("gpt-4.1") ||
    m.startsWith("o3") ||
    m.startsWith("o4-mini") ||
    m.startsWith("codex-mini-latest")
  );
}

export function systemMessageForModel(model?: string): SystemMessageSelection {
  const m = normalizeModel(model);
  if (!m) {
    return { message: GPT_5_2_CODEX_PROMPT, source: "gpt-5.2-codex_prompt.md" };
  }
  if (
    m.startsWith("gpt-5.3-codex") ||
    m.startsWith("gpt-5.2-codex") ||
    m.startsWith("exp-codex") ||
    m.startsWith("codex-1p") ||
    m.startsWith("bengalfox")
  ) {
    return { message: GPT_5_2_CODEX_PROMPT, source: "gpt-5.2-codex_prompt.md" };
  }
  if (m.startsWith("gpt-5.3") || m.startsWith("gpt-5.2") || m.startsWith("boomslang")) {
    return { message: GPT_5_2_PROMPT, source: "gpt_5_2_prompt.md" };
  }
  if (m.startsWith("gpt-5.1")) {
    return { message: GPT_5_1_PROMPT, source: "gpt_5_1_prompt.md" };
  }
  if (modelSupportsApplyPatch(model)) {
    return { message: PROMPT_WITH_APPLY_PATCH, source: "prompt_with_apply_patch_instructions.md" };
  }
  return { message: BASE_PROMPT, source: "prompt.md" };
}

export function systemMessageForProvider(
  provider?: ProviderName,
  model?: string,
): SystemMessageSelection {
  const normalizedProvider = (provider ?? "").trim().toLowerCase();
  if (normalizedProvider === "codex") {
    return systemMessageForModel(model);
  }
  if (normalizedProvider === "claude") {
    return { message: "", source: "claude_provider_base" };
  }
  if (normalizedProvider === "gemini") {
    return { message: "", source: "gemini_provider_base" };
  }
  if (normalizedProvider === "mock") {
    return systemMessageForModel(model);
  }
  return systemMessageForModel(model);
}
