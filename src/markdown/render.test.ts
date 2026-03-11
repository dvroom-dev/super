import { describe, it, expect } from "bun:test";
import {
  renderFence,
  renderChat,
  renderToolCall,
  renderToolResult,
  renderCandidates,
  renderSupervisorReview,
  renderSupervisorSummary,
  renderSupervisorWarning,
  renderBlocks,
} from "./render.js";
import type { AnyBlock } from "./ast.js";

describe("renderFence", () => {
  it("renders a basic fence", () => {
    const result = renderFence("chat", { role: "user" }, "Hello");
    expect(result).toBe("```chat role=user\nHello\n```\n");
  });

  it("renders fence with multiple attrs", () => {
    const result = renderFence("chat", { role: "user", id: "msg_1" }, "Content");
    expect(result).toBe("```chat role=user id=msg_1\nContent\n```\n");
  });

  it("renders fence with empty attrs", () => {
    const result = renderFence("tool_result", {}, "Output");
    expect(result).toBe("```tool_result\nOutput\n```\n");
  });

  it("handles empty content", () => {
    const result = renderFence("chat", { role: "user" }, "");
    expect(result).toBe("```chat role=user\n\n```\n");
  });

  it("handles multiline content", () => {
    const result = renderFence("chat", { role: "user" }, "Line1\nLine2\nLine3");
    expect(result).toBe("```chat role=user\nLine1\nLine2\nLine3\n```\n");
  });

  it("uses a longer fence when content contains triple backticks", () => {
    const result = renderFence("chat", { role: "assistant" }, "Before\n```python\nx = 1\n```\nAfter");
    expect(result).toBe("````chat role=assistant\nBefore\n```python\nx = 1\n```\nAfter\n````\n");
  });
});

describe("renderChat", () => {
  it("renders user chat", () => {
    const result = renderChat("user", "Hello!");
    expect(result).toBe("```chat role=user\nHello!\n```\n");
  });

  it("renders assistant chat", () => {
    const result = renderChat("assistant", "Response here");
    expect(result).toBe("```chat role=assistant\nResponse here\n```\n");
  });

  it("renders with extra attrs", () => {
    const result = renderChat("assistant", "Content", { stream: "1" });
    expect(result).toBe("```chat role=assistant stream=1\nContent\n```\n");
  });

  it("renders system message", () => {
    const result = renderChat("system", "System prompt");
    expect(result).toBe("```chat role=system\nSystem prompt\n```\n");
  });
});

describe("renderToolCall", () => {
  it("renders shell tool call", () => {
    const result = renderToolCall("shell", '{"cmd":["ls"]}');
    expect(result).toBe('```tool_call name=shell\n{"cmd":["ls"]}\n```\n');
  });

  it("renders with extra attrs", () => {
    const result = renderToolCall("read_file", '{"path":"foo.txt"}', { id: "tc_1" });
    expect(result).toBe('```tool_call name=read_file id=tc_1\n{"path":"foo.txt"}\n```\n');
  });
});

describe("renderToolResult", () => {
  it("renders basic tool result", () => {
    const result = renderToolResult("(exit=0)\nOutput here");
    expect(result).toBe("```tool_result\n(exit=0)\nOutput here\n```\n");
  });

  it("renders with extra attrs", () => {
    const result = renderToolResult("Success", { id: "tr_1" });
    expect(result).toBe("```tool_result id=tr_1\nSuccess\n```\n");
  });
});

describe("renderCandidates", () => {
  it("renders with models", () => {
    const result = renderCandidates(["gpt-4", "gpt-3.5"], "Candidate responses");
    expect(result).toBe("```assistant_candidates models=gpt-4,gpt-3.5\nCandidate responses\n```\n");
  });

  it("renders with empty models", () => {
    const result = renderCandidates([], "Content");
    expect(result).toBe("```assistant_candidates models=\nContent\n```\n");
  });

  it("renders with extra attrs", () => {
    const result = renderCandidates(["model1"], "Content", { selected: "1" });
    expect(result).toBe("```assistant_candidates models=model1 selected=1\nContent\n```\n");
  });
});

describe("renderSupervisorReview", () => {
  it("renders review block", () => {
    const result = renderSupervisorReview("passed: true\n{}");
    expect(result).toBe("```supervisor_review\npassed: true\n{}\n```\n");
  });

  it("renders with extra attrs", () => {
    const result = renderSupervisorReview("content", { model: "gpt-4" });
    expect(result).toBe("```supervisor_review model=gpt-4\ncontent\n```\n");
  });
});

describe("renderSupervisorSummary", () => {
  it("renders summary block", () => {
    const result = renderSupervisorSummary("summary: time limit\nDetails here");
    expect(result).toBe("```supervisor_summary\nsummary: time limit\nDetails here\n```\n");
  });
});

describe("renderSupervisorWarning", () => {
  it("renders warning block", () => {
    const result = renderSupervisorWarning("violations: Rule X");
    expect(result).toBe("```supervisor_warning\nviolations: Rule X\n```\n");
  });
});

describe("renderBlocks", () => {
  it("renders multiple blocks", () => {
    const blocks: AnyBlock[] = [
      { kind: "chat", attrs: { role: "user" }, content: "Hello", startLine: 0, endLine: 2, role: "user" } as any,
      { kind: "chat", attrs: { role: "assistant" }, content: "Hi", startLine: 3, endLine: 5, role: "assistant" } as any,
    ];
    const result = renderBlocks(blocks);
    expect(result).toBe("```chat role=user\nHello\n```\n\n```chat role=assistant\nHi\n```\n");
  });

  it("handles empty array", () => {
    const result = renderBlocks([]);
    expect(result).toBe("");
  });
});
