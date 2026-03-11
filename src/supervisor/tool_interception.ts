export type ToolInterceptionWhen = "invocation" | "response";

export type ToolInterceptionTool = "bash" | "mcp";

export type ToolInterceptionMatchType = "exact_match" | "contains" | "regex";

export type ToolInterceptionAction =
  | {
      type: "runtime_switch_mode";
      targetMode: string;
      reason: string;
      modePayload?: Record<string, string>;
    }
  | {
      type: "supervisor_switch_mode";
      targetMode: string;
      reason: string;
      modePayload?: Record<string, string>;
    };

export type ToolInterceptionRule = {
  name?: string;
  when: ToolInterceptionWhen;
  tool: ToolInterceptionTool;
  matchType: ToolInterceptionMatchType;
  pattern: string;
  caseSensitive: boolean;
  action?: ToolInterceptionAction;
};

export type ToolInterceptionConfig = {
  rules: ToolInterceptionRule[];
};

export type ToolInterceptionMatch = {
  source: "inline" | "provider";
  when: ToolInterceptionWhen;
  tool: ToolInterceptionTool;
  rule: ToolInterceptionRule;
  toolName: string;
  toolCall: {
    name: string;
    argsJson: string;
    invocationText: string;
  };
  toolResponse?: {
    outputText: string;
  };
};

function normalizeCase(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

export function matchesToolInterceptionRule(args: {
  rule: ToolInterceptionRule;
  text: string;
}): boolean {
  const text = String(args.text ?? "");
  const pattern = String(args.rule.pattern ?? "");
  if (!pattern) return false;
  if (args.rule.matchType === "regex") {
    try {
      const flags = args.rule.caseSensitive ? "" : "i";
      return new RegExp(pattern, flags).test(text);
    } catch {
      return false;
    }
  }
  const source = normalizeCase(text, args.rule.caseSensitive);
  const needle = normalizeCase(pattern, args.rule.caseSensitive);
  if (args.rule.matchType === "exact_match") return source === needle;
  return source.includes(needle);
}

export function findFirstToolInterceptionRule(args: {
  rules: ToolInterceptionRule[] | undefined;
  when: ToolInterceptionWhen;
  tool: ToolInterceptionTool;
  text: string;
}): ToolInterceptionRule | undefined {
  const rules = Array.isArray(args.rules) ? args.rules : [];
  for (const rule of rules) {
    if (rule.when !== args.when) continue;
    if (rule.tool !== args.tool) continue;
    if (!matchesToolInterceptionRule({ rule, text: args.text })) continue;
    return rule;
  }
  return undefined;
}
