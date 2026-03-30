import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic, writeTextAtomic, readJsonIfExists } from "../lib/fs.js";
import { fluxSessionDir } from "./paths.js";
import type { FluxConfig, FluxMessageRecord, FluxSessionRecord, FluxSessionType } from "./types.js";

function sessionJsonPath(workspaceRoot: string, config: FluxConfig, sessionType: FluxSessionType, sessionId: string): string {
  return path.join(fluxSessionDir(workspaceRoot, config, sessionType, sessionId), "session.json");
}

function sessionMessagesPath(workspaceRoot: string, config: FluxConfig, sessionType: FluxSessionType, sessionId: string): string {
  return path.join(fluxSessionDir(workspaceRoot, config, sessionType, sessionId), "messages.jsonl");
}

function sessionPromptsDir(workspaceRoot: string, config: FluxConfig, sessionType: FluxSessionType, sessionId: string): string {
  return path.join(fluxSessionDir(workspaceRoot, config, sessionType, sessionId), "prompts");
}

function sessionProviderRawPath(workspaceRoot: string, config: FluxConfig, sessionType: FluxSessionType, sessionId: string): string {
  return path.join(fluxSessionDir(workspaceRoot, config, sessionType, sessionId), "provider_raw", "events.ndjson");
}

async function ensureSessionDirs(workspaceRoot: string, config: FluxConfig, sessionType: FluxSessionType, sessionId: string): Promise<void> {
  await fs.mkdir(fluxSessionDir(workspaceRoot, config, sessionType, sessionId), { recursive: true });
  await fs.mkdir(sessionPromptsDir(workspaceRoot, config, sessionType, sessionId), { recursive: true });
  await fs.mkdir(path.dirname(sessionProviderRawPath(workspaceRoot, config, sessionType, sessionId)), { recursive: true });
}

export async function loadFluxSession(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: FluxSessionType,
  sessionId: string,
): Promise<FluxSessionRecord | null> {
  return await readJsonIfExists<FluxSessionRecord>(sessionJsonPath(workspaceRoot, config, sessionType, sessionId));
}

export async function saveFluxSession(
  workspaceRoot: string,
  config: FluxConfig,
  session: FluxSessionRecord,
): Promise<void> {
  await ensureSessionDirs(workspaceRoot, config, session.sessionType, session.sessionId);
  await writeJsonAtomic(sessionJsonPath(workspaceRoot, config, session.sessionType, session.sessionId), session);
}

export async function appendFluxMessage(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: FluxSessionType,
  sessionId: string,
  message: FluxMessageRecord,
): Promise<void> {
  await ensureSessionDirs(workspaceRoot, config, sessionType, sessionId);
  await fs.appendFile(sessionMessagesPath(workspaceRoot, config, sessionType, sessionId), JSON.stringify(message) + "\n", "utf8");
}

export async function appendProviderRawEvent(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: FluxSessionType,
  sessionId: string,
  event: unknown,
): Promise<void> {
  await ensureSessionDirs(workspaceRoot, config, sessionType, sessionId);
  await fs.appendFile(sessionProviderRawPath(workspaceRoot, config, sessionType, sessionId), JSON.stringify(event) + "\n", "utf8");
}

export async function writeFluxPromptPayload(
  workspaceRoot: string,
  config: FluxConfig,
  sessionType: FluxSessionType,
  sessionId: string,
  turnIndex: number,
  payload: Record<string, unknown>,
): Promise<void> {
  await ensureSessionDirs(workspaceRoot, config, sessionType, sessionId);
  await writeTextAtomic(
    path.join(sessionPromptsDir(workspaceRoot, config, sessionType, sessionId), `turn_${String(turnIndex).padStart(3, "0")}.json`),
    JSON.stringify(payload, null, 2),
  );
}
