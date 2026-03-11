import { describe, expect, it } from "bun:test";
import type { NormalizedProviderItem } from "../../../providers/types.js";
import { renderProviderItemForTranscript } from "./provider_transcript.js";

describe("renderProviderItemForTranscript", () => {
  it("renders provider tool results as tool_result blocks with output refs", () => {
    const item: NormalizedProviderItem = {
      provider: "codex",
      kind: "tool_result",
      type: "command_execution",
      summary: "tool_result command_execution python",
      status: "completed",
      text: "done",
      includeInTranscript: true,
      details: { command: "python tests/submission_tests.py", exit_code: 0 },
      outputRefs: [
        {
          path: "text",
          responseId: "toolresp_1",
          page: 1,
          totalPages: 2,
          totalLines: 300,
          totalBytes: 8192,
          filePath: ".ai-supervisor/conversations/conv/tool_outputs/toolresp_1.txt",
        },
      ],
    };

    const markdown = renderProviderItemForTranscript(item);
    expect(markdown).not.toBeNull();
    expect(markdown).toContain("```tool_result");
    expect(markdown).toContain("summary: tool_result command_execution python");
    expect(markdown).toContain("command: python tests/submission_tests.py");
    expect(markdown).toContain("<full results at .ai-supervisor/conversations/conv/tool_outputs/toolresp_1.txt>");
    expect(markdown).toContain("<page 1 of 2, run `paginate_tool_response toolresp_1 2` to see the next page>");
  });

  it("renders provider tool calls as tool_call blocks", () => {
    const item: NormalizedProviderItem = {
      provider: "claude",
      kind: "tool_call",
      type: "assistant.tool_use",
      name: "Bash",
      summary: "tool_call Bash",
      includeInTranscript: true,
      details: { command: "python act.py" },
    };

    const markdown = renderProviderItemForTranscript(item);
    expect(markdown).not.toBeNull();
    expect(markdown).toContain("```tool_call name=Bash");
    expect(markdown).toContain("\"provider\": \"claude\"");
    expect(markdown).toContain("\"summary\": \"tool_call Bash\"");
  });

  it("renders provider reasoning as synthetic reasoning_snapshot blocks", () => {
    const item: NormalizedProviderItem = {
      provider: "codex",
      kind: "assistant_meta",
      type: "reasoning",
      summary: "assistant_meta reasoning",
      includeInTranscript: true,
      text: "**Investigating performance bottleneck**",
    };

    const markdown = renderProviderItemForTranscript(item);
    expect(markdown).not.toBeNull();
    expect(markdown).toContain("```tool_call name=reasoning_snapshot");
    expect(markdown).toContain("```tool_result");
    expect(markdown).toContain("Investigating performance bottleneck");
  });

  it("skips items excluded from transcript", () => {
    const item: NormalizedProviderItem = {
      provider: "codex",
      kind: "other",
      type: "event",
      summary: "event",
      includeInTranscript: false,
    };
    expect(renderProviderItemForTranscript(item)).toBeNull();
  });
});
