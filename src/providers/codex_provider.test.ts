import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexProvider } from "./codex_provider.js";
import type { ProviderConfig, ProviderEvent } from "./types.js";
import { promptContentFromText } from "../utils/prompt_content.js";
import type {
  CodexAppServerClientLike,
  CodexAppServerClientOptions,
  CodexAppServerNotification,
  CodexAppServerRequestOptions,
} from "./codex_app_server_client.js";

type RequestRecord = {
  method: string;
  params?: unknown;
  options?: CodexAppServerRequestOptions;
};

class FakeAppServerClient implements CodexAppServerClientLike {
  requests: RequestRecord[] = [];
  starts = 0;
  private handlers = new Map<string, (params?: unknown, options?: CodexAppServerRequestOptions) => unknown | Promise<unknown>>();
  private notificationHandlers = new Set<(notification: CodexAppServerNotification) => void>();
  private notificationBacklog: CodexAppServerNotification[] = [];

  setHandler(
    method: string,
    handler: (params?: unknown, options?: CodexAppServerRequestOptions) => unknown | Promise<unknown>,
  ) {
    this.handlers.set(method, handler);
  }

  emit(method: string, params?: unknown) {
    const notification = { method, params };
    this.notificationBacklog.push(notification);
    for (const handler of [...this.notificationHandlers]) handler(notification);
  }

  async start(): Promise<void> {
    this.starts += 1;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: CodexAppServerRequestOptions,
  ): Promise<T> {
    this.requests.push({ method, params, options });
    const handler = this.handlers.get(method);
    if (!handler) return {} as T;
    return (await handler(params, options)) as T;
  }

  async notify(): Promise<void> {
    // no-op
  }

  subscribe(handler: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async waitForNotification(
    predicate: (notification: CodexAppServerNotification) => boolean,
    options?: CodexAppServerRequestOptions,
  ): Promise<CodexAppServerNotification> {
    if (options?.signal?.aborted) throw new Error("aborted");
    for (const notification of this.notificationBacklog) {
      if (predicate(notification)) return notification;
    }
    return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe((notification) => {
        if (!predicate(notification)) return;
        unsubscribe();
        resolve(notification);
      });
      if (options?.timeoutMs) {
        setTimeout(() => {
          unsubscribe();
          reject(new Error("timeout"));
        }, options.timeoutMs);
      }
    });
  }

  async close(): Promise<void> {
    this.notificationBacklog = [];
    this.notificationHandlers.clear();
  }
}

describe("CodexProvider", () => {
  const baseConfig: ProviderConfig = {
    provider: "codex",
    model: "gpt-5.3-codex",
    workingDirectory: "/tmp/work",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  };

  function createProvider(
    config: ProviderConfig,
    factoryCapture?: Array<CodexAppServerClientOptions>,
    fakeClient?: FakeAppServerClient,
  ): CodexProvider {
    const client = fakeClient ?? new FakeAppServerClient();
    return new CodexProvider(config, {
      appServerFactory: (options) => {
        factoryCapture?.push(options);
        return client;
      },
    });
  }

  it("maps app-server streamed events to provider events", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({
      thread: { id: "thread_1" },
    }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("item/agentMessage/delta", {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          delta: "Hello ",
        });
        fakeClient.emit("item/agentMessage/delta", {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          delta: "world",
        });
        fakeClient.emit("item/completed", {
          threadId: "thread_1",
          turnId: "turn_1",
          item: { id: "item_1", type: "agentMessage", text: "Hello world" },
        });
        fakeClient.emit("turn/completed", {
          threadId: "thread_1",
          turn: {
            id: "turn_1",
            status: "completed",
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        });
      });
      return { turn: { id: "turn_1" } };
    });
    const provider = createProvider(baseConfig, undefined, fakeClient);

    const events: ProviderEvent[] = [];
    for await (const event of provider.runStreamed(promptContentFromText("say hello"))) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "status", message: "codex: starting turn" });
    expect(events).toContainEqual({ type: "assistant_delta", delta: "Hello " });
    expect(events).toContainEqual({ type: "assistant_delta", delta: "world" });
    expect(events).toContainEqual({ type: "assistant_message", text: "Hello world" });
    expect(events).toContainEqual({ type: "usage", usage: { input_tokens: 10, output_tokens: 2 } });
    expect(events[events.length - 1]).toEqual({
      type: "done",
      finalText: "Hello world",
      threadId: "thread_1",
    });
  });

  it("enforces json-only streamed assistant output when output schema is configured", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({
      thread: { id: "thread_schema" },
    }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("item/agentMessage/delta", {
          threadId: "thread_schema",
          turnId: "turn_schema",
          itemId: "item_schema",
          delta: "I will run a script now",
        });
        fakeClient.emit("item/completed", {
          threadId: "thread_schema",
          turnId: "turn_schema",
          item: {
            id: "item_schema",
            type: "agentMessage",
            text: "Script prepared.\n\n{\"action\":\"run_script\",\"script_path\":\"act.py\"}",
          },
        });
        fakeClient.emit("turn/completed", {
          threadId: "thread_schema",
          turn: { id: "turn_schema", status: "completed" },
        });
      });
      return { turn: { id: "turn_schema" } };
    });
    const provider = createProvider(baseConfig, undefined, fakeClient);
    const schema = { type: "object", properties: { action: { type: "string" } }, required: ["action"] };

    const events: ProviderEvent[] = [];
    for await (const event of provider.runStreamed(promptContentFromText("return action"), { outputSchema: schema })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "assistant_delta")).toBe(false);
    const assistant = events.find((event) => event.type === "assistant_message") as any;
    expect(assistant).toBeTruthy();
    expect(JSON.parse(assistant.text)).toEqual({ action: "run_script", script_path: "act.py" });
    const turnStartCall = fakeClient.requests.find((record) => record.method === "turn/start");
    expect((turnStartCall?.params as any)?.outputSchema).toEqual(schema);
  });

  it("normalizes runOnce final text when schema is configured and supports thread/resume", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/resume", () => ({
      thread: { id: "thread_resumed" },
    }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("item/completed", {
          threadId: "thread_resumed",
          turnId: "turn_resumed",
          item: { id: "msg", type: "agentMessage", text: "Done.\n{\"action\":\"reset_level\"}" },
        });
        fakeClient.emit("item/completed", {
          threadId: "thread_resumed",
          turnId: "turn_resumed",
          item: { id: "reason_1", type: "reasoning", text: "thinking" },
        });
        fakeClient.emit("turn/completed", {
          threadId: "thread_resumed",
          turn: { id: "turn_resumed", status: "completed" },
        });
      });
      return { turn: { id: "turn_resumed" } };
    });
    const provider = createProvider({ ...baseConfig, threadId: "thread_old" }, undefined, fakeClient);
    const schema = { type: "object", properties: { action: { type: "string" } }, required: ["action"] };

    const result = await provider.runOnce(promptContentFromText("json please"), { outputSchema: schema });

    const resumeCall = fakeClient.requests.find((record) => record.method === "thread/resume");
    expect((resumeCall?.params as any)?.threadId).toBe("thread_old");
    expect((resumeCall?.params as any)?.model).toBe(baseConfig.model);
    expect((resumeCall?.params as any)?.approvalPolicy).toBe("never");
    expect((resumeCall?.params as any)?.sandbox).toBe("workspace-write");
    expect((resumeCall?.params as any)?.cwd).toBe("/tmp/work");
    expect(JSON.parse(result.text)).toEqual({ action: "reset_level" });
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items?.some((item: any) => item?.type === "agentMessage")).toBe(false);
    expect(result.threadId).toBe("thread_resumed");
  });

  it("rejects runOnce when turn/completed reports failed status", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_failed" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("turn/completed", {
          threadId: "thread_failed",
          turn: {
            id: "turn_failed",
            status: "failed",
            error: { message: "codex backend rejected request" },
          },
        });
      });
      return { turn: { id: "turn_failed" } };
    });
    const provider = createProvider(baseConfig, undefined, fakeClient);

    await expect(provider.runOnce(promptContentFromText("fail me"))).rejects.toThrow(
      "codex backend rejected request",
    );
  });

  it("propagates status errors when no assistant text is returned", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_status_error" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("error", {
          threadId: "thread_status_error",
          message: "codex: transport error",
        });
        fakeClient.emit("turn/completed", {
          threadId: "thread_status_error",
          turn: { id: "turn_status_error", status: "completed" },
        });
      });
      return { turn: { id: "turn_status_error" } };
    });
    const provider = createProvider(baseConfig, undefined, fakeClient);

    await expect(provider.runOnce(promptContentFromText("status failure"))).rejects.toThrow(
      "codex: transport error",
    );
  });

  it("compacts an existing thread with thread/compact/start", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/resume", () => ({
      thread: { id: "thread_resumed" },
    }));
    fakeClient.setHandler("thread/compact/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("thread/compacted", { threadId: "thread_resumed" });
      });
      return {};
    });
    const provider = createProvider({ ...baseConfig, threadId: "thread_old" }, undefined, fakeClient);

    const result = await provider.compactThread?.({ reason: "preflight" });

    expect(result).toEqual({ compacted: true, threadId: "thread_resumed" });
    expect(fakeClient.requests.some((record) => record.method === "thread/compact/start")).toBe(true);
  });

  it("skips compaction when no thread exists yet", async () => {
    const provider = createProvider(baseConfig);

    const result = await provider.compactThread?.({ reason: "preflight" });

    expect(result?.compacted).toBe(false);
    expect(result?.details).toContain("no thread");
  });

  it("passes provider options through to app-server config overrides", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_cfg" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("turn/completed", {
          threadId: "thread_cfg",
          turn: { id: "turn_cfg", status: "completed" },
        });
      });
      return { turn: { id: "turn_cfg" } };
    });
    const factoryCalls: CodexAppServerClientOptions[] = [];
    const provider = createProvider(
      {
        ...baseConfig,
        providerOptions: {
          show_raw_agent_reasoning: false,
          model_reasoning_summary: "none",
        },
      },
      factoryCalls,
      fakeClient,
    );

    await provider.runOnce(promptContentFromText("config passthrough"));

    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]?.configOverrides).toEqual({
      show_raw_agent_reasoning: false,
      hide_hard_reasoning: false,
      model_reasoning_summary: "none",
    });
  });

  it("applies codex reasoning defaults when provider options are absent", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_defaults" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("turn/completed", {
          threadId: "thread_defaults",
          turn: { id: "turn_defaults", status: "completed" },
        });
      });
      return { turn: { id: "turn_defaults" } };
    });
    const factoryCalls: CodexAppServerClientOptions[] = [];
    const provider = createProvider(baseConfig, factoryCalls, fakeClient);

    await provider.runOnce(promptContentFromText("defaults"));

    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]?.configOverrides).toEqual({
      show_raw_agent_reasoning: true,
      hide_hard_reasoning: false,
      model_reasoning_summary: "detailed",
    });
  });

  it("keeps legacy permissive codex config in yolo profile", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_yolo" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("turn/completed", {
          threadId: "thread_yolo",
          turn: { id: "turn_yolo", status: "completed" },
        });
      });
      return { turn: { id: "turn_yolo" } };
    });
    const factoryCalls: CodexAppServerClientOptions[] = [];
    const provider = createProvider({ ...baseConfig, permissionProfile: "yolo" }, factoryCalls, fakeClient);

    await provider.runOnce(promptContentFromText("yolo"));

    expect(factoryCalls[0]?.configOverrides).toEqual({
      show_raw_agent_reasoning: true,
      hide_hard_reasoning: false,
      model_reasoning_summary: "detailed",
    });
  });

  it("registers run-config custom tools as Codex MCP servers", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_custom_tools" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("turn/completed", {
          threadId: "thread_custom_tools",
          turn: { id: "turn_custom_tools", status: "completed" },
        });
      });
      return { turn: { id: "turn_custom_tools" } };
    });
    const factoryCalls: CodexAppServerClientOptions[] = [];
    const provider = createProvider(
      {
        ...baseConfig,
        customTools: [
          {
            name: "arc_action",
            description: "Execute ARC action",
            command: ["/bin/echo", "ok"],
            cwd: ".",
          },
        ],
      },
      factoryCalls,
      fakeClient,
    );

    await provider.runOnce(promptContentFromText("custom tools"));

    expect(factoryCalls).toHaveLength(1);
    const config = (factoryCalls[0]?.configOverrides ?? {}) as Record<string, any>;
    expect(config.mcp_servers?.super_custom_tools?.command).toBeTruthy();
    expect(Array.isArray(config.mcp_servers?.super_custom_tools?.args)).toBe(true);
    const env = config.mcp_servers?.super_custom_tools?.env as Record<string, string>;
    expect(typeof env?.SUPER_CUSTOM_TOOLS_JSON).toBe("string");
    expect(env?.SUPER_CUSTOM_TOOLS_WORKSPACE_ROOT).toBe("/tmp/work");
    const parsedTools = JSON.parse(env.SUPER_CUSTOM_TOOLS_JSON);
    expect(Array.isArray(parsedTools)).toBe(true);
    expect(parsedTools[0]?.name).toBe("arc_action");
  });

  it("merges custom tool MCP server with existing codex mcp_servers config", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_custom_merge" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("turn/completed", {
          threadId: "thread_custom_merge",
          turn: { id: "turn_custom_merge", status: "completed" },
        });
      });
      return { turn: { id: "turn_custom_merge" } };
    });
    const factoryCalls: CodexAppServerClientOptions[] = [];
    const provider = createProvider(
      {
        ...baseConfig,
        providerOptions: {
          mcp_servers: {
            existing_server: {
              command: "/bin/echo",
              args: ["existing"],
            },
          },
        },
        customTools: [
          {
            name: "arc_action",
            description: "Execute ARC action",
            command: ["/bin/echo", "ok"],
            cwd: ".",
          },
        ],
      },
      factoryCalls,
      fakeClient,
    );

    await provider.runOnce(promptContentFromText("custom merge"));

    const config = (factoryCalls[0]?.configOverrides ?? {}) as Record<string, any>;
    expect(config.mcp_servers?.existing_server?.command).toBe("/bin/echo");
    expect(config.mcp_servers?.super_custom_tools).toBeTruthy();
  });

  it("uses approval callbacks to block matching shell commands when shell policy is configured", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_shell_policy" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("item/completed", {
          threadId: "thread_shell_policy",
          turnId: "turn_shell_policy",
          item: { id: "item_shell_policy", type: "agentMessage", text: "done" },
        });
        fakeClient.emit("turn/completed", {
          threadId: "thread_shell_policy",
          turn: { id: "turn_shell_policy", status: "completed" },
        });
      });
      return { turn: { id: "turn_shell_policy" } };
    });
    const factoryCalls: CodexAppServerClientOptions[] = [];
    const provider = createProvider(
      {
        ...baseConfig,
        shellInvocationPolicy: {
          disallow: [{ matchType: "contains", pattern: "rm -rf", caseSensitive: true }],
        },
      },
      factoryCalls,
      fakeClient,
    );

    await provider.runOnce(promptContentFromText("shell policy"));

    const threadStartCall = fakeClient.requests.find((record) => record.method === "thread/start");
    expect((threadStartCall?.params as any)?.approvalPolicy).toBe("on-request");
    expect(typeof factoryCalls[0]?.approvalRequestHandler).toBe("function");
    const approvalHandler = factoryCalls[0]?.approvalRequestHandler!;
    await expect(
      approvalHandler({
        method: "item/commandExecution/requestApproval",
        params: { command: ["bash", "-lc", "rm -rf /tmp/x"] },
      }),
    ).resolves.toEqual({
      decision: "decline",
      reason: expect.stringContaining("shell invocation blocked"),
    });
    await expect(
      approvalHandler({
        method: "item/commandExecution/requestApproval",
        params: { command: ["echo", "safe"] },
      }),
    ).resolves.toEqual({ decision: "approve" });
    await expect(
      approvalHandler({
        method: "item/fileChange/requestApproval",
        params: { path: "file.txt" },
      }),
    ).resolves.toEqual({ decision: "approve" });
  });

  it("uses approval callbacks to enforce shell allow lists", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", async () => ({ thread: { id: "thread_shell_allow" } }));
    fakeClient.setHandler("turn/start", async () => {
      queueMicrotask(() => {
        fakeClient.emit("turn/completed", {
          threadId: "thread_shell_allow",
          turn: { id: "turn_shell_allow", status: "completed" },
        });
      });
      return { turn: { id: "turn_shell_allow" } };
    });
    const factoryCalls: CodexAppServerClientOptions[] = [];
    const provider = createProvider(
      {
        ...baseConfig,
        shellInvocationPolicy: {
          allow: [{ matchType: "regex", pattern: "^(pwd|arc_repl)(\\s|$)", caseSensitive: true }],
        },
      },
      factoryCalls,
      fakeClient,
    );

    await provider.runOnce(promptContentFromText("shell allow"));
    const approvalHandler = factoryCalls[0]?.approvalRequestHandler!;
    await expect(
      approvalHandler({
        method: "item/commandExecution/requestApproval",
        params: { command: ["python3", "-c", "print(1)"] },
      }),
    ).resolves.toEqual({
      decision: "decline",
      reason: expect.stringContaining("tools.shell_invocation_policy.allow"),
    });
    await expect(
      approvalHandler({
        method: "item/commandExecution/requestApproval",
        params: { command: ["pwd"] },
      }),
    ).resolves.toEqual({ decision: "approve" });
  });

  it("uses approval callbacks to block filesystem writes outside configured policy", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_fs_policy" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("item/completed", {
          threadId: "thread_fs_policy",
          turnId: "turn_fs_policy",
          item: { id: "item_fs_policy", type: "agentMessage", text: "done" },
        });
        fakeClient.emit("turn/completed", {
          threadId: "thread_fs_policy",
          turn: { id: "turn_fs_policy", status: "completed" },
        });
      });
      return { turn: { id: "turn_fs_policy" } };
    });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fs-policy-"));
    const factoryCalls: CodexAppServerClientOptions[] = [];
    const provider = createProvider(
      {
        ...baseConfig,
        workingDirectory: tempDir,
        providerFilesystemPolicy: {
          allowNewFiles: false,
          write: { allow: ["theory.md"] },
        },
      },
      factoryCalls,
      fakeClient,
    );

    await provider.runOnce(promptContentFromText("fs policy"));

    const threadStartCall = fakeClient.requests.find((record) => record.method === "thread/start");
    expect((threadStartCall?.params as any)?.approvalPolicy).toBe("on-request");
    const approvalHandler = factoryCalls[0]?.approvalRequestHandler!;
    await expect(
      approvalHandler({
        method: "item/fileChange/requestApproval",
        params: { path: "scratch.py" },
      }),
    ).resolves.toEqual({
      decision: "decline",
      reason: expect.stringContaining("allow_new_files=false"),
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("passes sandbox + approval policy to thread/start", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("thread/start", () => ({ thread: { id: "thread_perm" } }));
    fakeClient.setHandler("turn/start", () => {
      queueMicrotask(() => {
        fakeClient.emit("turn/completed", {
          threadId: "thread_perm",
          turn: { id: "turn_perm", status: "completed" },
        });
      });
      return { turn: { id: "turn_perm" } };
    });
    const provider = createProvider({
      ...baseConfig,
      approvalPolicy: "on-request",
      sandboxMode: "read-only",
    }, undefined, fakeClient);

    await provider.runOnce(promptContentFromText("permissions"));

    const threadStartCall = fakeClient.requests.find((record) => record.method === "thread/start");
    expect((threadStartCall?.params as any)?.approvalPolicy).toBe("on-request");
    expect((threadStartCall?.params as any)?.sandbox).toBe("read-only");
  });
});
