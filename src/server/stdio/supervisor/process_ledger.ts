import path from "node:path";
import type { RenderedRunConfig } from "../../../supervisor/run_config.ts";
import type { SuperState } from "../../../lib/types.ts";
import { readJsonIfExists, writeJsonAtomic } from "../../../lib/fs.ts";

type ProcessLedgerEntry = {
  ts: string;
  conversationId: string;
  forkId: string;
  stageId?: string;
  profileId?: string;
  mode?: string;
  stopReasons: string[];
};

type ProcessLedger = {
  schemaVersion: number;
  updatedAt: string;
  current: {
    conversationId: string;
    forkId: string;
    stageId?: string;
    profileId?: string;
    mode?: string;
    stopReasons: string[];
  };
  history: ProcessLedgerEntry[];
};

function ledgerPathFor(workspaceRoot: string, config: RenderedRunConfig | null | undefined): string {
  const configured = String(config?.process?.ledgerPath ?? "").trim();
  if (configured) return path.resolve(workspaceRoot, configured);
  return path.join(workspaceRoot, "super", "process_ledger.json");
}

export async function writeProcessLedger(args: {
  workspaceRoot: string;
  renderedRunConfig: RenderedRunConfig | null | undefined;
  state: SuperState;
}): Promise<void> {
  if (Number(args.renderedRunConfig?.schemaVersion ?? 0) < 2) return;
  const filePath = ledgerPathFor(args.workspaceRoot, args.renderedRunConfig);
  const existing = await readJsonIfExists<ProcessLedger>(filePath);
  const current = {
    conversationId: args.state.conversationId,
    forkId: args.state.activeForkId,
    stageId: args.state.activeProcessStage,
    profileId: args.state.activeTaskProfile,
    mode: args.state.activeMode,
    stopReasons: args.state.lastStopReasons ?? [],
  };
  const nextEntry: ProcessLedgerEntry = {
    ts: args.state.updatedAt,
    conversationId: args.state.conversationId,
    forkId: args.state.activeForkId,
    stageId: args.state.activeProcessStage,
    profileId: args.state.activeTaskProfile,
    mode: args.state.activeMode,
    stopReasons: args.state.lastStopReasons ?? [],
  };
  const prior = existing?.history?.at(-1);
  const sameAsPrior = prior
    && prior.conversationId === nextEntry.conversationId
    && prior.forkId === nextEntry.forkId
    && prior.stageId === nextEntry.stageId
    && prior.profileId === nextEntry.profileId
    && prior.mode === nextEntry.mode
    && JSON.stringify(prior.stopReasons ?? []) === JSON.stringify(nextEntry.stopReasons ?? []);
  const history = sameAsPrior
    ? (existing?.history ?? [])
    : [...(existing?.history ?? []), nextEntry];
  await writeJsonAtomic(filePath, {
    schemaVersion: 2,
    updatedAt: args.state.updatedAt,
    current,
    history,
  } satisfies ProcessLedger);
}
