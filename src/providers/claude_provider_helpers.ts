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
  const normalizeModePayload = (
    raw: unknown,
  ):
    | { ok: true; value: Record<string, string> | undefined }
    | { ok: false; issue: { path: Array<string | number>; message: string; code: string } } => {
    if (raw == null) return { ok: true, value: undefined };
    let value = raw;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return { ok: true, value: undefined };
      try {
        value = JSON.parse(trimmed);
      } catch {
        return {
          ok: false,
          issue: { path: ["mode_payload"], message: "mode_payload string must contain a JSON object", code: "invalid_type" },
        };
      }
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        issue: { path: ["mode_payload"], message: "mode_payload must be an object", code: "invalid_type" },
      };
    }
    const out: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof rawValue !== "string") {
        return {
          ok: false,
          issue: {
            path: ["mode_payload", key],
            message: "mode_payload values must be strings",
            code: "invalid_type",
          },
        };
      }
      out[key] = rawValue;
    }
    return { ok: true, value: out };
  };

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
    const syntheticModePayload: Record<string, unknown> = {};
    if (record.user_message != null) syntheticModePayload.user_message = String(record.user_message);
    const modePayload = normalizeModePayload(
      record.mode_payload != null
        ? record.mode_payload
        : Object.keys(syntheticModePayload).length > 0
          ? syntheticModePayload
          : undefined,
    );
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
    if (record.user_message != null && typeof record.user_message !== "string") {
      issues.push({ path: ["user_message"], message: "user_message must be a string", code: "invalid_type" });
    }
    if (!modePayload.ok) {
      issues.push(modePayload.issue);
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
    if (modePayload.ok && modePayload.value) {
      normalized.mode_payload = modePayload.value;
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
        description:
          "Optional mode-specific payload fields required by the target mode. Provide a JSON object; a JSON-stringified object is also accepted.",
      },
      user_message: { type: "string", description: "Common handoff text for the target mode." },
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

export function makeCheckSupervisorToolInputSchema(): ClaudeToolInputSchema {
  const validate = (value: unknown): SafeParseSuccess | SafeParseFailure => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        success: false,
        error: {
          message: "check_supervisor args must be a JSON object",
          issues: [{ path: [], message: "check_supervisor args must be a JSON object", code: "invalid_type" }],
          errors: [{ path: [], message: "check_supervisor args must be a JSON object", code: "invalid_type" }],
        },
      };
    }
    const record = value as Record<string, unknown>;
    const mode = record.mode == null ? undefined : String(record.mode).trim();
    if (mode && mode !== "hard" && mode !== "soft") {
      const issue = { path: ["mode"] as Array<string | number>, message: "mode must be hard or soft", code: "invalid_type" };
      return {
        success: false,
        error: {
          message: issue.message,
          issues: [issue],
          errors: [issue],
        },
      };
    }
    return { success: true, data: mode ? { mode } : {} };
  };
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      mode: { type: "string", description: "Optional supervisor review mode: hard or soft." },
    },
    parse: (value) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    parseAsync: async (value) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    safeParse: (value) => validate(value),
    safeParseAsync: async (value) => validate(value),
  };
}

export function makeReportProcessResultToolInputSchema(): ClaudeToolInputSchema {
  const validate = (value: unknown): SafeParseSuccess | SafeParseFailure => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        success: false,
        error: {
          message: "report_process_result args must be a JSON object",
          issues: [{ path: [], message: "report_process_result args must be a JSON object", code: "invalid_type" }],
          errors: [{ path: [], message: "report_process_result args must be a JSON object", code: "invalid_type" }],
        },
      };
    }
    const record = value as Record<string, unknown>;
    const outcome = typeof record.outcome === "string" ? record.outcome.trim() : "";
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    const optionalStringKeys = ["evidence", "blocker", "requested_profile", "user_message"] as const;
    const issues: Array<{ path: Array<string | number>; message: string; code: string }> = [];
    if (!outcome) issues.push({ path: ["outcome"], message: "outcome is required", code: "invalid_type" });
    if (!summary) issues.push({ path: ["summary"], message: "summary is required", code: "invalid_type" });
    for (const key of optionalStringKeys) {
      const raw = record[key];
      if (raw == null) continue;
      if (typeof raw !== "string" || !raw.trim()) {
        issues.push({ path: [key], message: `${key} must be a non-empty string when provided`, code: "invalid_type" });
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
    const normalized: Record<string, unknown> = { outcome, summary };
    for (const key of optionalStringKeys) {
      const raw = record[key];
      if (typeof raw === "string" && raw.trim()) normalized[key] = raw.trim();
    }
    return { success: true, data: normalized };
  };
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      outcome: { type: "string", description: "Worker result classification, for example complete, blocked, or contradicted." },
      summary: { type: "string", description: "Short summary of what was learned or completed." },
      evidence: { type: "string", description: "Concrete supporting evidence for the reported outcome." },
      blocker: { type: "string", description: "Exact blocker if the task packet is blocked." },
      requested_profile: { type: "string", description: "Optional requested next task profile for supervisor consideration." },
      user_message: { type: "string", description: "Optional concise handoff message for the next worker." },
    },
    parse: (value) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    parseAsync: async (value) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    safeParse: (value) => validate(value),
    safeParseAsync: async (value) => validate(value),
  };
}

export function makeCertifyWrapupToolInputSchema(): ClaudeToolInputSchema {
  const validate = (value: unknown): SafeParseSuccess | SafeParseFailure => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        success: false,
        error: {
          message: "certify_wrapup args must be a JSON object",
          issues: [{ path: [], message: "certify_wrapup args must be a JSON object", code: "invalid_type" }],
          errors: [{ path: [], message: "certify_wrapup args must be a JSON object", code: "invalid_type" }],
        },
      };
    }
    const record = value as Record<string, unknown>;
    const wrapupLevel = Number(record.wrapup_level);
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    const issues: Array<{ path: Array<string | number>; message: string; code: string }> = [];
    if (!Number.isFinite(wrapupLevel) || wrapupLevel <= 0) {
      issues.push({ path: ["wrapup_level"], message: "wrapup_level must be a positive number", code: "invalid_type" });
    }
    if (!reason) {
      issues.push({ path: ["reason"], message: "reason is required", code: "invalid_type" });
    }
    if (record.user_message != null && (typeof record.user_message !== "string" || !String(record.user_message).trim())) {
      issues.push({ path: ["user_message"], message: "user_message must be a non-empty string when provided", code: "invalid_type" });
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
    const normalized: Record<string, unknown> = { wrapup_level: Math.floor(wrapupLevel), reason };
    if (typeof record.user_message === "string" && record.user_message.trim()) normalized.user_message = record.user_message.trim();
    return { success: true, data: normalized };
  };
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      wrapup_level: { type: "number", description: "Solved level awaiting wrap-up certification." },
      reason: { type: "string", description: "Why wrap-up is ready for certification." },
      user_message: { type: "string", description: "Optional concise handoff for the next worker after certification." },
    },
    parse: (value) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    parseAsync: async (value) => {
      const out = validate(value);
      if (out.success) return out.data;
      throw new Error(out.error.message);
    },
    safeParse: (value) => validate(value),
    safeParseAsync: async (value) => validate(value),
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
