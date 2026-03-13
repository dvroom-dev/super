export type InlineToolCall = {
  name: string;
  body: string;
  args: any;
  source?: "inline" | "runtime_provider";
};

function parseSwitchModeXmlBlocks(text: string): InlineToolCall[] | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed.includes("<switch_mode>")) return null;
  const re = /<switch_mode>([\s\S]*?)<\/switch_mode>/g;
  const calls: InlineToolCall[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed))) {
    const block = match[1] ?? "";
    const extract = (tag: string): string => {
      const tagRe = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
      const tagMatch = block.match(tagRe);
      return tagMatch?.[1]?.trim() ?? "";
    };
    const targetMode = extract("target_mode");
    const reason = extract("reason");
    const modePayloadRaw = extract("mode_payload");
    const terminalRaw = extract("terminal");
    if (!targetMode || !reason) continue;
    let modePayload: Record<string, unknown> = {};
    if (modePayloadRaw) {
      try {
        const parsed = JSON.parse(modePayloadRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          modePayload = parsed as Record<string, unknown>;
        }
      } catch {
        modePayload = { _raw: modePayloadRaw };
      }
    }
    const args: Record<string, unknown> = {
      target_mode: targetMode,
      reason,
    };
    if (Object.keys(modePayload).length > 0) args.mode_payload = modePayload;
    if (terminalRaw) args.terminal = terminalRaw.toLowerCase() === "true";
    calls.push({
      name: "switch_mode",
      body: JSON.stringify(args, null, 2),
      args,
      source: "inline",
    });
  }
  return calls.length ? calls : null;
}

export function extractInlineToolCalls(text: string): InlineToolCall[] | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("```tool_call")) {
    return parseSwitchModeXmlBlocks(trimmed);
  }
  const re = /```tool_call\s+name=([^\s]+)[^\n]*\n([\s\S]*?)\n```/g;
  const calls: InlineToolCall[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed))) {
    if (match.index > lastIndex) {
      const between = trimmed.slice(lastIndex, match.index).trim();
      if (between) return null;
    }
    const name = match[1];
    const body = match[2] ?? "";
    let args: any = {};
    try {
      args = body.trim() ? JSON.parse(body) : {};
    } catch {
      args = { _raw: body };
    }
    calls.push({ name, body, args, source: "inline" });
    lastIndex = re.lastIndex;
  }
  if (trimmed.slice(lastIndex).trim()) return null;
  return calls.length ? calls : null;
}
