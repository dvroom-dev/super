import { concatPromptContent, promptContentFromText, type PromptContent } from "../../../utils/prompt_content.js";

export function buildSchemaRetryPrompt(prompt: PromptContent, schemaError: string, responseText: string): PromptContent {
  const guidance = [
    "Supervisor schema validation failed on your prior response.",
    "Return ONLY JSON that strictly matches the schema.",
    `Validation error: ${schemaError}`,
    "If a field expects an array, return an array even for one value.",
    "Previous invalid response:",
    "```json",
    responseText.slice(0, 8000),
    "```",
  ].join("\n");
  return concatPromptContent([prompt, promptContentFromText(guidance)], "\n\n");
}

export function looksLikeContextWindowError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("context window") ||
    normalized.includes("out of room") ||
    normalized.includes("context length") ||
    normalized.includes("maximum context")
  );
}
