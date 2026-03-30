import path from "node:path";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { appendEvidence } from "./evidence.js";
import { formatSeedBundleForPrompt } from "./json_session_format.js";
import { runFluxProblemCommand } from "./problem_shell.js";
import { enqueueFluxQueueItem } from "./queue.js";
import { loadFluxPromptTemplate } from "./prompt_templates.js";
import { runFluxProviderTurn } from "./provider_session.js";
import { appendFluxMessage, saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxQueueItem, FluxRunState, FluxSeedBundle, FluxSessionRecord } from "./types.js";
import { loadFluxState, saveFluxState } from "./state.js";

function nowIso(): string {
  return new Date().toISOString();
}

function buildInitialSolverPrompt(args: {
  template: string;
  instancePromptText?: string;
  seedBundle?: FluxSeedBundle | null;
}): string {
  const parts = [args.template.trim()];
  if (args.seedBundle) parts.push(formatSeedBundleForPrompt(args.seedBundle));
  if (args.instancePromptText) parts.push(args.instancePromptText.trim());
  return parts.filter(Boolean).join("\n\n");
}

export async function runSolverQueueItem(args: {
  workspaceRoot: string;
  config: FluxConfig;
  queueItem: FluxQueueItem;
  state: FluxRunState;
  signal?: AbortSignal;
}): Promise<void> {
  const attemptId = newId("attempt");
  const provisioned = await runFluxProblemCommand(args.config.problem.provisionInstance, {
    workspaceRoot: args.workspaceRoot,
    queueItem: args.queueItem,
    attemptId,
  });
  const instanceId = String(provisioned.instance_id ?? newId("instance"));
  const workingDirectory = path.resolve(args.workspaceRoot, String(provisioned.working_directory ?? args.workspaceRoot));
  const sessionId = `solver_${attemptId}`;
  const startingState = await loadFluxState(args.workspaceRoot, args.config) ?? args.state;
  startingState.active.solver = {
    sessionId,
    status: "running",
    queueItemId: args.queueItem.id,
    pid: process.pid,
    attemptId,
    instanceId,
    updatedAt: nowIso(),
  };
  await saveFluxState(args.workspaceRoot, args.config, startingState);
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "solver.instance_provisioned",
    workspaceRoot: args.workspaceRoot,
    sessionType: "solver",
    sessionId,
    queueItemId: args.queueItem.id,
    summary: `solver instance provisioned: ${instanceId}`,
    payload: { attemptId, instanceId, workingDirectory },
  }]);

  const session: FluxSessionRecord = {
    sessionId,
    sessionType: "solver",
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    provider: args.config.solver.provider ?? args.config.runtimeDefaults.provider,
    model: args.config.solver.model ?? args.config.runtimeDefaults.model,
    resumePolicy: "never",
    sessionScope: "per_attempt",
    activeAttemptId: attemptId,
  };
  await saveFluxSession(args.workspaceRoot, args.config, session);

  const promptTemplate = await loadFluxPromptTemplate(args.workspaceRoot, args.config.solver.promptFile);
  const seedBundle = args.queueItem.payload.seedBundle as FluxSeedBundle | undefined;
  const promptText = buildInitialSolverPrompt({
    template: promptTemplate,
    seedBundle: seedBundle ?? null,
    instancePromptText: typeof provisioned.prompt_text === "string" ? String(provisioned.prompt_text) : undefined,
  });
  await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
    messageId: newId("msg"),
    ts: nowIso(),
    turnIndex: 1,
    kind: "user",
    text: promptText,
  });
  const turn = await runFluxProviderTurn({
    workspaceRoot: args.workspaceRoot,
    config: args.config,
    session,
    sessionType: "solver",
    promptText,
    workingDirectory,
    env: typeof provisioned.env === "object" && provisioned.env ? provisioned.env as Record<string, string> : undefined,
    signal: args.signal,
  });
  await appendFluxMessage(args.workspaceRoot, args.config, "solver", sessionId, {
    messageId: newId("msg"),
    ts: nowIso(),
    turnIndex: 2,
    kind: "assistant",
    text: turn.assistantText,
    providerThreadId: turn.providerThreadId,
  });

  const observed = await runFluxProblemCommand(args.config.problem.observeEvidence, {
    workspaceRoot: args.workspaceRoot,
    attemptId,
    instanceId,
    workingDirectory,
  });
  const evidenceList = Array.isArray(observed.evidence) ? observed.evidence : [];
  const { watermark } = await appendEvidence(
    args.workspaceRoot,
    args.config,
    evidenceList.map((payload) => ({
      ts: nowIso(),
      attemptId,
      instanceId,
      summary: String((payload as any)?.summary ?? "solver evidence"),
      payload: payload as Record<string, unknown>,
    })),
  );
  session.status = "stopped";
  session.lastEvidenceWatermark = watermark || session.lastEvidenceWatermark;
  session.stopReason = "completed";
  session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, session);
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "solver.evidence_observed",
    workspaceRoot: args.workspaceRoot,
    sessionType: "solver",
    sessionId,
    summary: `observed ${evidenceList.length} evidence records`,
    payload: { attemptId, instanceId, watermark, count: evidenceList.length },
  }, {
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "session.stopped",
    workspaceRoot: args.workspaceRoot,
    sessionType: "solver",
    sessionId,
    summary: "solver session stopped",
    payload: { attemptId, instanceId },
  }]);
  await enqueueFluxQueueItem(args.workspaceRoot, args.config, "modeler", {
    id: newId("q"),
    sessionType: "modeler",
    createdAt: nowIso(),
    reason: "solver_stopped",
    payload: {
      attemptId,
      instanceId,
      evidenceWatermark: watermark,
      evidenceCount: evidenceList.length,
    },
  });
  await runFluxProblemCommand(args.config.problem.destroyInstance, {
    workspaceRoot: args.workspaceRoot,
    attemptId,
    instanceId,
    workingDirectory,
  });
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "solver.instance_destroyed",
    workspaceRoot: args.workspaceRoot,
    sessionType: "solver",
    sessionId,
    summary: `solver instance destroyed: ${instanceId}`,
    payload: { attemptId, instanceId },
  }]);
  const latestState = await loadFluxState(args.workspaceRoot, args.config) ?? startingState;
  latestState.active.solver = {
    sessionId,
    status: "idle",
    queueItemId: undefined,
    pid: undefined,
    attemptId: undefined,
    instanceId: undefined,
    updatedAt: nowIso(),
  };
  await saveFluxState(args.workspaceRoot, args.config, latestState);
}
