import { renderToolResult } from "../../../markdown/render.js";
import { isToolAllowedByPolicy } from "../../../tools/definitions.js";
import { newId } from "../../../utils/ids.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { RunConfigTools } from "../../../supervisor/run_config_tools.js";
import {
  applySupervisorTemplateFields,
  buildFreshModeDocument,
  mergeAgentRuleSet,
  modeTransitionAllowed,
  resolveModeConfig,
} from "../supervisor/mode_runtime.js";
import type { BudgetState } from "../supervisor/agent_turn.js";
import type { InlineToolCall } from "../supervisor/inline_tools.js";
import type { StdioContext } from "./context.js";
import { refreshRenderedRunConfigForModeFork } from "./conversation_supervise_run_config_refresh.js";
import { buildSessionSystemPromptForMode } from "../supervisor/session_system_prompt.js";

type RenderedRunConfig = Awaited<ReturnType<typeof renderRunConfig>>;

export type SwitchModeRequest = {
  targetMode: string;
  reason: string;
  modePayload: Record<string, string>;
  terminal: boolean;
};

type ParseSwitchModeInlineCallArgs = {
  call: InlineToolCall;
  toolConfig?: RunConfigTools;
};

type ApplySwitchModeRequestForkArgs = {
  ctx: StdioContext;
  workspaceRoot: string;
  docPath: string;
  conversationId: string;
  activeForkId: string;
  switchActiveFork: (nextForkId: string) => void;
  renderedRunConfig: RenderedRunConfig | null;
  requestAgentRuleRequirements: string[];
  activeMode: string;
  allowedNextModes: string[];
  modePayloadFieldsByMode: Record<string, string[]>;
  runConfigPath?: string;
  configBaseDir: string;
  agentBaseDir: string;
  supervisorBaseDir: string;
  budget: BudgetState;
  providerName: "mock" | "codex" | "claude" | "gemini";
  currentModel: string;
  supervisorModel: string;
  currentSupervisorThreadId?: string;
  request: SwitchModeRequest;
  sourceLabel: "agent" | "supervisor";
};

type ApplyInferredSwitchModeRequestForkArgs = Omit<ApplySwitchModeRequestForkArgs, "request"> & {
  assistantText: string;
};

export type ParsedSwitchModeInlineOutcome =
  | { kind: "not_switch_mode" }
  | { kind: "error"; markdown: string }
  | { kind: "request"; request: SwitchModeRequest };

type SwitchModeRequestForkOutcome =
  | { kind: "error"; markdown: string }
  | {
      kind: "switched";
      docText: string;
      threadId?: string;
      supervisorThreadId?: string;
      fullResyncNeeded: boolean;
    };

type SwitchModeErrorOutcome = { kind: "error"; markdown: string };

function errorOutcome(message: string): SwitchModeErrorOutcome {
  return {
    kind: "error",
    markdown: renderToolResult(["(ok=false)", "", "[error]", String(message ?? "").trim()].join("\n")),
  };
}

function normalizeSwitchModePayload(raw: unknown): Record<string, string> | null {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    out[key] = String(rawValue ?? "").trim();
  }
  return out;
}

function trimInlineText(text: string): string {
  return text.replace(/\r/g, "").trim();
}

export function inferSwitchModeRequestFromAssistantText(text: string): SwitchModeRequest | null {
  const source = trimInlineText(text);
  if (!source) return null;
  const explicitTargetPatterns = [
    /\*\*Switch target\*\*:\s*`?([a-z_][a-z0-9_]*)`?/i,
    /Switch target:\s*`?([a-z_][a-z0-9_]*)`?/i,
  ];
  for (const pattern of explicitTargetPatterns) {
    const direct = source.match(pattern);
    const targetMode = String(direct?.[1] ?? "").trim();
    if (targetMode) {
      const reasonMatch =
        source.match(/\*\*Reason\*\*:\s*([\s\S]*?)(?:\n\s*\n|$)/i) ??
        source.match(/Reason:\s*([\s\S]*?)(?:\n\s*\n|$)/i);
      const handoffMatch =
        source.match(/\*\*Handoff(?:[^:]*)\*\*:\s*([\s\S]*?)(?:\n\s*\n|$)/i) ??
        source.match(/Handoff(?:[^:]*):\s*([\s\S]*?)(?:\n\s*\n|$)/i);
      const reason =
        trimInlineText(reasonMatch?.[1] ?? "") ||
        trimInlineText(handoffMatch?.[1] ?? "") ||
        `assistant requested switch to ${targetMode} in visible handoff text`;
      return {
        targetMode,
        reason,
        modePayload: {},
        terminal: true,
      };
    }
  }
  const pattern = /switch(?:ing)?(?:\s+back)?\s+to\s+`?([a-z_][a-z0-9_]*)`?(?:\s+mode)?/gi;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    lastMatch = match;
  }
  const targetMode = String(lastMatch?.[1] ?? "").trim();
  if (!targetMode) return null;

  const handoffPattern = new RegExp(
    String.raw`(?:\*\*Handoff to ${targetMode}:\*\*|Handoff to ${targetMode}:)\s*([\s\S]*?)(?:\n\s*\n|$)`,
    "i",
  );
  const handoffMatch = source.match(handoffPattern);
  const reason =
    trimInlineText(handoffMatch?.[1] ?? "") ||
    `assistant requested switch to ${targetMode} in visible handoff text`;
  if (!reason) return null;

  return {
    targetMode,
    reason,
    modePayload: {},
    terminal: true,
  };
}

export function parseSwitchModeInlineCall(args: ParseSwitchModeInlineCallArgs): ParsedSwitchModeInlineOutcome {
  const normalizedName = String(args.call.name ?? "").trim().startsWith("mcp__super_custom_tools__")
    ? String(args.call.name ?? "").trim().slice("mcp__super_custom_tools__".length)
    : args.call.name;
  const toolName = normalizedName === "check_rules" ? "check_supervisor" : normalizedName;
  if (toolName !== "switch_mode") return { kind: "not_switch_mode" };

  if (!isToolAllowedByPolicy(args.toolConfig?.builtinPolicy, "switch_mode")) {
    return errorOutcome("Tool disabled by config: switch_mode");
  }
  const targetMode = String(args.call.args?.target_mode ?? "").trim();
  const reason = String(args.call.args?.reason ?? "").trim();
  if (!targetMode) return errorOutcome("switch_mode requires args.target_mode");
  if (!reason) return errorOutcome("switch_mode requires args.reason");
  if (args.call.args?.terminal != null && args.call.args.terminal !== true) {
    return errorOutcome("switch_mode args.terminal, when provided, must be true");
  }
  const payload = normalizeSwitchModePayload(args.call.args?.mode_payload);
  if (!payload) {
    return errorOutcome("switch_mode.mode_payload must be an object");
  }
  return {
    kind: "request",
    request: {
      targetMode,
      reason,
      modePayload: payload,
      terminal: true,
    },
  };
}

export async function applySwitchModeRequestFork(
  args: ApplySwitchModeRequestForkArgs,
): Promise<SwitchModeRequestForkOutcome> {
  const refreshedRunConfig = await refreshRenderedRunConfigForModeFork({
    workspaceRoot: args.workspaceRoot,
    runConfigPath: args.runConfigPath,
    configBaseDir: args.configBaseDir,
    agentBaseDir: args.agentBaseDir,
    supervisorBaseDir: args.supervisorBaseDir,
  });
  const effectiveRenderedRunConfig = refreshedRunConfig ?? args.renderedRunConfig;
  const targetMode = args.request.targetMode;
  const targetModeConfig = resolveModeConfig(effectiveRenderedRunConfig, targetMode);
  if (!targetModeConfig) return errorOutcome(`switch_mode target_mode '${targetMode}' is unknown`);
  if (!args.allowedNextModes.includes(targetMode)) {
    return errorOutcome(
      `switch_mode target_mode '${targetMode}' is not an allowed transition from '${args.activeMode}'`,
    );
  }
  if (!modeTransitionAllowed({ config: effectiveRenderedRunConfig, fromMode: args.activeMode, toMode: targetMode })) {
    return errorOutcome(`switch_mode target_mode '${targetMode}' is not allowed from '${args.activeMode}'`);
  }

  const requiredFields = args.modePayloadFieldsByMode[targetMode] ?? [];
  const modePayload: Record<string, string> = {};
  const allowedFields = new Set(requiredFields);
  for (const [rawKey, rawValue] of Object.entries(args.request.modePayload)) {
    const key = String(rawKey ?? "").trim();
    const value = String(rawValue ?? "").trim();
    if (!key) continue;
    if (!allowedFields.has(key)) {
      return errorOutcome(`switch_mode.mode_payload.${key} is not allowed for mode '${targetMode}'`);
    }
    if (!value) return errorOutcome(`switch_mode.mode_payload.${key} must be a non-empty string`);
    modePayload[key] = value;
  }
  for (const field of requiredFields) {
    if (modePayload[field]) continue;
    return errorOutcome(`switch_mode.mode_payload.${field} is required`);
  }

  const seeded = applySupervisorTemplateFields(targetModeConfig.userMessage?.text?.trim() ?? "", modePayload);
  if (!seeded.trim()) {
    return errorOutcome(`switch_mode requires modes.${targetMode}.user_message to render non-empty text`);
  }
  const nextModeRuleSet = mergeAgentRuleSet({
    requestRequirements: args.requestAgentRuleRequirements,
    configured: targetModeConfig.agentRules ?? effectiveRenderedRunConfig?.agentRules,
  });
  const nextForkId = newId("fork");
  const forkDoc = buildFreshModeDocument({
    conversationId: args.conversationId,
    forkId: nextForkId,
    mode: targetMode,
    systemMessage: buildSessionSystemPromptForMode({
      renderedRunConfig: effectiveRenderedRunConfig,
      mode: targetMode,
      modePayload,
      provider: args.providerName,
      model: args.currentModel,
      agentRules: nextModeRuleSet.requirements,
    }),
    userMessage: seeded,
    modePayload,
    agentRuleRequirements: nextModeRuleSet.requirements,
    agentRuleViolations: nextModeRuleSet.violations,
  });
  const nextFork = await args.ctx.store.createFork({
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    parentId: args.activeForkId,
    forkId: nextForkId,
    documentText: forkDoc,
    agentRules: nextModeRuleSet.requirements,
    providerName: args.providerName,
    model: args.currentModel,
    providerThreadId: undefined,
    supervisorThreadId: args.currentSupervisorThreadId,
    actionSummary: `${args.sourceLabel}:switch_mode ${args.activeMode}->${targetMode}`,
    forkSummary: `${args.sourceLabel} switch_mode: ${args.activeMode} -> ${targetMode}`,
    agentModel: args.currentModel,
    supervisorModel: args.supervisorModel,
  });
  args.ctx.sendNotification({
    method: "fork.created",
    params: { conversationId: args.conversationId, forkId: nextFork.id, headId: nextFork.id },
  });
  args.switchActiveFork(nextFork.id);
  args.ctx.sendNotification({
    method: "conversation.replace",
    params: { docPath: args.docPath, documentText: forkDoc, baseForkId: nextFork.id },
  });
  args.budget.cadenceAnchorAt = Date.now();
  args.budget.cadenceTokensAnchor = args.budget.adjustedTokensUsed;
  return {
    kind: "switched",
    docText: forkDoc,
    threadId: undefined,
    supervisorThreadId: args.currentSupervisorThreadId,
    fullResyncNeeded: true,
  };
}

export async function applyInferredSwitchModeRequestFork(
  args: ApplyInferredSwitchModeRequestForkArgs,
): Promise<SwitchModeRequestForkOutcome | undefined> {
  const request = inferSwitchModeRequestFromAssistantText(args.assistantText);
  if (!request) return undefined;
  return applySwitchModeRequestFork({
    ...args,
    request,
  });
}
