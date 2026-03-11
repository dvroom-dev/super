import { parseChatMarkdown } from "../../../markdown/parse.js";
import type { StdioContext } from "./context.js";

export async function handleDocumentParse(_ctx: StdioContext, params: any) {
  const text = String((params as any)?.text ?? "");
  const parsed = parseChatMarkdown(text);
  const mode = String((params as any)?.mode ?? "");
  if (mode === "errors") {
    return { errors: parsed.errors };
  }
  return { blocks: parsed.blocks, errors: parsed.errors };
}
