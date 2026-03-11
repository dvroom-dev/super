import path from "node:path";

type SafeParseSuccess = { success: true; data: Record<string, unknown> };
type SafeParseFailure = {
  success: false;
  error: {
    message: string;
    issues: Array<{ path: Array<string | number>; message: string; code: string }>;
    errors: Array<{ path: Array<string | number>; message: string; code: string }>;
  };
};

export type ClaudeToolInputSchema = {
  type: "object";
  additionalProperties: true;
  properties: Record<string, unknown>;
  parse: (value: unknown) => Record<string, unknown>;
  parseAsync: (value: unknown) => Promise<Record<string, unknown>>;
  safeParse: (value: unknown) => SafeParseSuccess | SafeParseFailure;
  safeParseAsync: (value: unknown) => Promise<SafeParseSuccess | SafeParseFailure>;
};

export function makePermissiveToolInputSchema(): ClaudeToolInputSchema {
  const validate = (value: unknown): SafeParseSuccess | SafeParseFailure => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { success: true, data: value as Record<string, unknown> };
    }
    return {
      success: false,
      error: {
        message: "tool args must be a JSON object",
        issues: [{ path: [], message: "tool args must be a JSON object", code: "invalid_type" }],
        errors: [{ path: [], message: "tool args must be a JSON object", code: "invalid_type" }],
      },
    };
  };
  return {
    type: "object",
    additionalProperties: true,
    properties: {},
    parse: (value: unknown) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    parseAsync: async (value: unknown) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    safeParse: (value: unknown) => validate(value),
    safeParseAsync: async (value: unknown) => validate(value),
  };
}

export function makeSwitchModeToolInputSchema(): ClaudeToolInputSchema {
  const validate = (value: unknown): SafeParseSuccess | SafeParseFailure => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        success: false,
        error: {
          message: "switch_mode args must be a JSON object",
          issues: [{ path: [], message: "switch_mode args must be a JSON object", code: "invalid_type" }],
          errors: [{ path: [], message: "switch_mode args must be a JSON object", code: "invalid_type" }],
        },
      };
    }
    const record = value as Record<string, unknown>;
    const targetMode = typeof record.target_mode === "string" ? record.target_mode.trim() : "";
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    const terminal = record.terminal;
    const modePayload = record.mode_payload;
    const issues: Array<{ path: Array<string | number>; message: string; code: string }> = [];
    if (!targetMode) {
      issues.push({ path: ["target_mode"], message: "target_mode is required", code: "invalid_type" });
    }
    if (!reason) {
      issues.push({ path: ["reason"], message: "reason is required", code: "invalid_type" });
    }
    if (terminal != null && typeof terminal !== "boolean") {
      issues.push({ path: ["terminal"], message: "terminal must be a boolean", code: "invalid_type" });
    }
    if (modePayload != null && (typeof modePayload !== "object" || Array.isArray(modePayload))) {
      issues.push({ path: ["mode_payload"], message: "mode_payload must be an object", code: "invalid_type" });
    }
    if (modePayload && typeof modePayload === "object" && !Array.isArray(modePayload)) {
      for (const [key, rawValue] of Object.entries(modePayload as Record<string, unknown>)) {
        if (typeof rawValue !== "string") {
          issues.push({
            path: ["mode_payload", key],
            message: "mode_payload values must be strings",
            code: "invalid_type",
          });
        }
      }
    }
    if (issues.length > 0) {
      return {
        success: false,
        error: {
          message: issues.map((issue) => issue.message).join("; "),
          issues,
          errors: issues,
        },
      };
    }
    const normalized: Record<string, unknown> = {
      target_mode: targetMode,
      reason,
    };
    if (terminal != null) normalized.terminal = terminal;
    if (modePayload && typeof modePayload === "object" && !Array.isArray(modePayload)) {
      normalized.mode_payload = Object.fromEntries(
        Object.entries(modePayload as Record<string, unknown>).map(([key, rawValue]) => [key, String(rawValue)]),
      );
    }
    return { success: true, data: normalized };
  };
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      target_mode: { type: "string", description: "The target mode to switch into." },
      reason: { type: "string", description: "A concise reason for the mode transition." },
      mode_payload: {
        type: "object",
        description: "Optional mode-specific payload fields required by the target mode.",
      },
      terminal: { type: "boolean", description: "Set true to end the current turn after the mode switch request." },
    },
    parse: (value: unknown) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    parseAsync: async (value: unknown) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    safeParse: (value: unknown) => validate(value),
    safeParseAsync: async (value: unknown) => validate(value),
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function extractAssistantText(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type !== "text") continue;
    if (typeof block?.text === "string" && block.text.trim()) parts.push(block.text);
  }
  return parts.join("");
}

export function extractDeltaFromStreamEvent(event: any): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  if (typeof event?.delta === "string") return event.delta;
  if (typeof event?.delta?.text === "string") return event.delta.text;
  if (typeof event?.text === "string") return event.text;
  if (typeof event?.content_block?.text === "string") return event.content_block.text;
  return undefined;
}

export function extractResultText(result: any, fallback?: string): string | undefined {
  if (typeof result?.result === "string" && result.result.trim()) return result.result;
  if (typeof result?.structured_output === "string") return result.structured_output;
  if (result?.structured_output && typeof result.structured_output === "object") return JSON.stringify(result.structured_output);
  return fallback;
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const source = text.trim();
  if (!source) return undefined;
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // continue with embedded-object scan
  }
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        continue;
      }
      if (ch !== "}") continue;
      depth -= 1;
      if (depth !== 0) continue;
      const candidate = source.slice(start, i + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        break;
      }
      break;
    }
  }
  return undefined;
}

export function normalizeSchemaConstrainedResultText(result: any, fallback?: string): string | undefined {
  if (result?.structured_output && typeof result.structured_output === "object" && !Array.isArray(result.structured_output)) {
    return JSON.stringify(result.structured_output);
  }
  const source = extractResultText(result, fallback);
  if (typeof source !== "string") return source;
  const parsed = tryParseJsonObject(source);
  if (parsed) return JSON.stringify(parsed);
  const trimmed = source.trim();
  return trimmed || fallback;
}

export function extractUsage(result: any): Record<string, number> | undefined {
  const usage = result?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = asFiniteNumber(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = asFiniteNumber(usage.output_tokens ?? usage.outputTokens);
  const cachedInputTokens = asFiniteNumber(
    usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
  );
  const totalTokens = asFiniteNumber(usage.total_tokens ?? usage.totalTokens) ?? (
    inputTokens != null && outputTokens != null ? inputTokens + outputTokens : undefined
  );
  const out: Record<string, number> = {};
  if (inputTokens != null) out.input_tokens = Math.max(0, Math.floor(inputTokens));
  if (cachedInputTokens != null) out.cached_input_tokens = Math.max(0, Math.floor(cachedInputTokens));
  if (outputTokens != null) out.output_tokens = Math.max(0, Math.floor(outputTokens));
  if (totalTokens != null) out.total_tokens = Math.max(0, Math.floor(totalTokens));
  return Object.keys(out).length ? out : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asToolNameList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean) : [];
}

export function mimeTypeFromImagePath(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  throw new Error(`unsupported image extension for Claude prompt: ${imagePath}`);
}

export const looksLikeNetworkTool = (toolName: string): boolean => {
  const normalized = toolName.trim().toLowerCase();
  return normalized.includes("web") || normalized.includes("browser") || normalized.includes("fetch") || normalized.includes("http") || normalized.includes("search");
};
