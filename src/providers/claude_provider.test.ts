import { describe, expect, it } from "bun:test";
import { ClaudeProvider } from "./claude_provider.js";
import type { ProviderConfig, ProviderEvent } from "./types.js";
import { promptContentFromText } from "../utils/prompt_content.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type QueryInvocation = { prompt: string | AsyncIterable<any>; options?: Record<string, unknown> };

function makeQueryStub(
  messages: any[],
  capture?: { invocation?: QueryInvocation; closed?: boolean },
): (args: QueryInvocation) => AsyncIterable<any> & { close(): void } {
  return (invocation: QueryInvocation) => {
    if (capture) capture.invocation = invocation;
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
      close() {
        if (capture) capture.closed = true;
      },
    };
  };
}

function makeControllableQueryStub(args: {
  firstMessage: any;
  release: Promise<void>;
  capture: {
    invocation?: QueryInvocation;
    closed?: boolean;
    streamInputs: any[];
  };
}): (invocation: QueryInvocation) => AsyncIterable<any> & { close(): void; streamInput(stream: AsyncIterable<any>): Promise<void> } {
  return (invocation: QueryInvocation) => {
    args.capture.invocation = invocation;
    return {
      async *[Symbol.asyncIterator]() {
        yield args.firstMessage;
        await args.release;
      },
      async streamInput(stream: AsyncIterable<any>) {
        for await (const message of stream) {
          args.capture.streamInputs.push(message);
        }
      },
      close() {
        args.capture.closed = true;
      },
    };
  };
}

describe("ClaudeProvider", () => {
  const baseConfig: ProviderConfig = {
    provider: "claude",
    model: "claude-sonnet-4-5-20250929",
    workingDirectory: "/tmp/work",
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
  };

  it("maps streamed Claude messages to provider events", async () => {
    const query = makeQueryStub([
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
        session_id: "sess_1",
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
        session_id: "sess_1",
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world" }] },
        session_id: "sess_1",
      },
      {
        type: "result",
        subtype: "success",
        result: "Hello world",
        usage: {
          input_tokens: 21,
          cache_read_input_tokens: 5,
          output_tokens: 8,
          total_tokens: 29,
        },
        session_id: "sess_1",
      },
    ]);
    const provider = new ClaudeProvider(baseConfig, { query });
    const events: ProviderEvent[] = [];
    for await (const event of provider.runStreamed(promptContentFromText("say hello"))) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "status", message: "claude: starting turn" });
    expect(events).toContainEqual({ type: "assistant_delta", delta: "Hello " });
    expect(events).toContainEqual({ type: "assistant_delta", delta: "world" });
    expect(events).toContainEqual({ type: "assistant_message", text: "Hello world" });
    const usageEvent = events.find((event) => event.type === "usage") as any;
    expect(usageEvent?.usage).toEqual({
      input_tokens: 21,
      cached_input_tokens: 5,
      output_tokens: 8,
      total_tokens: 29,
    });
    expect(events[events.length - 1]).toEqual({ type: "done", finalText: "Hello world", threadId: "sess_1" });
  });

  it("enforces json-only streamed assistant output when output schema is configured", async () => {
    const schema = { type: "object", properties: { action: { type: "string" } }, required: ["action"] };
    const query = makeQueryStub([
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "I will run script now." } },
        session_id: "sess_schema",
      },
      {
        type: "result",
        subtype: "success",
        result: "Script is ready.\n\n{\"action\":\"run_script\"}",
        session_id: "sess_schema",
      },
    ]);
    const provider = new ClaudeProvider(baseConfig, { query });
    const events: ProviderEvent[] = [];
    for await (const event of provider.runStreamed(promptContentFromText("return json"), { outputSchema: schema })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "assistant_delta")).toBe(false);
    const assistant = events.find((event) => event.type === "assistant_message") as any;
    expect(assistant).toBeTruthy();
    expect(JSON.parse(assistant.text)).toEqual({ action: "run_script" });
  });

  it("passes resume, sandbox, and json schema options to claude query()", async () => {
    const previousClaudeCode = process.env.CLAUDECODE;
    const previousEntry = process.env.CLAUDE_CODE_ENTRYPOINT;
    const previousReplEntry = process.env.CLAUDE_CODE_REPL_ENTRYPOINT;
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CLAUDE_CODE_REPL_ENTRYPOINT = "repl";
    try {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const schema = { type: "object", properties: { action: { type: "string" } }, required: ["action"] };
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_new" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        threadId: "sess_old",
        sandboxMode: "read-only",
        providerOptions: {
          disallowedTools: ["Task"],
        },
      },
      { query },
    );
    const result = await provider.runOnce(promptContentFromText("emit action"), { outputSchema: schema });

    expect(result.threadId).toBe("sess_new");
    expect(result.text).toContain("\"action\":\"ok\"");
    expect(capture.closed).toBe(true);
    expect(capture.invocation?.prompt).toBe("emit action");
    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    expect(options.model).toBe("claude-sonnet-4-5-20250929");
    expect(options.cwd).toBe("/tmp/work");
    expect(options.resume).toBe("sess_old");
    expect(options.permissionMode).toBe("default");
    expect(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(options.env?.CLAUDECODE).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_REPL_ENTRYPOINT).toBeUndefined();
    expect(typeof options.canUseTool).toBe("function");
    expect(Array.isArray(options.disallowedTools)).toBe(true);
    expect(options.disallowedTools).toContain("Bash");
    expect(options.disallowedTools).toContain("Task");
    expect(options.outputFormat).toEqual({ type: "json_schema", schema });
    } finally {
      if (previousClaudeCode === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = previousClaudeCode;
      if (previousEntry === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = previousEntry;
      if (previousReplEntry === undefined) delete process.env.CLAUDE_CODE_REPL_ENTRYPOINT;
      else process.env.CLAUDE_CODE_REPL_ENTRYPOINT = previousReplEntry;
    }
  });

  it("compacts an existing Claude session with /compact", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "compacted", session_id: "sess_new" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        threadId: "sess_old",
      },
      { query },
    );

    const result = await provider.compactThread?.({ reason: "preflight" });

    expect(result).toEqual({ compacted: true, threadId: "sess_new" });
    expect(capture.closed).toBe(true);
    expect(capture.invocation?.prompt).toBe("/compact");
    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    expect(options.resume).toBe("sess_old");
  });

  it("skips Claude compaction when no session is active", async () => {
    const query = () => {
      throw new Error("unexpected query call");
    };
    const provider = new ClaudeProvider(baseConfig, { query });

    const result = await provider.compactThread?.({ reason: "preflight" });

    expect(result?.compacted).toBe(false);
    expect(result?.details).toContain("no thread");
  });

  it("compacts the discovered live Claude session even when no threadId was seeded", async () => {
    const invocations: QueryInvocation[] = [];
    const responses = [
      { type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_live_discovered" },
      { type: "result", subtype: "success", result: "compacted", session_id: "sess_live_compacted" },
    ];
    const query = (invocation: QueryInvocation) => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra query");
      invocations.push(invocation);
      return {
        [Symbol.asyncIterator]: async function* () {
          yield next;
        },
      };
    };
    const provider = new ClaudeProvider(baseConfig, { query });

    const first = await provider.runOnce(promptContentFromText("discover session"));
    const compacted = await provider.compactThread?.({ reason: "preflight" });

    expect(first.threadId).toBe("sess_live_discovered");
    expect(compacted).toEqual({ compacted: true, threadId: "sess_live_compacted" });
    expect(invocations).toHaveLength(2);
    expect(invocations[1]?.prompt).toBe("/compact");
    const options = (invocations[1]?.options ?? {}) as Record<string, any>;
    expect(options.resume).toBe("sess_live_discovered");
  });

  it("denies blocked filesystem paths outside working directory while auto-allowing others", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_perms" }],
      capture,
    );
    const provider = new ClaudeProvider(baseConfig, { query });
    await provider.runOnce(promptContentFromText("permissions"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    expect(options.permissionMode).toBe("default");
    expect(typeof options.canUseTool).toBe("function");

    const allow = await options.canUseTool("Bash", { command: "ls" }, { toolUseID: "tool_ok" });
    expect(allow).toEqual({ behavior: "allow", updatedInput: { command: "ls" }, toolUseID: "tool_ok" });

    const deny = await options.canUseTool(
      "Bash",
      { command: "cat ../../etc/passwd" },
      { toolUseID: "tool_blocked", blockedPath: "../../etc/passwd" },
    );
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message ?? "")).toContain("outside workspace");
    expect(deny?.toolUseID).toBe("tool_blocked");
  });

  it("denies bash commands matching shell invocation disallow rules", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_shell_filter" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        shellInvocationPolicy: {
          disallow: [
            { matchType: "contains", pattern: "rm -rf", caseSensitive: true },
          ],
        },
      },
      { query },
    );
    await provider.runOnce(promptContentFromText("shell filter"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    const deny = await options.canUseTool("Bash", { command: "rm -rf demo" }, { toolUseID: "tool_shell_deny" });
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message ?? "")).toContain("shell invocation blocked");

    const allow = await options.canUseTool("Bash", { command: "echo safe" }, { toolUseID: "tool_shell_allow" });
    expect(allow?.behavior).toBe("allow");
  });

  it("denies bash commands outside shell invocation allow rules", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_shell_allow" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        shellInvocationPolicy: {
          allow: [
            { matchType: "regex", pattern: "^(pwd|arc_repl)(\\s|$)", caseSensitive: true },
          ],
        },
      },
      { query },
    );
    await provider.runOnce(promptContentFromText("shell allow"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    const deny = await options.canUseTool("Bash", { command: "python3 -c 'print(1)'" }, { toolUseID: "tool_shell_allow_deny" });
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message ?? "")).toContain("tools.shell_invocation_policy.allow");

    const allow = await options.canUseTool("Bash", { command: "pwd" }, { toolUseID: "tool_shell_allow_ok" });
    expect(allow?.behavior).toBe("allow");
  });

  it("installs shell policy enforcement even when approval policy is not never", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_shell_policy_non_never" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        approvalPolicy: "on-request",
        shellInvocationPolicy: {
          allow: [
            { matchType: "regex", pattern: "^(pwd|arc_repl)(\\s|$)", caseSensitive: true },
          ],
        },
      },
      { query },
    );
    await provider.runOnce(promptContentFromText("shell allow on-request"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    expect(typeof options.canUseTool).toBe("function");

    const deny = await options.canUseTool("Bash", { command: "python3 -c 'print(1)'" }, { toolUseID: "tool_shell_policy_non_never" });
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message ?? "")).toContain("tools.shell_invocation_policy.allow");
  });

  it("denies Claude builtin tools outside configured allowedTools", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_builtin_allow" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        providerOptions: {
          allowedTools: ["Bash", "Read"],
        },
      },
      { query },
    );
    await provider.runOnce(promptContentFromText("builtin allow"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    const deny = await options.canUseTool("AskUserQuestion", {}, { toolUseID: "tool_builtin_deny" });
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message ?? "")).toContain("provider builtin tool policy");

    const allow = await options.canUseTool("Read", { file_path: "/tmp/work/theory.md" }, { toolUseID: "tool_builtin_allow" });
    expect(allow?.behavior).toBe("allow");
  });

  it("allows configured custom MCP tools even when builtin allow list is narrow", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_mcp_allow" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        providerOptions: {
          allowedTools: ["Bash", "Read"],
        },
      },
      { query },
    );
    await provider.runOnce(promptContentFromText("mcp allow"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    const allow = await options.canUseTool("mcp__super_custom_tools__arc_action", {}, { toolUseID: "tool_mcp_allow" });
    expect(allow?.behavior).toBe("allow");
  });

  it("denies filesystem writes outside configured mode policy", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-fs-policy-"));
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_fs_policy" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        workingDirectory: tempDir,
        providerFilesystemPolicy: {
          allowNewFiles: false,
          write: { allow: ["theory.md"] },
        },
      },
      { query },
    );
    await provider.runOnce(promptContentFromText("fs policy"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    const deny = await options.canUseTool(
      "Write",
      { path: "scratch.py", content: "print('x')" },
      { toolUseID: "tool_fs_deny" },
    );
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message ?? "")).toContain("allow_new_files=false");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("denies explicit tool input paths outside working directory", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_paths" }],
      capture,
    );
    const provider = new ClaudeProvider(baseConfig, { query });
    await provider.runOnce(promptContentFromText("path perms"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    const deny = await options.canUseTool(
      "Read",
      { file_path: "/etc/passwd" },
      { toolUseID: "tool_path" },
    );
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message ?? "")).toContain("outside workspace");
  });

  it("passes provider options through to claude query options", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_provider_cfg" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        providerOptions: {
          settingSources: ["user", "project"],
          includePartialMessages: true,
          debug: true,
        },
      },
      { query },
    );

    await provider.runOnce(promptContentFromText("emit action"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    expect(options.settingSources).toEqual(["user", "project"]);
    expect(options.includePartialMessages).toBe(true);
    expect(options.debug).toBe(true);
    expect(options.model).toBe("claude-sonnet-4-5-20250929");
    expect(options.cwd).toBe("/tmp/work");
    expect(Array.isArray(options.disallowedTools)).toBe(true);
    expect(options.disallowedTools).toContain("WebFetch");
    expect(options.disallowedTools).toContain("WebSearch");
  });

  it("can steer an active Claude turn by streaming a follow-up user message", async () => {
    let releaseStream!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const capture: { invocation?: QueryInvocation; closed?: boolean; streamInputs: any[] } = {
      streamInputs: [],
    };
    const query = makeControllableQueryStub({
      firstMessage: {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Thinking..." } },
        session_id: "sess_live",
      },
      release,
      capture,
    });
    const provider = new ClaudeProvider(baseConfig, { query });
    const iterator = provider.runStreamed(promptContentFromText("start analysis"));

    const first = await iterator.next();
    expect(first.value).toEqual({ type: "status", message: "claude: starting turn" });

    const pending = iterator.next();
    const second = await pending;
    expect(second.value).toEqual({ type: "assistant_delta", delta: "Thinking..." });

    const steer = await provider.steerActiveTurn?.(promptContentFromText("Supervisor: focus on the mismatch."));

    expect(steer).toEqual({
      applied: true,
      deferred: false,
      threadId: "sess_live",
      turnId: "claude_turn_1",
    });
    expect(capture.streamInputs).toHaveLength(1);
    expect(capture.streamInputs[0]).toMatchObject({
      type: "user",
      session_id: "sess_live",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: "Supervisor: focus on the mismatch.",
      },
    });

    releaseStream();
    for await (const _ of iterator) {
      // drain
    }
    expect(capture.closed).toBe(true);
  });

  it("denies network tool invocations in strict profile", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_network" }],
      capture,
    );
    const provider = new ClaudeProvider(baseConfig, { query });
    await provider.runOnce(promptContentFromText("network perms"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    const deny = await options.canUseTool("WebFetch", { url: "https://example.com" }, { toolUseID: "tool_web" });
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message ?? "")).toMatch(/Network tool usage is not allowed|provider builtin tool policy/);
  });

  it("keeps legacy permissive network policy in yolo profile", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_yolo" }],
      capture,
    );
    const provider = new ClaudeProvider({ ...baseConfig, permissionProfile: "yolo" }, { query });
    await provider.runOnce(promptContentFromText("yolo perms"));

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    const allow = await options.canUseTool("WebFetch", { url: "https://example.com" }, { toolUseID: "tool_web" });
    expect(allow?.behavior).toBe("allow");
    expect(Array.isArray(options.disallowedTools)).toBe(false);
  });

  it("registers run-config custom tools as Claude MCP tools", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const createCalls: Array<Record<string, unknown>> = [];
    const createSdkMcpServer = (options: Record<string, unknown>) => {
      createCalls.push(options);
      return { type: "sdk", name: String(options.name ?? "super_custom_tools") };
    };
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_custom" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        providerOptions: {
          allowedTools: ["Bash"],
        },
        customTools: [
          {
            name: "arc_action",
            description: "Execute ARC harness action",
            command: ["/bin/echo", "ok"],
            cwd: ".",
          },
        ],
      },
      { query, createSdkMcpServer },
    );

    await provider.runOnce(promptContentFromText("run arc action"));

    expect(createCalls.length).toBe(1);
    const firstCall = createCalls[0] as any;
    expect(firstCall.name).toBe("super_custom_tools");
    expect(Array.isArray(firstCall.tools)).toBe(true);
    const toolNames = firstCall.tools.map((tool: any) => tool?.name);
    expect(toolNames).toContain("arc_action");

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    expect(options.mcpServers?.super_custom_tools).toEqual({ type: "sdk", name: "super_custom_tools" });
    expect(options.allowedTools).toContain("Bash");
    expect(options.allowedTools).toContain("arc_action");
  });

  it("registers generic custom tools with a permissive MCP input schema", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const createCalls: Array<Record<string, unknown>> = [];
    const createSdkMcpServer = (options: Record<string, unknown>) => {
      createCalls.push(options);
      return { type: "sdk", name: String(options.name ?? "super_custom_tools") };
    };
    const query = makeQueryStub(
      [{ type: "result", subtype: "success", result: "{\"action\":\"ok\"}", session_id: "sess_custom_schema" }],
      capture,
    );
    const provider = new ClaudeProvider(
      {
        ...baseConfig,
        customTools: [
          {
            name: "arc_action",
            description: "Execute ARC helper action",
            command: ["/usr/bin/true"],
          },
        ],
      },
      { query, createSdkMcpServer },
    );

    await provider.runOnce(promptContentFromText("custom tool"));

    expect(createCalls.length).toBe(1);
    const firstCall = createCalls[0] as any;
    const customTool = Array.isArray(firstCall.tools)
      ? firstCall.tools.find((tool: any) => tool?.name === "arc_action")
      : undefined;
    expect(customTool).toBeTruthy();
    expect(customTool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: true,
    });
    expect(typeof customTool.inputSchema?.safeParseAsync).toBe("function");
    expect(typeof customTool.inputSchema?.parseAsync).toBe("function");
    await expect(customTool.inputSchema.parseAsync({ any: "payload", nested: { ok: true } })).resolves.toMatchObject({
      any: "payload",
      nested: { ok: true },
    });
  });

  it("defaults includePartialMessages and emits reasoning provider items", async () => {
    const capture: { invocation?: QueryInvocation; closed?: boolean } = {};
    const query = makeQueryStub(
      [
        {
          type: "assistant",
          message: {
            id: "msg_reasoning",
            content: [
              { type: "thinking", thinking: "Try stepping on the marker first." },
              { type: "text", text: "Next move ready." },
            ],
          },
          session_id: "sess_reasoning",
        },
        { type: "result", subtype: "success", result: "Next move ready.", session_id: "sess_reasoning" },
      ],
      capture,
    );
    const provider = new ClaudeProvider(baseConfig, { query });
    const events: ProviderEvent[] = [];
    for await (const event of provider.runStreamed(promptContentFromText("reason"))) {
      events.push(event);
    }

    const options = (capture.invocation?.options ?? {}) as Record<string, any>;
    expect(options.includePartialMessages).toBe(true);
    const reasoning = events.find(
      (event): event is Extract<ProviderEvent, { type: "provider_item" }> =>
        event.type === "provider_item" && (event.item as any)?.type === "assistant.reasoning",
    );
    expect(reasoning).toBeTruthy();
    expect((reasoning as any).item?.text).toContain("stepping on the marker");
    expect(events).toContainEqual({ type: "assistant_message", text: "Next move ready." });
  });

  it("returns structured output JSON when result text is absent", async () => {
    const query = makeQueryStub([
      {
        type: "result",
        subtype: "success",
        structured_output: { action: "reset level", reason: "invalid move" },
        session_id: "sess_structured",
      },
    ]);
    const provider = new ClaudeProvider(baseConfig, { query });
    const result = await provider.runOnce(promptContentFromText("return structured output"));

    expect(result.threadId).toBe("sess_structured");
    expect(JSON.parse(result.text)).toEqual({ action: "reset level", reason: "invalid move" });
  });

  it("returns normalized runOnce items rather than raw provider payload wrappers", async () => {
    const query = makeQueryStub([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_42",
              content: [{ type: "text", text: "command output" }],
            },
          ],
        },
        session_id: "sess_norm",
      },
      {
        type: "result",
        subtype: "success",
        result: "done",
        session_id: "sess_norm",
      },
    ]);
    const provider = new ClaudeProvider(baseConfig, { query });
    const result = await provider.runOnce(promptContentFromText("normalize"));
    const first = (result.items ?? [])[0] as any;

    expect(result.threadId).toBe("sess_norm");
    expect(first?.provider).toBe("claude");
    expect(first?.kind).toBe("tool_result");
    expect(first?.event).toBeUndefined();
  });

  it("sends async user-message stream when prompt includes images", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-prompt-"));
    const imagePath = path.join(tempDir, "image.png");
    await fs.writeFile(imagePath, "png-bytes", "utf8");
    try {
      const capture: { invocation?: QueryInvocation } = {};
      const query = makeQueryStub([{ type: "result", subtype: "success", result: "ok", session_id: "sess_mm" }], capture);
      const provider = new ClaudeProvider(baseConfig, { query });
      const result = await provider.runOnce([
        ...promptContentFromText("describe image"),
        { type: "image", path: imagePath },
      ]);

      expect(result.text).toBe("ok");
      expect(typeof capture.invocation?.prompt).toBe("object");
      const promptStream = capture.invocation?.prompt as AsyncIterable<any>;
      const items: any[] = [];
      for await (const msg of promptStream) items.push(msg);
      expect(items[0]?.type).toBe("user");
      expect(Array.isArray(items[0]?.message?.content)).toBe(true);
      expect(items[0].message.content.some((block: any) => block.type === "image")).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
