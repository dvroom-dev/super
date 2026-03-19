import { describe, expect, it } from "bun:test";
import { applySdkBuiltinToolsToProviderOptions } from "./sdk_builtin_tools.js";

describe("applySdkBuiltinToolsToProviderOptions", () => {
  it("applies claude allow policy as tools only", () => {
    const options = applySdkBuiltinToolsToProviderOptions({
      provider: "claude",
      providerOptions: { debug: true },
      sdkBuiltinTools: {
        claude: {
          mode: "allow",
          names: ["Bash", "Read"],
        },
      },
    });
    expect(options).toEqual({
      debug: true,
      tools: ["Bash", "Read"],
    });
  });

  it("applies claude deny policy as disallowedTools", () => {
    const options = applySdkBuiltinToolsToProviderOptions({
      provider: "claude",
      providerOptions: { debug: true },
      sdkBuiltinTools: {
        claude: {
          mode: "deny",
          names: ["Task", "TodoWrite"],
        },
      },
    });
    expect(options).toEqual({
      debug: true,
      disallowedTools: ["Task", "TodoWrite"],
    });
  });

  it("accepts mock policy as a no-op for config parity", () => {
    const options = applySdkBuiltinToolsToProviderOptions({
      provider: "mock",
      providerOptions: { debug: true },
      sdkBuiltinTools: {
        mock: {
          mode: "allow",
          names: ["Read", "Write"],
        },
      },
    });
    expect(options).toEqual({
      debug: true,
    });
  });

  it("rejects conflicting allow/deny values across provider options and sdk policy", () => {
    expect(() =>
      applySdkBuiltinToolsToProviderOptions({
        provider: "claude",
        providerOptions: { disallowedTools: ["Task"] },
        sdkBuiltinTools: {
          claude: {
            mode: "allow",
            names: ["Read"],
          },
        },
      })).toThrow("sdk_builtin_tools.claude.allow conflicts with provider_options.claude.disallowedTools");
  });

  it("rejects conflicting claude tools value when allow policy is configured", () => {
    expect(() =>
      applySdkBuiltinToolsToProviderOptions({
        provider: "claude",
        providerOptions: { tools: ["Read"] },
        sdkBuiltinTools: {
          claude: {
            mode: "allow",
            names: ["Bash"],
          },
        },
      })).toThrow("sdk_builtin_tools.claude.allow conflicts with provider_options.claude.tools");
  });

  it("applies codex allow policy as allowedTools", () => {
    const options = applySdkBuiltinToolsToProviderOptions({
      provider: "codex",
      providerOptions: { debug: true },
      sdkBuiltinTools: {
        codex: {
          mode: "allow",
          names: ["Bash", "Read"],
        },
      },
    });
    expect(options).toEqual({
      debug: true,
      allowedTools: ["commandExecution"],
    });
  });

  it("maps codex file-editing allow policy to fileChange", () => {
    const options = applySdkBuiltinToolsToProviderOptions({
      provider: "codex",
      providerOptions: { debug: true },
      sdkBuiltinTools: {
        codex: {
          mode: "allow",
          names: ["Read", "Edit", "MultiEdit", "Write"],
        },
      },
    });
    expect(options).toEqual({
      debug: true,
      allowedTools: ["commandExecution", "fileChange"],
    });
  });

  it("applies codex deny policy as disallowedTools", () => {
    const options = applySdkBuiltinToolsToProviderOptions({
      provider: "codex",
      providerOptions: { debug: true },
      sdkBuiltinTools: {
        codex: {
          mode: "deny",
          names: ["Task", "WebSearch"],
        },
      },
    });
    expect(options).toEqual({
      debug: true,
      disallowedTools: ["Task", "WebSearch"],
    });
  });

  it("rejects conflicting codex allow/deny values across provider options and sdk policy", () => {
    expect(() =>
      applySdkBuiltinToolsToProviderOptions({
        provider: "codex",
        providerOptions: { disallowedTools: ["Task"] },
        sdkBuiltinTools: {
          codex: {
            mode: "allow",
            names: ["Read"],
          },
        },
      })).toThrow("sdk_builtin_tools.codex.allow conflicts with provider_options.codex.disallowedTools");
  });

  it("rejects missing active provider policy when another provider is configured", () => {
    expect(() =>
      applySdkBuiltinToolsToProviderOptions({
        provider: "codex",
        sdkBuiltinTools: {
          claude: {
            mode: "allow",
            names: ["Read"],
          },
        },
        label: "tools.provider_builtin_tools",
      })).toThrow("tools.provider_builtin_tools is configured for claude but missing active provider 'codex'");
  });
});
