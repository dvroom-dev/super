import { promises as fs } from "node:fs";
import path from "node:path";
import { executeTool } from "../tools/tools.js";
import { makeClaudeCanUseToolWithShellPolicy } from "../providers/claude_tool_permissions.js";
import { makePermissiveToolInputSchema, makeSwitchModeToolInputSchema } from "../providers/claude_provider_helpers.js";
import type { CustomToolDefinition } from "../tools/definitions.js";

type ReplayRecord = {
  schemaVersion: 1;
  provider: "claude";
  kind: "runStreamed" | "runOnce" | "compactThread";
  startedAt: string;
  workingDirectory: string;
  model: string;
  threadId?: string;
  prompt: unknown;
  options: Record<string, unknown>;
  replayConfig?: {
    customTools?: CustomToolDefinition[];
    shellInvocationPolicy?: any;
    providerFilesystemPolicy?: any;
    denyNetwork?: boolean;
    toolPolicy?: { allow?: string[]; deny?: string[] };
  };
};

function usage(): never {
  throw new Error("usage: bun run src/bin/replay_claude_sdk_calls.ts <sdk-call-dir>");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function ensureSdk() {
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  const query = (mod as any)?.query;
  const createSdkMcpServer = (mod as any)?.createSdkMcpServer;
  if (typeof query !== "function") {
    throw new Error("claude sdk query() is unavailable");
  }
  return {
    query: query as (args: { prompt: unknown; options?: Record<string, unknown> }) => AsyncIterable<any> & { close?: () => void },
    createSdkMcpServer: typeof createSdkMcpServer === "function" ? createSdkMcpServer as any : undefined,
  };
}

async function buildReplayMcpServer(args: {
  createSdkMcpServer?: (options: {
    name: string;
    version?: string;
    tools?: Array<{
      name: string;
      description: string;
      inputSchema: unknown;
      handler: (toolArgs: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }>;
  }) => Record<string, unknown>;
  customTools: CustomToolDefinition[];
  workingDirectory: string;
}) {
  if (!args.createSdkMcpServer || args.customTools.length === 0) return undefined;
  return args.createSdkMcpServer({
    name: "super_custom_tools",
    version: "1.0.0",
    tools: args.customTools.map((customTool) => ({
      name: customTool.name,
      description: customTool.description,
      inputSchema: customTool.name === "switch_mode"
        ? makeSwitchModeToolInputSchema()
        : makePermissiveToolInputSchema(),
      handler: async (toolArgs: Record<string, unknown>) => {
        const result = await executeTool(
          args.workingDirectory,
          { name: customTool.name, args: toolArgs ?? {} },
          { customTools: [customTool] },
        );
        const contentParts: string[] = [];
        if (result.output) contentParts.push(result.output);
        if (result.error) contentParts.push(`[error]\n${result.error}`);
        const text = contentParts.join("\n").trim() || (result.ok ? "ok" : "error");
        return {
          content: [{ type: "text", text }],
          ...(result.ok ? {} : { isError: true }),
        };
      },
    })),
  });
}

async function replayRecord(record: ReplayRecord) {
  const sdk = await ensureSdk();
  const options = { ...(record.options ?? {}) };
  delete (options as any).abortController;
  const replayConfig = record.replayConfig ?? {};
  const mcpServer = await buildReplayMcpServer({
    createSdkMcpServer: sdk.createSdkMcpServer,
    customTools: Array.isArray(replayConfig.customTools) ? replayConfig.customTools : [],
    workingDirectory: record.workingDirectory,
  });
  if (mcpServer) {
    const existing = asRecord(options.mcpServers) ?? {};
    options.mcpServers = {
      ...existing,
      super_custom_tools: mcpServer,
    };
  }
  if (replayConfig.toolPolicy || replayConfig.shellInvocationPolicy || replayConfig.providerFilesystemPolicy || replayConfig.denyNetwork) {
    options.canUseTool = makeClaudeCanUseToolWithShellPolicy(
      record.workingDirectory,
      Boolean(replayConfig.denyNetwork),
      replayConfig.shellInvocationPolicy,
      replayConfig.providerFilesystemPolicy,
      replayConfig.toolPolicy,
    );
  }

  const startedAt = Date.now();
  const stream = sdk.query({
    prompt: record.prompt,
    options,
  });
  let sessionId: string | undefined = undefined;
  let events = 0;
  let finalText = "";
  try {
    for await (const msg of stream) {
      events += 1;
      if (typeof (msg as any)?.session_id === "string") sessionId = (msg as any).session_id;
      if ((msg as any)?.type === "assistant") {
        const message = asRecord((msg as any).message);
        const content = message?.content;
        if (typeof content === "string") finalText = content;
      }
      if ((msg as any)?.type === "result" && typeof (msg as any)?.result === "string") {
        finalText = (msg as any).result;
      }
    }
  } finally {
    try {
      stream.close?.();
    } catch {
      // best effort
    }
  }
  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    file: path.basename(record.startedAt.replace(/[:.]/g, "-")),
    kind: record.kind,
    model: record.model,
    startedAt: record.startedAt,
    elapsedMs,
    sessionId,
    events,
    finalTextPreview: finalText.slice(0, 200),
  }));
}

async function main() {
  const dir = process.argv[2];
  if (!dir) usage();
  const root = path.resolve(dir);
  const files = (await fs.readdir(root))
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of files) {
    const record = JSON.parse(await fs.readFile(path.join(root, name), "utf8")) as ReplayRecord;
    try {
      await replayRecord(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({
        file: name.replace(/\.json$/, ""),
        kind: record.kind,
        model: record.model,
        startedAt: record.startedAt,
        error: message,
      }));
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
