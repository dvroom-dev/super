import { describe, expect, it } from "bun:test";
import { runSupervisorSchemaPreflight } from "./schema_preflight.js";

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    supervisorWorkspaceRoot: "/tmp/preflight",
    providerName: "codex" as const,
    supervisorModel: "gpt-5.3-codex",
    permissionProfile: "workspace_no_network" as const,
    allowedNextModes: ["default"],
    modePayloadFieldsByMode: { default: [] },
    timeoutMs: 50,
    ...overrides,
  };
}

describe("runSupervisorSchemaPreflight", () => {
  it("fails fast with a timeout when provider runOnce stalls", async () => {
    let closeCalled = false;
    await expect(
      runSupervisorSchemaPreflight(
        makeArgs({
          timeoutMs: 25,
          providerFactory: () =>
            ({
              async runOnce(_prompt: unknown, options?: { signal?: AbortSignal }) {
                await new Promise<void>((_resolve, reject) => {
                  const onAbort = () => {
                    const err = new Error("Aborted");
                    (err as { name?: string }).name = "AbortError";
                    reject(err);
                  };
                  if (options?.signal?.aborted) {
                    onAbort();
                    return;
                  }
                  options?.signal?.addEventListener("abort", onAbort, { once: true });
                });
                return { text: "" };
              },
              async close() {
                closeCalled = true;
              },
            }),
        }),
      ),
    ).rejects.toThrow("supervisor schema preflight timed out");
    expect(closeCalled).toBe(true);
  });

  it("skips preflight entirely for mock provider", async () => {
    let called = false;
    await runSupervisorSchemaPreflight(
      makeArgs({
        providerName: "mock",
        providerFactory: () => {
          called = true;
          return {
            async runOnce() {
              return { text: "{}" };
            },
          };
        },
      }),
    );
    expect(called).toBe(false);
  });

  it("completes when provider returns successfully", async () => {
    let signalSeen = false;
    await runSupervisorSchemaPreflight(
      makeArgs({
        providerFactory: () =>
          ({
            async runOnce(_prompt: unknown, options?: { signal?: AbortSignal }) {
              signalSeen = options?.signal instanceof AbortSignal;
              return { text: "{}" };
            },
          }),
      }),
    );
    expect(signalSeen).toBe(true);
  });
});
