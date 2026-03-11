import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { applyPatch } from "./apply_patch.js";
import { paginateToolOutput, normalizeToolOutputConfig } from "./tool_output.js";
import {
  isBuiltinToolName,
  isToolAllowedByPolicy,
  type BuiltinToolName,
  type CustomToolDefinition,
  type ToolNamePolicy,
} from "./definitions.js";
import {
  shellCommandFromShellToolArgs,
  shellInvocationPolicyViolation,
  type ShellInvocationPolicy,
} from "./shell_invocation_policy.js";

export type ToolCall = {
  name: string;
  args: any;
};

export type ToolResult = {
  ok: boolean;
  output: string;
  exitCode?: number;
  error?: string;
};

export type ExecuteToolOptions = {
  builtinToolPolicy?: ToolNamePolicy<BuiltinToolName>;
  customTools?: CustomToolDefinition[];
  shellInvocationPolicy?: ShellInvocationPolicy;
};

function ensureInside(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel) && rel.includes("..")) {
    throw new Error(`Path escapes workspace root: ${p}`);
  }
  return abs;
}

export async function executeTool(
  workspaceRoot: string,
  call: ToolCall,
  options?: ExecuteToolOptions,
): Promise<ToolResult> {
  const builtinToolPolicy = options?.builtinToolPolicy;
  const customTool = (options?.customTools ?? []).find((tool) => tool.name === call.name);

  const runCommand = async (cmd: string[], cwd: string, stdinText?: string, env?: NodeJS.ProcessEnv): Promise<ToolResult> =>
    await new Promise<ToolResult>((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), { cwd, env: env ?? process.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => {
        resolve({
          ok: code === 0,
          exitCode: code ?? undefined,
          output: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""),
        });
      });
      child.on("error", (err) => {
        resolve({ ok: false, output: stdout, error: String(err) });
      });
      if (stdinText != null) {
        child.stdin.end(stdinText);
      }
    });

  if (customTool) {
    const cwdArg = customTool.cwd ?? ".";
    const cwd = ensureInside(workspaceRoot, String(cwdArg));
    const argsJson = JSON.stringify(call.args ?? {});
    const env = {
      ...process.env,
      AI_SUPERVISOR_TOOL_NAME: customTool.name,
      AI_SUPERVISOR_TOOL_ARGS: argsJson,
    };
    return await runCommand(customTool.command, cwd, argsJson, env);
  }

  if (isBuiltinToolName(call.name) && !isToolAllowedByPolicy(builtinToolPolicy, call.name)) {
    throw new Error(`Tool disabled by config: ${call.name}`);
  }

  if (call.name === "shell") {
    const cmd = call.args?.cmd;
    if (!Array.isArray(cmd) || cmd.length === 0) throw new Error("shell tool requires args.cmd as string[]");
    const commandText = shellCommandFromShellToolArgs(call.args ?? {});
    const violation = shellInvocationPolicyViolation({
      policy: options?.shellInvocationPolicy,
      commandText,
    });
    if (violation) {
      throw new Error(violation);
    }
    const cwdArg = call.args?.cwd ?? ".";
    const cwd = ensureInside(workspaceRoot, String(cwdArg));
    return await runCommand(cmd, cwd);
  }

  if (call.name === "read_file") {
    const file = String(call.args?.path ?? "");
    if (!file) throw new Error("read_file requires args.path");
    const abs = ensureInside(workspaceRoot, file);
    const content = await fs.readFile(abs, "utf-8");
    return { ok: true, output: content };
  }

  if (call.name === "write_file") {
    const file = String(call.args?.path ?? "");
    const content = String(call.args?.content ?? "");
    if (!file) throw new Error("write_file requires args.path");
    const abs = ensureInside(workspaceRoot, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    return { ok: true, output: "ok" };
  }

  if (call.name === "list_dir") {
    const dir = String(call.args?.path ?? ".");
    const abs = ensureInside(workspaceRoot, dir);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    return { ok: true, output: lines.join("\n") };
  }

  if (call.name === "apply_patch") {
    const command = Array.isArray(call.args?.command) ? call.args.command : null;
    const patchText = typeof call.args?.patch === "string" ? call.args.patch : null;
    let patch = "";
    if (command && command[0] === "apply_patch" && typeof command[1] === "string") {
      patch = command[1];
    } else if (patchText) {
      patch = patchText;
    }
    if (!patch) throw new Error("apply_patch requires args.command ['apply_patch', PATCH] or args.patch");
    const output = await applyPatch(workspaceRoot, patch);
    return { ok: true, output };
  }

  if (call.name === "paginate_tool_response") {
    const id = String(call.args?.id ?? call.args?.response_id ?? "");
    if (!id) throw new Error("paginate_tool_response requires args.id");
    const page = Number(call.args?.page ?? 1);
    const hasOverride =
      call.args?.maxLines != null ||
      call.args?.max_lines != null ||
      call.args?.maxBytes != null ||
      call.args?.max_bytes != null;
    const overrideConfig = hasOverride ? normalizeToolOutputConfig(call.args) : undefined;
    const result = await paginateToolOutput({
      workspaceRoot,
      responseId: id,
      page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
      config: overrideConfig,
    });
    const hint = result.page < result.totalPages
      ? `<page ${result.page} of ${result.totalPages}, run \`paginate_tool_response ${result.responseId} ${result.page + 1}\` to see the next page>`
      : `<page ${result.page} of ${result.totalPages}>`;
    return { ok: true, output: [result.content, hint].filter(Boolean).join("\n") };
  }


  throw new Error(`Unknown tool: ${call.name}`);
}
