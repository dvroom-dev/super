import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "../utils/ids.js";
import { appendFluxEvents } from "./events.js";
import { formatEvidenceForPrompt } from "./json_session_format.js";
import { saveFluxSession } from "./session_store.js";
import type { FluxConfig, FluxSessionRecord } from "./types.js";

const SOLVER_HANDOFF_DIR = "solver_handoff";
const SOLVER_HANDOFF_FILE = "untrusted_theories.md";
const SOLVER_HANDOFF_REQUIREMENT_FILE = ".flux_solver_handoff_requirement.json";

function nowIso(): string {
  return new Date().toISOString();
}

export function solverTheoryRelativePath(): string {
  return path.join(SOLVER_HANDOFF_DIR, SOLVER_HANDOFF_FILE);
}

function solverTheoryAbsolutePath(workingDirectory: string): string {
  return path.join(workingDirectory, solverTheoryRelativePath());
}

function solverTheoryRequirementPath(workingDirectory: string): string {
  return path.join(workingDirectory, SOLVER_HANDOFF_REQUIREMENT_FILE);
}

async function statIfExists(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function isSolverTheoryFresh(args: {
  workingDirectory: string;
  requestedAt?: string;
}): Promise<boolean> {
  if (!args.requestedAt) return false;
  const stat = await statIfExists(solverTheoryAbsolutePath(args.workingDirectory));
  if (!stat) return false;
  const requestedMs = Date.parse(args.requestedAt);
  return Number.isFinite(requestedMs) && stat.mtimeMs >= requestedMs;
}

export async function writeSolverTheoryRequirement(args: {
  workingDirectory: string;
  theoryLevel: number;
  frontierLevel: number;
  requestedAt: string;
}): Promise<void> {
  const requirementPath = solverTheoryRequirementPath(args.workingDirectory);
  await fs.mkdir(path.dirname(requirementPath), { recursive: true });
  await fs.writeFile(requirementPath, JSON.stringify({
    schema_version: "flux.solver_handoff_requirement.v1",
    required_theory_level: args.theoryLevel,
    frontier_level: args.frontierLevel,
    required_file: solverTheoryRelativePath(),
    requested_at: args.requestedAt,
  }, null, 2), "utf8");
}

async function clearSolverTheoryRequirement(workingDirectory: string): Promise<void> {
  await fs.rm(solverTheoryRequirementPath(workingDirectory), { force: true });
}

export async function maybeClearSatisfiedSolverTheoryRequirement(args: {
  session: FluxSessionRecord;
  workingDirectory: string;
  workspaceRoot: string;
  config: FluxConfig;
  invocationId: string;
  sessionId: string;
  attemptId: string;
  instanceId: string;
}): Promise<boolean> {
  if (!args.session.pendingSolverTheoryLevel || !args.session.pendingSolverTheoryRequestedAt) {
    return false;
  }
  const fresh = await isSolverTheoryFresh({
    workingDirectory: args.workingDirectory,
    requestedAt: args.session.pendingSolverTheoryRequestedAt,
  });
  if (!fresh) return false;
  await clearSolverTheoryRequirement(args.workingDirectory);
  const completedLevel = args.session.pendingSolverTheoryLevel;
  args.session.pendingSolverTheoryLevel = undefined;
  args.session.pendingSolverTheoryFrontierLevel = undefined;
  args.session.pendingSolverTheoryRequestedAt = undefined;
  args.session.updatedAt = nowIso();
  await saveFluxSession(args.workspaceRoot, args.config, args.session);
  await appendFluxEvents(args.workspaceRoot, args.config, [{
    eventId: newId("evt"),
    ts: nowIso(),
    kind: "solver.theory_handoff_written",
    workspaceRoot: args.workspaceRoot,
    invocationId: args.invocationId,
    sessionType: "solver",
    sessionId: args.sessionId,
    summary: `solver wrote handoff notes for solved level ${completedLevel}`,
    payload: {
      attemptId: args.attemptId,
      instanceId: args.instanceId,
      theoryLevel: completedLevel,
      frontierLevel: args.session.lastFrontierLevel ?? null,
      relativePath: solverTheoryRelativePath(),
    },
  }]);
  return true;
}

export function buildPolicyViolationPrompt(args: {
  violation: string;
  evidenceRecords: Record<string, unknown>[];
  pendingTheoryLevel?: number;
}): string {
  const latest = args.evidenceRecords[args.evidenceRecords.length - 1] ?? {};
  const lines = [
    "Your last turn violated solver policy.",
    `- Violation: ${args.violation}`,
    "- Start fresh from the current live state with no reuse of the invalid search plan.",
    "- Do not use BFS, DFS, reachability search, exhaustive search, or brute-force search.",
    "- Never unpack or subscript env.step(...); call it for side effects and inspect env.get_frame() afterward.",
    "- If you just reached a new frontier level, first write the required solver handoff file before more real-game actions.",
    `- Required handoff path: ${solverTheoryRelativePath()}`,
    "- Then run one bounded real action probe immediately.",
    "- Prefer one short real probe over more theory.",
    "",
    "Latest observed evidence:",
    formatEvidenceForPrompt(latest),
  ];
  if (args.pendingTheoryLevel) {
    lines.splice(6, 0, `- The pending handoff is for solved level ${args.pendingTheoryLevel}.`);
    lines.splice(7, 0, "- If arc_repl returns `critical_instruction`, follow it before any more action calls.");
  }
  return lines.join("\n");
}

export function buildContinuationPrompt(
  evidenceRecords: Record<string, unknown>[],
  options?: { noProgress?: boolean; pendingTheoryLevel?: number | null; pendingTheoryFrontierLevel?: number | null },
): string {
  const latest = evidenceRecords[evidenceRecords.length - 1] ?? {};
  const latestState = latest.state && typeof latest.state === "object" && !Array.isArray(latest.state)
    ? latest.state as Record<string, unknown>
    : {};
  const currentLevel = Number(latestState.current_level ?? 0) || 0;
  const levelsCompleted = Number(latestState.levels_completed ?? 0) || 0;
  const frontierLine = currentLevel > 1 || levelsCompleted > 0
    ? `- You are already at frontier level ${currentLevel || "unknown"}. Do not redo the solved prefix unless live evidence contradicts it.`
    : "- You are still working on level 1.";
  const levelTransitionLines = currentLevel > 1 || levelsCompleted > 0 ? [
    "- Before broad analysis on this level, write the solver handoff markdown for the previous solved level.",
    `- Required handoff path: ${solverTheoryRelativePath()}`,
    "- arc_repl may return `critical_instruction` and reject further real-game actions until that file exists and is up to date.",
    "- After the handoff file exists, run one bounded real action probe on the new level before doing more layout theory.",
  ] : [];
  const noProgressLines = options?.noProgress ? [
    "- Your last turn did not produce new game progress from the current state.",
    "- Do not stop or summarize.",
    "- Immediately try a different concrete branch from the current live state.",
    "- If your last action sequence only reconfirmed an already-known blockage, change the earliest branch choice now.",
    "- If one action is now a no-op at the frontier, try a different action or a different ordering from the same state before considering reset.",
  ] : [];
  return [
    "Continue solving from the current live state.",
    "",
    frontierLine,
    ...(options?.pendingTheoryLevel ? [
      `- Pending required handoff: write ${solverTheoryRelativePath()} for solved level ${options.pendingTheoryLevel} before more real-game actions.`,
      options.pendingTheoryFrontierLevel
        ? `- You reached frontier level ${options.pendingTheoryFrontierLevel}; capture the transferable mechanics from level ${options.pendingTheoryLevel} and any cautious hypotheses about the new level.`
        : "- Capture the transferable mechanics from the solved previous level and any cautious hypotheses about the new level.",
    ] : []),
    ...levelTransitionLines,
    ...noProgressLines,
    "- Do not stop to summarize.",
    "- Keep taking real actions until the level is solved or you are explicitly interrupted.",
    "- Prefer continuing from the current state over resetting.",
    "- Treat compare output as diagnostic only. Do not assume a no-op or long reachable path is correct until the real game confirms it.",
    "- Do not use BFS, DFS, exhaustive reachability, or brute-force search over action/state space.",
    "- Never unpack or subscript the return value of env.step(...); call it for side effects and inspect env.get_frame() afterward.",
    "- If a long route snaps back to start, consumes only life/fuel/bar pixels, or reveals a hidden reset, mark that branch invalid at the first trigger step and change the earliest branch choice.",
    "- After a blocked or no-op action from the same state, switch branch instead of repeating the same action again.",
    "",
    "Latest observed evidence:",
    formatEvidenceForPrompt(latest),
  ].join("\n");
}
