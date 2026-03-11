import fs from "node:fs/promises";
import { loadRunConfigForDirectory, renderRunConfig } from "../supervisor/run_config.ts";
import {
  resolveModeConfig,
  resolveModePayload,
  frontmatterValue as modeFrontmatterValue,
} from "../server/stdio/supervisor/mode_runtime.ts";
import { handleConversationSupervise } from "../server/stdio/requests/conversation_supervise.ts";
import { newId } from "../lib/ids.ts";
import { buildInitialDocument, frontmatterValue, normalizeExportedDocumentFrontmatter } from "../lib/document.ts";
import { createNotificationHandler } from "../lib/notifications.ts";
import { createSuperContext } from "../lib/context.ts";
import { appendEvents, exportSessionDocument, loadSuperState, saveSuperState } from "../lib/state.ts";
import { loadForkDocument } from "../lib/store.ts";
import type { CliOptions, SuperEvent, SuperState } from "../lib/types.ts";

function usage(): string {
  return "usage: super <new|resume|status> [session.md] --workspace <dir> [--config <file>] [--output <file>] [--provider <name>] [--model <name>] [--cycle-limit N] [--start-mode <mode>]";
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0) throw new Error(usage());
  const mode = argv[0];
  if (mode !== "new" && mode !== "resume" && mode !== "status") throw new Error(usage());
  let i = 1;
  let resumeDocPath: string | undefined;
  if (mode === "resume" && argv[i] && !argv[i].startsWith("--")) {
    resumeDocPath = argv[i];
    i += 1;
  }
  const out: CliOptions = {
    mode,
    workspaceRoot: "",
    provider: "codex",
    model: "gpt-5-codex",
    quiet: false,
    yolo: false,
    disableSupervision: false,
    disableHooks: false,
    resumeDocPath,
    providerExplicit: false,
    modelExplicit: false,
    supervisorProviderExplicit: false,
    supervisorModelExplicit: false,
  };
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--workspace") { out.workspaceRoot = String(next); i += 1; continue; }
    if (arg === "--config") { out.configPath = String(next); i += 1; continue; }
    if (arg === "--config-dir") { out.configDir = String(next); i += 1; continue; }
    if (arg === "--agent-dir") { out.agentDir = String(next); i += 1; continue; }
    if (arg === "--supervisor-dir") { out.supervisorDir = String(next); i += 1; continue; }
    if (arg === "--provider") { out.provider = String(next); out.providerExplicit = true; i += 1; continue; }
    if (arg === "--model") { out.model = String(next); out.modelExplicit = true; i += 1; continue; }
    if (arg === "--supervisor-provider") { out.supervisorProvider = String(next); out.supervisorProviderExplicit = true; i += 1; continue; }
    if (arg === "--supervisor-model") { out.supervisorModel = String(next); out.supervisorModelExplicit = true; i += 1; continue; }
    if (arg === "--cycle-limit") { out.cycleLimit = Number(next); i += 1; continue; }
    if (arg === "--output") { out.outputPath = String(next); i += 1; continue; }
    if (arg === "--prompt") { out.prompt = String(next); i += 1; continue; }
    if (arg === "--start-mode") { out.startMode = String(next); i += 1; continue; }
    if (arg === "--quiet") { out.quiet = true; continue; }
    if (arg === "--yolo") { out.yolo = true; continue; }
    if (arg === "--disable-supervision" || arg === "--no-supervisor") { out.disableSupervision = true; continue; }
    if (arg === "--disable-hooks" || arg === "--no-hooks") { out.disableHooks = true; continue; }
    throw new Error(`unknown arg: ${arg}`);
  }
  if (!out.workspaceRoot) throw new Error("--workspace is required");
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function resolveRuntimeProvidersAndModels(
  options: CliOptions,
  renderedConfig: Awaited<ReturnType<typeof renderRunConfig>> | null,
) {
  const runtimeDefaults = renderedConfig?.runtimeDefaults;
  const agentProvider = options.providerExplicit
    ? options.provider
    : (runtimeDefaults?.agentProvider ?? runtimeDefaults?.provider ?? options.provider);
  const agentModel = options.modelExplicit
    ? options.model
    : (runtimeDefaults?.agentModel ?? runtimeDefaults?.model ?? options.model);
  const supervisorProvider = (options.supervisorProviderExplicit
    ? options.supervisorProvider
    : (runtimeDefaults?.supervisorProvider ?? options.supervisorProvider ?? agentProvider)) ?? agentProvider;
  const supervisorModel = (options.supervisorModelExplicit
    ? options.supervisorModel
    : (runtimeDefaults?.supervisorModel ?? options.supervisorModel ?? agentModel)) ?? agentModel;
  return { agentProvider, agentModel, supervisorProvider, supervisorModel };
}

async function buildNewDocument(options: CliOptions) {
  const runConfig = await loadRunConfigForDirectory(options.workspaceRoot, { explicitConfigPath: options.configPath });
  const configBaseDir = options.configDir ?? options.workspaceRoot;
  const agentBaseDir = options.agentDir ?? options.workspaceRoot;
  const supervisorBaseDir = options.supervisorDir ?? options.workspaceRoot;
  const renderedConfig = await renderRunConfig(runConfig, { configBaseDir, agentBaseDir, supervisorBaseDir });
  const { agentProvider, agentModel } = resolveRuntimeProvidersAndModels(options, renderedConfig);
  const mode = options.startMode ?? renderedConfig?.modeStateMachine?.initialMode ?? "";
  if (!mode) throw new Error("new mode requires mode_state_machine.initial_mode or --start-mode");
  const modeConfig = resolveModeConfig(renderedConfig, mode);
  const userMessage = String(options.prompt ?? modeConfig?.userMessage?.text ?? "").trim();
  if (!userMessage) throw new Error("new mode requires prompt text");
  const conversationId = newId("conversation");
  const forkId = newId("fork");
  const agentRules = modeConfig?.agentRules ?? renderedConfig?.agentRules ?? { requirements: [], violations: [] };
  const documentText = buildInitialDocument({
    conversationId,
    forkId,
    renderedRunConfig: renderedConfig,
    mode,
    provider: agentProvider,
    model: agentModel,
    userMessage,
    agentRuleRequirements: agentRules.requirements ?? [],
    agentRuleViolations: agentRules.violations ?? [],
    disableSupervision: options.disableSupervision,
  });
  return { documentText, conversationId, renderedConfig };
}

async function loadResumeDocumentFromState(options: CliOptions, state: SuperState) {
  if (options.resumeDocPath) {
    const documentText = await fs.readFile(options.resumeDocPath, "utf8");
    const conversationId = modeFrontmatterValue(documentText, "conversation_id")?.trim() || state.conversationId;
    return { documentText, conversationId };
  }
  const ctx = createSuperContext({ workspaceRoot: options.workspaceRoot, sendNotification: () => {} });
  const documentText = await loadForkDocument({
    store: ctx.store,
    workspaceRoot: options.workspaceRoot,
    conversationId: state.conversationId,
    forkId: state.activeForkId,
  });
  return { documentText, conversationId: state.conversationId };
}

async function runCycle(options: CliOptions): Promise<{ state: SuperState; documentText: string; assistantMessages: string[] }> {
  const prior = await loadSuperState(options.workspaceRoot);
  const built = options.mode === "new"
    ? await buildNewDocument(options)
    : prior
      ? await loadResumeDocumentFromState(options, prior)
      : (() => { throw new Error("resume requires existing super/state.json"); })();
  const initialForkId = frontmatterValue(built.documentText, "fork_id")?.trim();
  if (!initialForkId) throw new Error("active document is missing fork_id frontmatter");

  const documentTextRef = { value: built.documentText };
  const assistantMessages: string[] = [];
  const events: SuperEvent[] = [];
  const sendNotification = createNotificationHandler({
    documentTextRef,
    assistantMessages,
    events,
    conversationId: built.conversationId,
  });
  const ctx = createSuperContext({ workspaceRoot: options.workspaceRoot, sendNotification });

  const runConfig = await loadRunConfigForDirectory(options.workspaceRoot, { explicitConfigPath: options.configPath });
  const configBaseDir = options.configDir ?? options.workspaceRoot;
  const agentBaseDir = options.agentDir ?? options.workspaceRoot;
  const supervisorBaseDir = options.supervisorDir ?? options.workspaceRoot;
  const renderedConfig = await renderRunConfig(runConfig, { configBaseDir, agentBaseDir, supervisorBaseDir });
  const runtimeDefaults = renderedConfig?.runtimeDefaults;
  const { agentProvider, agentModel, supervisorProvider, supervisorModel } =
    resolveRuntimeProvidersAndModels(options, renderedConfig);

  const initialState: SuperState = {
    version: 1,
    workspaceRoot: options.workspaceRoot,
    conversationId: built.conversationId,
    activeForkId: prior?.activeForkId ?? initialForkId,
    activeMode: frontmatterValue(documentTextRef.value, "mode")?.trim() || prior?.activeMode,
    activeModePayload: resolveModePayload(documentTextRef.value),
    agentProvider,
    agentModel,
    supervisorProvider,
    supervisorModel,
    cycleCount: prior?.cycleCount ?? 0,
    createdAt: prior?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    lastStopReasons: prior?.lastStopReasons ?? [],
    lastStopDetails: prior?.lastStopDetails ?? [],
  };
  await saveSuperState(options.workspaceRoot, initialState);
  await exportSessionDocument(options.workspaceRoot, documentTextRef.value, options.outputPath);

  const providerOptions = runtimeDefaults?.providerOptions as Record<string, Record<string, unknown> | undefined> | undefined;
  const result = await handleConversationSupervise(ctx, {
    workspaceRoot: options.workspaceRoot,
    docPath: `${options.workspaceRoot}/super/exports/session.md`,
    documentText: documentTextRef.value,
    models: [agentModel],
    provider: agentProvider,
    supervisorProvider,
    supervisorModel,
    agentProviderOptions: providerOptions?.[String(agentProvider)],
    supervisorProviderOptions: providerOptions?.[String(supervisorProvider)],
    agentModelReasoningEffort: runtimeDefaults?.agentModelReasoningEffort ?? runtimeDefaults?.modelReasoningEffort,
    supervisorModelReasoningEffort: runtimeDefaults?.supervisorModelReasoningEffort ?? runtimeDefaults?.agentModelReasoningEffort ?? runtimeDefaults?.modelReasoningEffort,
    disableSupervision: options.disableSupervision,
    disableHooks: options.disableHooks,
    yolo: options.yolo,
    cycleLimit: options.cycleLimit,
    sandboxMode: "workspace-write",
    skipGitRepoCheck: true,
    supervisor: options.disableSupervision
      ? { ...(renderedConfig?.supervisor ?? {}), enabled: false, timeBudgetMs: 0, tokenBudgetAdjusted: 0, cadenceTimeMs: 0, cadenceTokensAdjusted: 0 }
      : { ...(renderedConfig?.supervisor ?? {}), enabled: renderedConfig?.supervisor?.enabled ?? true },
    toolOutput: renderedConfig?.toolOutput,
    configBaseDir,
    agentBaseDir,
    supervisorBaseDir,
    runConfigPath: options.configPath,
  });

  const exportedDocumentText = await loadForkDocument({
    store: ctx.store,
    workspaceRoot: options.workspaceRoot,
    conversationId: result.conversationId,
    forkId: result.forkId,
  });
  documentTextRef.value = exportedDocumentText;

  const activeMode = frontmatterValue(documentTextRef.value, "mode")?.trim() || "";
  documentTextRef.value = normalizeExportedDocumentFrontmatter(documentTextRef.value, {
    conversationId: result.conversationId,
    forkId: result.forkId,
    mode: activeMode || undefined,
  });
  const nextState: SuperState = {
    version: 1,
    workspaceRoot: options.workspaceRoot,
    conversationId: result.conversationId,
    activeForkId: result.forkId,
    activeMode: activeMode || prior?.activeMode,
    activeModePayload: resolveModePayload(documentTextRef.value),
    agentProvider,
    agentModel,
    supervisorProvider,
    supervisorModel,
    cycleCount: (prior?.cycleCount ?? 0) + 1,
    createdAt: prior?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    lastStopReasons: result.stopReasons ?? [],
    lastStopDetails: result.stopDetails ?? [],
  };
  await saveSuperState(options.workspaceRoot, nextState);
  await appendEvents(options.workspaceRoot, events);
  await exportSessionDocument(options.workspaceRoot, documentTextRef.value, options.outputPath);
  return { state: nextState, documentText: documentTextRef.value, assistantMessages };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "status") {
    const state = await loadSuperState(options.workspaceRoot);
    if (!state) throw new Error("no super state found");
    const out = JSON.stringify(state, null, 2);
    if (!options.quiet) process.stdout.write(out + "\n");
    return;
  }
  const { documentText, assistantMessages } = await runCycle(options);
  if (options.quiet) return;
  if (options.outputPath) {
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
    if (lastAssistantMessage) process.stdout.write(lastAssistantMessage + "\n");
    return;
  }
  process.stdout.write(documentText);
}

if (import.meta.main) {
  main().catch((err: any) => {
    process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
