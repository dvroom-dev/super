import { describe, it, expect } from "bun:test";
import { parseChatMarkdown, extractChatBlocks, lastUserMessage } from "./parse.js";

const fm = ["---", "conversation_id: test", "fork_id: fork_1", "---", ""].join("\n");

describe("parseChatMarkdown", () => {
  it("parses a simple user chat block", () => {
    const text = `${fm}\`\`\`chat role=user
Hello, world!
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(0);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe("chat");
    expect((doc.blocks[0] as any).role).toBe("user");
    expect(doc.blocks[0].content).toBe("Hello, world!");
  });

  it("reports error for missing fork_id", () => {
    const text = `---\nconversation_id: test\n---\n\n\`\`\`chat role=user\nHello\n\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0].message).toContain("fork_id");
  });

  it("parses multiple chat blocks", () => {
    const text = `${fm}\`\`\`chat role=user
Question?
\`\`\`

\`\`\`chat role=assistant
Answer!
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(0);
    expect(doc.blocks).toHaveLength(2);
    expect((doc.blocks[0] as any).role).toBe("user");
    expect((doc.blocks[1] as any).role).toBe("assistant");
  });

  it("parses all valid chat roles", () => {
    const roles = ["user", "assistant", "system", "developer", "supervisor"];
    for (const role of roles) {
      const text = `${fm}\`\`\`chat role=${role}\nContent\n\`\`\``;
      const doc = parseChatMarkdown(text);
      expect(doc.errors).toHaveLength(0);
      expect((doc.blocks[0] as any).role).toBe(role);
    }
  });

  it("reports error for chat block without role", () => {
    const text = `${fm}\`\`\`chat
Missing role
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0].message).toContain("missing valid role");
  });

  it("reports error for invalid role", () => {
    const text = `${fm}\`\`\`chat role=invalid
Bad role
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0].message).toContain("missing valid role");
  });

  it("parses tool_call blocks", () => {
    const text = `${fm}\`\`\`tool_call name=shell
{"cmd":["ls","-la"]}
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(0);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe("tool_call");
    expect((doc.blocks[0] as any).name).toBe("shell");
  });

  it("reports error for tool_call without name", () => {
    const text = `${fm}\`\`\`tool_call
{"cmd":["ls"]}
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0].message).toContain("missing name");
  });

  it("parses tool_result blocks", () => {
    const text = `${fm}\`\`\`tool_result
(exit=0)
output here
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(0);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe("tool_result");
  });

  it("parses assistant_candidates blocks", () => {
    const text = `${fm}\`\`\`assistant_candidates models=gpt-4,gpt-3.5
[1] response 1
---
[2] response 2
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(0);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe("assistant_candidates");
    expect((doc.blocks[0] as any).models).toEqual(["gpt-4", "gpt-3.5"]);
  });

  it("parses assistant_candidates with empty models", () => {
    const text = `${fm}\`\`\`assistant_candidates
content
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(0);
    expect((doc.blocks[0] as any).models).toEqual([]);
  });

  it("reports error for unclosed fence", () => {
    const text = `${fm}\`\`\`chat role=user
Never closed`;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors[0].message).toContain("Unclosed");
  });

  it("preserves line numbers in blocks", () => {
    const text = `${fm}Some intro text

\`\`\`chat role=user
Hello
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.blocks[0].startLine).toBe(6);
    expect(doc.blocks[0].endLine).toBe(8);
  });

  it("ignores regular code blocks", () => {
    const text = `${fm}\`\`\`javascript
const x = 1;
\`\`\`

\`\`\`chat role=user
Message
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0].kind).toBe("javascript");
    expect(doc.blocks[1].kind).toBe("chat");
  });

  it("parses multiple attributes", () => {
    const text = `${fm}\`\`\`chat role=user id=msg_1 stream=1
Content
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.blocks[0].attrs).toEqual({
      role: "user",
      id: "msg_1",
      stream: "1",
    });
  });

  it("handles multiline content", () => {
    const text = `${fm}\`\`\`chat role=user
Line 1
Line 2
Line 3
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.blocks[0].content).toBe("Line 1\nLine 2\nLine 3");
  });

  it("handles empty content", () => {
    const text = `${fm}\`\`\`chat role=user
\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.blocks[0].content).toBe("");
  });

  it("parses fences longer than triple backticks", () => {
    const text = `${fm}\`\`\`\`chat role=assistant
content
\`\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(0);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe("chat");
    expect((doc.blocks[0] as any).role).toBe("assistant");
    expect(doc.blocks[0].content).toBe("content");
  });

  it("keeps triple-backtick code blocks inside longer chat fences", () => {
    const text = `${fm}\`\`\`\`chat role=assistant
Before
\`\`\`python
print("hello")
\`\`\`
After
\`\`\`\``;
    const doc = parseChatMarkdown(text);
    expect(doc.errors).toHaveLength(0);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe("chat");
    expect(doc.blocks[0].content).toBe('Before\n```python\nprint("hello")\n```\nAfter');
  });
});

describe("extractChatBlocks", () => {
  it("extracts only chat blocks", () => {
    const text = `${fm}\`\`\`chat role=user
User message
\`\`\`

\`\`\`tool_call name=shell
{"cmd":["ls"]}
\`\`\`

\`\`\`chat role=assistant
Assistant message
\`\`\``;
    const doc = parseChatMarkdown(text);
    const chats = extractChatBlocks(doc);
    expect(chats).toHaveLength(2);
    expect(chats[0].role).toBe("user");
    expect(chats[1].role).toBe("assistant");
  });

  it("returns empty array when no chat blocks", () => {
    const text = `${fm}\`\`\`tool_call name=shell
{"cmd":["ls"]}
\`\`\``;
    const doc = parseChatMarkdown(text);
    const chats = extractChatBlocks(doc);
    expect(chats).toHaveLength(0);
  });
});

describe("lastUserMessage", () => {
  it("finds the last user message", () => {
    const text = `${fm}\`\`\`chat role=user
First
\`\`\`

\`\`\`chat role=assistant
Response
\`\`\`

\`\`\`chat role=user
Last user message
\`\`\``;
    const doc = parseChatMarkdown(text);
    const last = lastUserMessage(doc);
    expect(last).toBeDefined();
    expect(last!.content).toBe("Last user message");
  });

  it("returns undefined when no user messages", () => {
    const text = `${fm}\`\`\`chat role=assistant
Only assistant
\`\`\``;
    const doc = parseChatMarkdown(text);
    const last = lastUserMessage(doc);
    expect(last).toBeUndefined();
  });

  it("returns undefined for empty document", () => {
    const doc = parseChatMarkdown("");
    const last = lastUserMessage(doc);
    expect(last).toBeUndefined();
  });
});
