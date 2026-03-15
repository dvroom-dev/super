import { renderToolResult } from "../../../markdown/render.js";
import { newId } from "../../../utils/ids.js";
import type { renderRunConfig } from "../../../supervisor/run_config.js";
import type { RunConfigTools } from "../../../supervisor/run_config_tools.js";
import {
  appendChatMessage,
  applySupervisorTemplateFields,
  buildFreshModeDocument,
  frontmatterValue,
  mergeAgentRuleSet,
  modeTransitionAllowed,
  resolveModeConfig,
  updateFrontmatterField,
  updateFrontmatterModePayload,
} from "../supervisor/mode_runtime.js";
import type { BudgetState } from "../supervisor/agent_turn.js";
import type { InlineToolCall } from "../supervisor/inline_tools.js";
import type { RuntimeContext } from "./context.js";
import { refreshRenderedRunConfigForModeFork } from "./conversation_supervise_run_config_refresh.js";
import { buildSessionSystemPromptForMode } from "../supervisor/session_system_prompt.js";
import { updateFrontmatterForkId } from "../supervisor/fork_utils.js";

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
  ctx: RuntimeContext;
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
  providerName: "mock" | "codex" | "claude";
  currentModel: string;
  supervisorModel: string;
  currentSupervisorThreadId?: string;
  request: SwitchModeRequest;
  sourceLabel: "agent" | "supervisor";
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
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    out[key] = String(rawValue ?? "").trim();
  }
  return out;
}

function applyLegacyTopLevelSwitchModeCompatibility(args: {
  modePayload: Record<string, string>;
  requiredFields: string[];
}): Record<string, string> {
  const nextPayload = { ...args.modePayload };
  const requiredFields = args.requiredFields;
  if (
    requiredFields.length === 1 &&
    !nextPayload[requiredFields[0]] &&
    nextPayload.user_message
  ) {
    nextPayload[requiredFields[0]] = nextPayload.user_message;
    delete nextPayload.user_message;
  }
  return nextPayload;
}

function trimInlineText(text: string): string {
  return text.replace(/\r/g, "").trim();
}

export function validateSwitchModeHandoffText(args: {
  targetMode: string;
  text: string;
}): string | null {
  if (args.targetMode !== "explore_and_solve") return null;
  const text = trimInlineText(args.text);
  if (!text) return null;
  const directionalSteps = text.match(/\b(?:up|down|left|right)\s*(?:x|×)\s*\d+\b/gi) ?? [];
  const boundedRouteSignals = [
    /\bstop conditions?\b/i,
    /\bstop immediately\b/i,
    /\bhalt route\b/i,
    /\bwatch for\b/i,
    /\bnovel event\b/i,
    /\broute exhausted\b/i,
    /\broute (?:is )?exhausted\b/i,
    /\buntil (?:completion|a novel event|route exhausted|blocked)\b/i,
    /\bcompletion trigger\b/i,
    /\blevel transition\b/i,
    /\bstuck\b/i,
    /\bblocked\b/i,
  ];
  const mixedAgendaSignals = [
    /\bif confirmed\b/i,
    /\bafter this\b/i,
    /\bnext target\b/i,
    /\bthen (?:switch back|plan|begin)\b/i,
  ];
  if (directionalSteps.length >= 2 && mixedAgendaSignals.some((pattern) => pattern.test(text))) {
    return [
      "explore_and_solve handoff is invalid: mixed staged agendas are not allowed in the mode handoff.",
      "Use either one bounded route with an explicit stop condition, or one smaller probe target, but not a probe-plus-then-route script.",
    ].join(" ");
  }
  if (directionalSteps.length >= 2 && !boundedRouteSignals.some((pattern) => pattern.test(text))) {
    return [
      "explore_and_solve handoff is invalid: multi-action routes require an explicit stop condition.",
      "Name one bounded route target and say when to stop: completion, novel event, route exhausted, or blocked.",
    ].join(" ");
  }
  return null;
}

async function loadLatestForkInMode(args: {
  ctx: RuntimeContext;
  workspaceRoot: string;
  conversationId: string;
  mode: string;
}) {
  const idx = await args.ctx.store.loadIndex(args.workspaceRoot, args.conversationId);
  let fallback: any = undefined;
  for (let i = idx.forks.length - 1; i >= 0; i -= 1) {
    const forkSummary = idx.forks[i];
    const fork = await args.ctx.store.loadFork(args.workspaceRoot, args.conversationId, forkSummary.id);
    const forkMode = frontmatterValue(fork.documentText ?? "", "mode")?.trim() || "";
    if (forkMode !== args.mode) continue;
    if (fork.providerThreadId) return fork;
    if (!fallback) fallback = fork;
  }
  return fallback;
}

export function parseSwitchModeInlineCall(args: ParseSwitchModeInlineCallArgs): ParsedSwitchModeInlineOutcome {
  const normalizedName = String(args.call.name ?? "").trim().startsWith("mcp__super_custom_tools__")
    ? String(args.call.name ?? "").trim().slice("mcp__super_custom_tools__".length)
    : args.call.name;
  const toolName = normalizedName === "check_rules" ? "check_supervisor" : normalizedName;
  if (toolName !== "switch_mode") return { kind: "not_switch_mode" };
  if (args.call.source !== "runtime_provider") {
    // `switch_mode` should flow through the dedicated CLI/runtime path.
    // Ignore plain inline/custom-tool requests so the agent cannot fake a
    // mode transition inside the transcript.
    return { kind: "not_switch_mode" };
  }
  const targetMode = String(args.call.args?.target_mode ?? "").trim();
  const reason = String(args.call.args?.reason ?? "").trim();
  if (!targetMode) return errorOutcome("switch_mode requires args.target_mode");
  if (!reason) return errorOutcome("switch_mode requires args.reason");
  if (args.call.args?.terminal != null && args.call.args.terminal !== true) {
    return errorOutcome("switch_mode args.terminal, when provided, must be true");
  }
  const syntheticModePayload: Record<string, unknown> = {};
  if (args.call.args?.user_message != null) syntheticModePayload.user_message = args.call.args.user_message;
  const payload = normalizeSwitchModePayload(
    args.call.args?.mode_payload != null
      ? args.call.args.mode_payload
      : Object.keys(syntheticModePayload).length > 0
        ? syntheticModePayload
        : undefined,
  );
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
  const modePayload = applyLegacyTopLevelSwitchModeCompatibility({
    modePayload: {},
    requiredFields,
  });
  const normalizedRequestedPayload = applyLegacyTopLevelSwitchModeCompatibility({
    modePayload: args.request.modePayload,
    requiredFields,
  });
  const legacyTransitionKeys = ["wrapup_certified", "wrapup_level"].filter((key) =>
    Object.prototype.hasOwnProperty.call(normalizedRequestedPayload, key),
  );
  if (legacyTransitionKeys.length > 0) {
    return errorOutcome(
      [
        `switch_mode.mode_payload.${legacyTransitionKeys[0]} is no longer supported.`,
        "Release and other transition-scoped metadata must be set by the supervisor in transition_payload, not passed through switch_mode mode_payload.",
      ].join(" "),
    );
  }
  for (const [rawKey, rawValue] of Object.entries(normalizedRequestedPayload)) {
    const key = String(rawKey ?? "").trim();
    const value = String(rawValue ?? "").trim();
    if (!key) continue;
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
  const handoffValidationError = validateSwitchModeHandoffText({
    targetMode,
    text: seeded,
  });
  if (handoffValidationError) {
    return errorOutcome(handoffValidationError);
  }
  const nextModeRuleSet = mergeAgentRuleSet({
    requestRequirements: args.requestAgentRuleRequirements,
    configured: targetModeConfig.agentRules ?? effectiveRenderedRunConfig?.agentRules,
  });
  const targetModeFork = await loadLatestForkInMode({
    ctx: args.ctx,
    workspaceRoot: args.workspaceRoot,
    conversationId: args.conversationId,
    mode: targetMode,
  });
  const nextForkId = newId("fork");
  if (targetModeFork) {
    const resumedDoc = appendChatMessage(
      targetModeFork.documentText ?? "",
      "user",
      seeded,
    );
    const nextDoc = updateFrontmatterModePayload(updateFrontmatterField(
      updateFrontmatterForkId(resumedDoc, args.conversationId, nextForkId),
      "mode",
      targetMode,
    ), modePayload);
    const nextFork = await args.ctx.store.createFork({
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      parentId: targetModeFork.id,
      forkId: nextForkId,
      documentText: nextDoc,
      agentRules: targetModeFork.agentRules ?? nextModeRuleSet.requirements,
      providerName: args.providerName,
      model: args.currentModel,
      providerThreadId: targetModeFork.providerThreadId,
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
      params: { docPath: args.docPath, documentText: nextDoc, baseForkId: nextFork.id },
    });
    args.budget.cadenceAnchorAt = Date.now();
    args.budget.cadenceTokensAnchor = args.budget.adjustedTokensUsed;
    return {
      kind: "switched",
      docText: nextDoc,
      threadId: targetModeFork.providerThreadId,
      supervisorThreadId: args.currentSupervisorThreadId,
      fullResyncNeeded: true,
    };
  }
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
