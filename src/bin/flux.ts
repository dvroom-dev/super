import path from "node:path";
import { loadFluxConfig } from "../flux/config.js";
import { readFluxEvents } from "../flux/events.js";
import { formatFluxEvents, formatFluxQueue, formatFluxState } from "../flux/inspect.js";
import { requestFluxStop, runFluxOrchestrator } from "../flux/orchestrator.js";
import { FLUX_SESSION_TYPES, loadFluxQueue } from "../flux/queue.js";
import { appendFluxRuntimeLog, recordFluxFatalProcessState } from "../flux/runtime_log.js";
import { loadFluxState } from "../flux/state.js";
import { newId } from "../utils/ids.js";

type FluxCommand = "run" | "status" | "queue" | "inspect" | "stop";

type FluxCliOptions = {
  command: FluxCommand;
  workspaceRoot: string;
  configPath: string;
  inspectTarget?: "events";
  tail: number;
};

function usage(): string {
  return "usage: flux <run|status|queue|inspect|stop> --workspace <dir> [--config <file>] [--tail N]";
}

function requireValue(flag: string, next: string | undefined): string {
  if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
  return next;
}

function parseArgs(argv: string[]): FluxCliOptions {
  const command = String(argv[0] ?? "").trim() as FluxCommand;
  if (!command || !["run", "status", "queue", "inspect", "stop"].includes(command)) throw new Error(usage());
  const out: FluxCliOptions = {
    command,
    workspaceRoot: "",
    configPath: "flux.yaml",
    tail: 50,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--workspace") { out.workspaceRoot = requireValue(arg, next); index += 1; continue; }
    if (arg === "--config") { out.configPath = requireValue(arg, next); index += 1; continue; }
    if (arg === "--tail") { out.tail = Number(requireValue(arg, next)); index += 1; continue; }
    if (arg === "events" && command === "inspect") { out.inspectTarget = "events"; continue; }
    throw new Error(`unknown arg: ${arg}`);
  }
  if (!out.workspaceRoot) throw new Error("--workspace is required");
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const config = await loadFluxConfig(workspaceRoot, options.configPath);
  if (options.command === "run") {
    let fatalRecorded = false;
    const recordFatal = (kind: string, detail: string) => {
      if (fatalRecorded) return;
      fatalRecorded = true;
      recordFluxFatalProcessState({
        workspaceRoot,
        config,
        event: {
          eventId: newId("evt"),
          ts: new Date().toISOString(),
          kind,
          workspaceRoot,
          summary: detail,
          payload: { pid: process.pid },
        },
        detail,
      });
    };
    const onUncaughtException = (err: unknown) => {
      const detail = `uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
      recordFatal("orchestrator.crashed", detail);
      process.stderr.write(`${detail}\n`);
      process.exit(1);
    };
    const onUnhandledRejection = (reason: unknown) => {
      const detail = `unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`;
      recordFatal("orchestrator.crashed", detail);
      process.stderr.write(`${detail}\n`);
      process.exit(1);
    };
    process.on("uncaughtException", onUncaughtException);
    process.on("unhandledRejection", onUnhandledRejection);
    appendFluxRuntimeLog(workspaceRoot, config, `flux run starting pid=${process.pid}`);
    try {
      await runFluxOrchestrator(workspaceRoot, path.resolve(workspaceRoot, options.configPath), config);
    } finally {
      process.off("uncaughtException", onUncaughtException);
      process.off("unhandledRejection", onUnhandledRejection);
      appendFluxRuntimeLog(workspaceRoot, config, `flux run exiting pid=${process.pid}`);
    }
    return;
  }
  if (options.command === "status") {
    process.stdout.write(formatFluxState(await loadFluxState(workspaceRoot, config)) + "\n");
    return;
  }
  if (options.command === "queue") {
    const output: Record<string, unknown> = {};
    for (const sessionType of FLUX_SESSION_TYPES) output[sessionType] = await loadFluxQueue(workspaceRoot, config, sessionType);
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }
  if (options.command === "inspect") {
    if (options.inspectTarget === "events") {
      process.stdout.write(formatFluxEvents(await readFluxEvents(workspaceRoot, config), options.tail) + "\n");
      return;
    }
    throw new Error("inspect currently supports only: events");
  }
  if (options.command === "stop") {
    await requestFluxStop(workspaceRoot, config);
    process.stdout.write("stop requested\n");
    return;
  }
}

if (import.meta.main) {
  main().catch((err: any) => {
    process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
