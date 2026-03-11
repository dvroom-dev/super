export type FenceAttrs = Record<string, string>;

export type ChatRole = "user" | "assistant" | "system" | "developer" | "supervisor";

export type BlockBase = {
  kind: string;
  attrs: FenceAttrs;
  content: string;
  startLine: number;
  endLine: number;
};

export type ChatBlock = BlockBase & {
  kind: "chat";
  role: ChatRole;
};

export type ToolCallBlock = BlockBase & {
  kind: "tool_call";
  name: string;
};

export type ToolResultBlock = BlockBase & {
  kind: "tool_result";
};

export type CandidatesBlock = BlockBase & {
  kind: "assistant_candidates";
  models: string[];
};

export type AnyBlock = ChatBlock | ToolCallBlock | ToolResultBlock | CandidatesBlock | BlockBase;

export type ParseError = {
  message: string;
  line: number;
};

export type ParsedDocument = {
  blocks: AnyBlock[];
  errors: ParseError[];
};
