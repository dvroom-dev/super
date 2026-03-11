import { combineTranscript } from "../helpers.js";
import type { RuntimeContext } from "../requests/context.js";
import { runHooksForTrigger } from "./run_hooks.js";
import type { RunConfigHook, RunConfigHookTrigger } from "../../../supervisor/run_config_hooks.js";

export async function applyConfiguredHooks(args: {
  hooks: RunConfigHook[];
  trigger: RunConfigHookTrigger;
  workspaceRoot: string;
  currentDocText: string;
  docPath: string;
  ctx: RuntimeContext;
  appendNotifications: boolean;
}): Promise<{ nextDocText: string; changed: boolean }> {
  if (!args.hooks.length) return { nextDocText: args.currentDocText, changed: false };
  const hookMarkdowns = await runHooksForTrigger({
    hooks: args.hooks,
    trigger: args.trigger,
    workspaceRoot: args.workspaceRoot,
    emitStatus: (message) => args.ctx.sendNotification({ method: "conversation.status", params: { message } }),
    emitWarning: (message) => args.ctx.sendNotification({ method: "log", params: { level: "warn", message } }),
  });
  if (!hookMarkdowns.length) return { nextDocText: args.currentDocText, changed: false };
  if (args.appendNotifications) {
    for (const markdown of hookMarkdowns) {
      args.ctx.sendNotification({ method: "conversation.append", params: { docPath: args.docPath, markdown } });
    }
  }
  return { nextDocText: combineTranscript(args.currentDocText, hookMarkdowns), changed: true };
}
