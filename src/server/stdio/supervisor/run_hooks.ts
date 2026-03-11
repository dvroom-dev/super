import { spawn } from "node:child_process";
import { renderChat } from "../../../markdown/render.js";
import { type RunConfigHook, type RunConfigHookTrigger } from "../../../supervisor/run_config_hooks.js";

const MAX_CAPTURE_BYTES = 256 * 1024;

type HookCommandResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function captureWithLimit(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current, "utf8") >= MAX_CAPTURE_BYTES) return current;
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  return current + chunk.toString("utf8", 0, remaining);
}

async function runHookCommand(command: string, cwd: string): Promise<HookCommandResult> {
  return await new Promise<HookCommandResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = captureWithLimit(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = captureWithLimit(stderr, chunk);
    });
    child.on("error", (error) => resolve({ exitCode: 1, signal: null, stdout, stderr, error }));
    child.on("close", (exitCode, signal) => resolve({ exitCode: exitCode ?? 0, signal, stdout, stderr }));
  });
}

export async function runHooksForTrigger(args: {
  hooks: RunConfigHook[];
  trigger: RunConfigHookTrigger;
  workspaceRoot: string;
  emitStatus: (message: string) => void;
  emitWarning: (message: string) => void;
}): Promise<string[]> {
  const matching = args.hooks.filter((hook) => hook.trigger === args.trigger);
  if (!matching.length) return [];
  const appended: string[] = [];
  for (const hook of matching) {
    const result = await runHookCommand(hook.action, args.workspaceRoot);
    const signalPart = result.signal ? ` signal=${result.signal}` : "";
    args.emitStatus(`hook trigger=${args.trigger} exit=${result.exitCode}${signalPart}`);
    if (result.error) {
      args.emitWarning(`hook trigger=${args.trigger} failed: ${result.error.message}`);
    } else if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      args.emitWarning(`hook trigger=${args.trigger} exited ${result.exitCode}${stderr ? ` (${stderr.slice(0, 220)})` : ""}`);
    }
    if (hook.appendStdoutAsUserMessage && result.stdout.trim()) {
      appended.push(renderChat("user", result.stdout.trimEnd(), { hook_trigger: args.trigger }));
    }
  }
  return appended;
}
