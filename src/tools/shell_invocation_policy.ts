export type ShellInvocationMatchType = "exact_match" | "contains" | "regex";

export type ShellInvocationRule = {
  matchType: ShellInvocationMatchType;
  pattern: string;
  caseSensitive: boolean;
};

export type ShellInvocationPolicy = {
  allow?: ShellInvocationRule[];
  disallow?: ShellInvocationRule[];
};

function normalizeCase(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

export function matchesShellInvocationRule(args: {
  rule: ShellInvocationRule;
  commandText: string;
}): boolean {
  const commandText = String(args.commandText ?? "");
  const pattern = String(args.rule.pattern ?? "");
  if (!pattern) return false;
  if (args.rule.matchType === "regex") {
    try {
      const flags = args.rule.caseSensitive ? "" : "i";
      return new RegExp(pattern, flags).test(commandText);
    } catch {
      return false;
    }
  }
  const source = normalizeCase(commandText, args.rule.caseSensitive);
  const needle = normalizeCase(pattern, args.rule.caseSensitive);
  if (args.rule.matchType === "exact_match") return source === needle;
  return source.includes(needle);
}

export function findMatchingShellInvocationRule(args: {
  rules: ShellInvocationRule[] | undefined;
  commandText: string;
}): ShellInvocationRule | undefined {
  const rules = args.rules ?? [];
  for (const rule of rules) {
    if (matchesShellInvocationRule({ rule, commandText: args.commandText })) {
      return rule;
    }
  }
  return undefined;
}

export function shellInvocationPolicyViolation(args: {
  policy: ShellInvocationPolicy | undefined;
  commandText: string;
}): string | undefined {
  const commandText = String(args.commandText ?? "");
  if (!commandText.trim()) return undefined;
  const matchedAllow = findMatchingShellInvocationRule({
    rules: args.policy?.allow,
    commandText,
  });
  if ((args.policy?.allow?.length ?? 0) > 0 && !matchedAllow) {
    return "shell invocation blocked by tools.shell_invocation_policy.allow";
  }
  const matchedDeny = findMatchingShellInvocationRule({
    rules: args.policy?.disallow,
    commandText,
  });
  if (matchedDeny) {
    return shellInvocationBlockedError(matchedDeny);
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function commandFromArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(" ");
}

export function shellCommandFromShellToolArgs(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  return commandFromArray(record.cmd) ?? nonEmptyString(record.command) ?? "";
}

const COMMAND_KEYS = [
  "cmd",
  "command",
  "command_line",
  "commandLine",
  "script",
  "bash_command",
  "bashCommand",
] as const;

const NESTED_KEYS = [
  "input",
  "args",
  "arguments",
  "params",
  "parameters",
  "item",
  "request",
  "data",
  "tool_call",
  "toolCall",
] as const;

function extractShellCommandTextInner(value: unknown, seen: Set<unknown>, depth: number): string | undefined {
  if (depth > 4) return undefined;
  const asString = nonEmptyString(value);
  if (asString) return asString;
  const asArray = commandFromArray(value);
  if (asArray) return asArray;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;

  for (const key of COMMAND_KEYS) {
    const found = extractShellCommandTextInner(record[key], seen, depth + 1);
    if (found) return found;
  }
  for (const key of NESTED_KEYS) {
    const found = extractShellCommandTextInner(record[key], seen, depth + 1);
    if (found) return found;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (!key.toLowerCase().includes("command")) continue;
    const found = extractShellCommandTextInner(entry, seen, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function extractShellCommandText(value: unknown): string | undefined {
  return extractShellCommandTextInner(value, new Set<unknown>(), 0);
}

export function shellInvocationBlockedError(rule: ShellInvocationRule): string {
  return `shell invocation blocked by tools.shell_invocation_policy.disallow (${rule.matchType}: ${rule.pattern})`;
}
