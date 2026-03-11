import { promises as fs } from "node:fs";
import { mimeTypeFromImagePath } from "./claude_provider_helpers.js";
import { promptContentToPlainText, type PromptContent } from "../utils/prompt_content.js";

export async function buildClaudeSdkUserMessage(
  prompt: PromptContent,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const text = promptContentToPlainText(prompt);
  const content: any[] = [];
  if (text) {
    content.push({ type: "text", text });
  }
  for (const part of prompt) {
    if (part.type !== "image") continue;
    const base64 = await fs.readFile(part.path, "base64");
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeTypeFromImagePath(part.path),
        data: base64,
      },
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  if (content.length === 1 && content[0]?.type === "text") {
    return {
      type: "user",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: content[0].text,
      },
    };
  }
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content,
    },
  };
}
