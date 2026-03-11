import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnOptions } from "node:child_process";
import { GeminiProvider } from "./gemini_provider.js";
import type { ProviderConfig, ProviderEvent } from "./types.js";
import { promptContentFromText } from "../utils/prompt_content.js";

class FakeGeminiProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
    return true;
  }

  complete(args: { lines?: string[]; stderr?: string; exitCode?: number }) {
    queueMicrotask(() => {
      for (const line of args.lines ?? []) {
        this.stdout.write(line + "\n");
      }
      if (args.stderr) this.stderr.write(args.stderr);
      this.stdout.end();
      this.stderr.end();
      this.emit("close", args.exitCode ?? 0, null);
    });
  }
}

type SpawnCall = {
  command: string;
  args: string[];
  options: SpawnOptions;
};

function createSpawnStub(
  schedule: (proc: FakeGeminiProcess, call: SpawnCall) => void,
  calls: SpawnCall[],
): (command: string, args: string[], options: SpawnOptions) => FakeGeminiProcess {
  return (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const proc = new FakeGeminiProcess();
    schedule(proc, call);
    return proc;
  };
}

describe("GeminiProvider", () => {
  const baseConfig: ProviderConfig = {
    provider: "gemini",
    model: "gemini-3-pro-preview",
    workingDirectory: "/tmp/work",
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
  };

  it("maps stream-json events to provider events", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      proc.complete({
        lines: [
          JSON.stringify({ type: "init", session_id: "sess_1", model: "gemini-3-pro-preview" }),
          JSON.stringify({ type: "message", role: "assistant", content: "Hello ", delta: true, session_id: "sess_1" }),
          JSON.stringify({ type: "message", role: "assistant", content: "world", delta: true, session_id: "sess_1" }),
          JSON.stringify({ type: "tool_use", tool_name: "Bash", tool_id: "tool_1", parameters: { command: "ls" } }),
          JSON.stringify({ type: "tool_result", tool_id: "tool_1", status: "success", output: "ok" }),
          JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } }),
        ],
      });
    }, calls);
    const provider = new GeminiProvider(baseConfig, { spawn });

    const events: ProviderEvent[] = [];
    for await (const ev of provider.runStreamed(promptContentFromText("say hello"))) {
      events.push(ev);
    }

    expect(events[0]).toEqual({ type: "status", message: "gemini: starting turn" });
    expect(events).toContainEqual({ type: "assistant_delta", delta: "Hello " });
    expect(events).toContainEqual({ type: "assistant_delta", delta: "world" });
    const toolCall = events.find((ev) => ev.type === "provider_item" && ev.item.kind === "tool_call") as any;
    expect(toolCall?.item?.provider).toBe("gemini");
    const toolResult = events.find((ev) => ev.type === "provider_item" && ev.item.kind === "tool_result") as any;
    expect(toolResult?.item?.text).toBe("ok");
    expect(events).toContainEqual({ type: "usage", usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } });
    expect(events[events.length - 1]).toEqual({ type: "done", finalText: "Hello world", threadId: "sess_1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("gemini");
    expect(calls[0]?.args).toContain("--sandbox");
    expect(calls[0]?.args).toContain("--approval-mode");
    expect(calls[0]?.args).toContain("yolo");
    expect(calls[0]?.args).toContain("--output-format");
    expect(calls[0]?.args).toContain("stream-json");
    expect(calls[0]?.args).toContain("--allowed-tools");
    expect(calls[0]?.args).toContain("Bash");
  });

  it("suppresses deltas and emits normalized JSON in schema mode", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      proc.complete({
        lines: [
          JSON.stringify({
            type: "message",
            role: "assistant",
            content: "I will do that.\n{\"action\":\"run_script\",\"script_path\":\"act.py\"}",
            delta: true,
            session_id: "sess_schema",
          }),
          JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }),
        ],
      });
    }, calls);
    const provider = new GeminiProvider(baseConfig, { spawn });
    const schema = { type: "object", properties: { action: { type: "string" } }, required: ["action"] };

    const events: ProviderEvent[] = [];
    for await (const ev of provider.runStreamed(promptContentFromText("return json"), { outputSchema: schema })) {
      events.push(ev);
    }

    expect(events.some((ev) => ev.type === "assistant_delta")).toBe(false);
    const assistant = events.find((ev) => ev.type === "assistant_message") as any;
    expect(assistant).toBeTruthy();
    expect(JSON.parse(assistant.text)).toEqual({ action: "run_script", script_path: "act.py" });
    const promptFlagIndex = calls[0]?.args.findIndex((arg) => arg === "--prompt") ?? -1;
    expect(promptFlagIndex).toBeGreaterThan(-1);
    const promptText = String(calls[0]?.args[promptFlagIndex + 1] ?? "");
    expect(promptText).toContain("JSON Schema:");
  });

  it("supports runOnce resume and returns normalized provider items", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      proc.complete({
        lines: [
          JSON.stringify({ type: "init", session_id: "sess_new" }),
          JSON.stringify({ type: "tool_use", tool_name: "Bash", tool_id: "tool_2", parameters: { command: "pwd" } }),
          JSON.stringify({ type: "message", role: "assistant", content: "Done", delta: true }),
          JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }),
        ],
      });
    }, calls);
    const provider = new GeminiProvider({ ...baseConfig, threadId: "sess_old" }, { spawn });

    const result = await provider.runOnce(promptContentFromText("continue"));

    expect(result.threadId).toBe("sess_new");
    expect(result.text).toBe("Done");
    expect((result.items ?? []).some((item: any) => item.kind === "tool_call")).toBe(true);
    expect(calls[0]?.args).toContain("--resume");
    expect(calls[0]?.args).toContain("sess_old");
  });

  it("honors provider command/args/home options and includes image references in prompt", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      proc.complete({
        lines: [JSON.stringify({ type: "result", status: "success" })],
      });
    }, calls);
    const provider = new GeminiProvider(
      {
        ...baseConfig,
        env: { TEST_ENV: "1" },
        providerOptions: {
          command: "gemini-custom",
          args: ["--debug"],
          home: "/tmp/gemini-home",
          allowedTools: ["Read", "Write"],
        },
      },
      { spawn },
    );

    await provider.runOnce([
      ...promptContentFromText("describe image"),
      { type: "image", path: "/tmp/screenshots/test image.png" },
    ]);

    expect(calls[0]?.command).toBe("gemini-custom");
    expect(calls[0]?.args[0]).toBe("--debug");
    expect(calls[0]?.args).toContain("--allowed-tools");
    expect(calls[0]?.args).toContain("Read");
    expect(calls[0]?.args).toContain("Write");
    expect(calls[0]?.options?.env).toMatchObject({
      TEST_ENV: "1",
      GEMINI_CLI_HOME: "/tmp/gemini-home",
    });
    const promptFlagIndex = calls[0]?.args.findIndex((arg) => arg === "--prompt") ?? -1;
    const promptText = String(calls[0]?.args[promptFlagIndex + 1] ?? "");
    expect(promptText).toContain("@/tmp/screenshots/test\\ image.png");
  });

  it("throws when disallowedTools are configured", async () => {
    const provider = new GeminiProvider(
      {
        ...baseConfig,
        providerOptions: {
          disallowedTools: ["Task"],
        },
      },
      { spawn: createSpawnStub(() => {}, []) },
    );

    await expect(provider.runOnce(promptContentFromText("deny"))).rejects.toThrow(
      "gemini provider does not support disallowedTools",
    );
  });

  it("filters network tools from strict allowedTools", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      proc.complete({
        lines: [JSON.stringify({ type: "result", status: "success" })],
      });
    }, calls);
    const provider = new GeminiProvider(
      {
        ...baseConfig,
        providerOptions: {
          allowedTools: ["Read", "Write", "WebFetch", "Browser"],
        },
      },
      { spawn },
    );

    await provider.runOnce(promptContentFromText("strict tools"));

    const args = calls[0]?.args ?? [];
    const allowedToolValues: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== "--allowed-tools") continue;
      allowedToolValues.push(String(args[i + 1] ?? ""));
    }
    expect(allowedToolValues).toContain("Read");
    expect(allowedToolValues).toContain("Write");
    expect(allowedToolValues).not.toContain("WebFetch");
    expect(allowedToolValues).not.toContain("Browser");
  });

  it("keeps legacy permissive tool policy in yolo profile", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      proc.complete({
        lines: [JSON.stringify({ type: "result", status: "success" })],
      });
    }, calls);
    const provider = new GeminiProvider(
      {
        ...baseConfig,
        permissionProfile: "yolo",
      },
      { spawn },
    );

    await provider.runOnce(promptContentFromText("yolo"));

    expect(calls[0]?.args).not.toContain("--allowed-tools");
  });

  it("disables sandbox in danger-full-access mode", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      proc.complete({
        lines: [JSON.stringify({ type: "result", status: "success" })],
      });
    }, calls);
    const provider = new GeminiProvider(
      {
        ...baseConfig,
        sandboxMode: "danger-full-access",
      },
      { spawn },
    );

    await provider.runOnce(promptContentFromText("danger"));

    expect(calls[0]?.args).not.toContain("--sandbox");
    expect(calls[0]?.args).toContain("--approval-mode");
    expect(calls[0]?.args).toContain("yolo");
  });

  it("maps read-only sandbox mode to plan approvals", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      proc.complete({
        lines: [JSON.stringify({ type: "result", status: "success" })],
      });
    }, calls);
    const provider = new GeminiProvider(
      {
        ...baseConfig,
        sandboxMode: "read-only",
      },
      { spawn },
    );

    await provider.runOnce(promptContentFromText("readonly"));

    expect(calls[0]?.args).toContain("--sandbox");
    expect(calls[0]?.args).toContain("--approval-mode");
    expect(calls[0]?.args).toContain("plan");
    expect(calls[0]?.args).not.toContain("yolo");
  });

  it("emits status error when gemini exits non-zero", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      proc.complete({
        lines: [],
        stderr: "fatal: prompt is too long",
        exitCode: 1,
      });
    }, calls);
    const provider = new GeminiProvider(baseConfig, { spawn });
    const events: ProviderEvent[] = [];
    for await (const ev of provider.runStreamed(promptContentFromText("fail"))) {
      events.push(ev);
    }

    const err = events.find((ev) => ev.type === "status" && ev.message.includes("gemini error"));
    expect(err).toBeTruthy();
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("emits status error and done when gemini spawn fails", async () => {
    const spawn = () => {
      const error = Object.assign(new Error("spawn failed"), {
        code: "ENOENT",
        syscall: "spawn /nonexistent/gemini",
        path: "/nonexistent/gemini",
      });
      throw error;
    };
    const provider = new GeminiProvider(baseConfig, { spawn: spawn as any });
    const events: ProviderEvent[] = [];
    for await (const ev of provider.runStreamed(promptContentFromText("spawn fail"))) {
      events.push(ev);
    }

    expect(events[0]).toEqual({ type: "status", message: "gemini: starting turn" });
    expect(events.some((ev) => ev.type === "status" && ev.message.includes("not found"))).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "done", finalText: undefined, threadId: undefined });
  });

  it("emits status error and done when spawned process emits an error event", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      queueMicrotask(() => {
        proc.emit(
          "error",
          Object.assign(new Error("spawn ENOENT"), {
            code: "ENOENT",
            syscall: "spawn /missing/gemini",
            path: "/missing/gemini",
          }),
        );
      });
      proc.complete({ lines: [], exitCode: 1 });
    }, calls);
    const provider = new GeminiProvider(baseConfig, { spawn });
    const events: ProviderEvent[] = [];
    for await (const ev of provider.runStreamed(promptContentFromText("spawn event fail"))) {
      events.push(ev);
    }

    expect(events[0]).toEqual({ type: "status", message: "gemini: starting turn" });
    expect(events.some((ev) => ev.type === "status" && ev.message.includes("not found"))).toBe(true);
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("finishes stream when process emits error without close", async () => {
    const calls: SpawnCall[] = [];
    const spawn = createSpawnStub((proc) => {
      queueMicrotask(() => {
        proc.emit(
          "error",
          Object.assign(new Error("spawn ENOENT"), {
            code: "ENOENT",
            syscall: "spawn /missing/gemini",
            path: "/missing/gemini",
          }),
        );
      });
    }, calls);
    const provider = new GeminiProvider(baseConfig, { spawn });
    const events: ProviderEvent[] = [];
    for await (const ev of provider.runStreamed(promptContentFromText("spawn event fail no close"))) {
      events.push(ev);
    }

    expect(events[0]).toEqual({ type: "status", message: "gemini: starting turn" });
    expect(events.some((ev) => ev.type === "status" && ev.message.includes("not found"))).toBe(true);
    expect(events[events.length - 1]?.type).toBe("done");
  });
});
