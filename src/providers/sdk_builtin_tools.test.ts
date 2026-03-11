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

  it("applies gemini allow policy as allowedTools", () => {
    const options = applySdkBuiltinToolsToProviderOptions({
      provider: "gemini",
      providerOptions: { command: "gemini" },
      sdkBuiltinTools: {
        gemini: {
          mode: "allow",
          names: ["Read", "Write"],
        },
      },
    });
    expect(options).toEqual({
      command: "gemini",
      allowedTools: ["Read", "Write"],
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

  it("rejects unsupported gemini deny policy", () => {
    expect(() =>
      applySdkBuiltinToolsToProviderOptions({
        provider: "gemini",
        sdkBuiltinTools: {
          gemini: {
            mode: "deny",
            names: ["Task"],
          },
        },
      })).toThrow("sdk_builtin_tools.gemini.deny is not supported");
  });

  it("rejects unsupported codex sdk tool policy", () => {
    expect(() =>
      applySdkBuiltinToolsToProviderOptions({
        provider: "codex",
        sdkBuiltinTools: {
          codex: {
            mode: "allow",
            names: ["shell"],
          },
        },
      })).toThrow("sdk_builtin_tools.codex is not supported");
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
