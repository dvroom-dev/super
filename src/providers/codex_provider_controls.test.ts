import { describe, expect, it } from "bun:test";
import { CodexProvider } from "./codex_provider.js";
import type { ProviderConfig } from "./types.js";
import { promptContentFromText } from "../utils/prompt_content.js";
import type {
  CodexAppServerClientLike,
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
  private handlers = new Map<string, (params?: unknown, options?: CodexAppServerRequestOptions) => unknown | Promise<unknown>>();
  private notificationHandlers = new Set<(notification: CodexAppServerNotification) => void>();

  setHandler(
    method: string,
    handler: (params?: unknown, options?: CodexAppServerRequestOptions) => unknown | Promise<unknown>,
  ) {
    this.handlers.set(method, handler);
  }

  emit(method: string, params?: unknown) {
    const notification = { method, params };
    for (const handler of [...this.notificationHandlers]) handler(notification);
  }

  async start(): Promise<void> {
    // no-op
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

  async waitForNotification(): Promise<CodexAppServerNotification> {
    throw new Error("not used in control tests");
  }

  async close(): Promise<void> {
    this.notificationHandlers.clear();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for condition");
}

describe("CodexProvider active turn controls", () => {
  const baseConfig: ProviderConfig = {
    provider: "codex",
    model: "gpt-5.3-codex",
    workingDirectory: "/tmp/work",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  };

  function createProvider(fakeClient: FakeAppServerClient): CodexProvider {
    return new CodexProvider(baseConfig, { appServerFactory: () => fakeClient });
  }

  async function startActiveTurn(provider: CodexProvider, fakeClient: FakeAppServerClient, threadId: string, turnId: string) {
    fakeClient.setHandler("thread/start", () => ({ thread: { id: threadId } }));
    fakeClient.setHandler("turn/start", () => ({ turn: { id: turnId } }));
    const stream = provider.runStreamed(promptContentFromText("run"));
    const status = await stream.next();
    expect(status.value).toEqual({ type: "status", message: "codex: starting turn" });
    const pending = stream.next();
    await waitFor(() => fakeClient.requests.some((record) => record.method === "turn/start"));
    // Let runStreamed advance past turn/start await and set activeTurnId.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { stream, pending };
  }

  it("steers active turns with turn/steer and expectedTurnId", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("turn/steer", () => ({ turnId: "turn_steer" }));
    const provider = createProvider(fakeClient);
    const { pending } = await startActiveTurn(provider, fakeClient, "thread_steer", "turn_steer");

    const steerResult = await provider.steerActiveTurn?.(promptContentFromText("supervisor advice"));

    expect(steerResult).toEqual({
      applied: true,
      deferred: false,
      threadId: "thread_steer",
      turnId: "turn_steer",
    });
    const steerRequest = fakeClient.requests.find((record) => record.method === "turn/steer");
    expect((steerRequest?.params as any)?.threadId).toBe("thread_steer");
    expect((steerRequest?.params as any)?.turnId).toBe("turn_steer");
    expect((steerRequest?.params as any)?.expectedTurnId).toBe("turn_steer");
    expect((steerRequest?.params as any)?.input).toEqual([{ type: "text", text: "supervisor advice" }]);

    fakeClient.emit("turn/completed", {
      threadId: "thread_steer",
      turn: { id: "turn_steer", status: "completed" },
    });
    const done = await pending;
    expect(done.value).toEqual({ type: "done", finalText: undefined, threadId: "thread_steer" });
  });

  it("updates the active turn id when turn/steer returns a replacement turn id", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("turn/steer", () => ({ turnId: "turn_replaced" }));
    fakeClient.setHandler("turn/interrupt", () => ({}));
    const provider = createProvider(fakeClient);
    const { pending } = await startActiveTurn(provider, fakeClient, "thread_replace", "turn_old");

    const steerResult = await provider.steerActiveTurn?.(promptContentFromText("supervisor advice"));
    expect(steerResult).toEqual({
      applied: true,
      deferred: false,
      threadId: "thread_replace",
      turnId: "turn_replaced",
    });

    const interruptResult = await provider.interruptActiveTurn?.({ reason: "followup_stop" });
    expect(interruptResult).toEqual({
      interrupted: true,
      threadId: "thread_replace",
      turnId: "turn_replaced",
    });
    const interruptRequest = fakeClient.requests.find((record) => record.method === "turn/interrupt");
    expect((interruptRequest?.params as any)?.turnId).toBe("turn_replaced");

    fakeClient.emit("turn/completed", {
      threadId: "thread_replace",
      turn: { id: "turn_replaced", status: "completed" },
    });
    await pending;
  });

  it("tracks turn/started notifications after a steer-triggered rollover", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("turn/steer", () => ({ turnId: "turn_old" }));
    fakeClient.setHandler("turn/interrupt", () => ({}));
    const provider = createProvider(fakeClient);
    const { pending } = await startActiveTurn(provider, fakeClient, "thread_rollover", "turn_old");

    await provider.steerActiveTurn?.(promptContentFromText("supervisor advice"));
    fakeClient.emit("turn/started", {
      threadId: "thread_rollover",
      turn: { id: "turn_new" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const interruptResult = await provider.interruptActiveTurn?.({ reason: "after_rollover" });
    expect(interruptResult).toEqual({
      interrupted: true,
      threadId: "thread_rollover",
      turnId: "turn_new",
    });
    const interruptRequest = fakeClient.requests.find((record) => record.method === "turn/interrupt");
    expect((interruptRequest?.params as any)?.turnId).toBe("turn_new");

    fakeClient.emit("turn/completed", {
      threadId: "thread_rollover",
      turn: { id: "turn_new", status: "completed" },
    });
    await pending;
  });

  it("defers steering when expectedTurnId is stale", async () => {
    const fakeClient = new FakeAppServerClient();
    const provider = createProvider(fakeClient);
    const { pending } = await startActiveTurn(provider, fakeClient, "thread_stale", "turn_stale");

    const steerResult = await provider.steerActiveTurn?.(promptContentFromText("advice"), { expectedTurnId: "turn_old" });

    expect(steerResult).toEqual({
      applied: false,
      deferred: true,
      reason: "stale expected turn id",
      threadId: "thread_stale",
      turnId: "turn_stale",
    });
    expect(fakeClient.requests.some((record) => record.method === "turn/steer")).toBe(false);

    fakeClient.emit("turn/completed", {
      threadId: "thread_stale",
      turn: { id: "turn_stale", status: "completed" },
    });
    await pending;
  });

  it("interrupts active turns with turn/interrupt", async () => {
    const fakeClient = new FakeAppServerClient();
    fakeClient.setHandler("turn/interrupt", () => ({}));
    const provider = createProvider(fakeClient);
    const { pending } = await startActiveTurn(provider, fakeClient, "thread_interrupt", "turn_interrupt");

    const interruptResult = await provider.interruptActiveTurn?.({ reason: "urgent_stop" });

    expect(interruptResult).toEqual({
      interrupted: true,
      threadId: "thread_interrupt",
      turnId: "turn_interrupt",
    });
    const interruptRequest = fakeClient.requests.find((record) => record.method === "turn/interrupt");
    expect((interruptRequest?.params as any)?.threadId).toBe("thread_interrupt");
    expect((interruptRequest?.params as any)?.turnId).toBe("turn_interrupt");
    expect((interruptRequest?.params as any)?.reason).toBe("urgent_stop");

    fakeClient.emit("turn/completed", {
      threadId: "thread_interrupt",
      turn: { id: "turn_interrupt", status: "completed" },
    });
    await pending;
  });

  it("returns no-active-turn result when interrupt is requested without a running turn", async () => {
    const provider = createProvider(new FakeAppServerClient());

    const interruptResult = await provider.interruptActiveTurn?.({ reason: "noop" });

    expect(interruptResult).toEqual({
      interrupted: false,
      reason: "no active turn",
      threadId: undefined,
      turnId: undefined,
    });
  });
});
