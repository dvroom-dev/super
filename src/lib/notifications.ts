import { combineTranscript } from "../server/stdio/helpers.ts";
import { parseChatMarkdown } from "../markdown/parse.ts";
import type { RpcNotificationInput } from "../protocol/rpc.ts";
import type { SuperEvent } from "./types.ts";
import { newId } from "./ids.ts";

function captureAssistantMessages(markdown: string, sink: string[]) {
  const parsed = parseChatMarkdown(markdown);
  for (const block of parsed.blocks as any[]) {
    if (block?.kind !== "chat") continue;
    if (block.role !== "assistant") continue;
    const text = String(block.content ?? "").trim();
    if (text) sink.push(text);
  }
}

function replaceAssistantMessages(markdown: string, sink: string[]) {
  sink.length = 0;
  captureAssistantMessages(markdown, sink);
}

function appendMarkdown(documentText: string, markdown: string, assistantMessages: string[]): string {
  const next = combineTranscript(documentText, [markdown]);
  captureAssistantMessages(markdown, assistantMessages);
  return next;
}

export function createNotificationHandler(args: {
  documentTextRef: { value: string };
  assistantMessages: string[];
  events: SuperEvent[];
  conversationId: string;
}) {
  return (note: RpcNotificationInput) => {
    const ts = new Date().toISOString();
    if (note.method === "conversation.append") {
      const markdown = String((note.params as any)?.markdown ?? "");
      if (!markdown) return;
      args.documentTextRef.value = appendMarkdown(args.documentTextRef.value, markdown, args.assistantMessages);
      args.events.push({
        event_id: newId("evt"),
        ts,
        kind: "conversation.append",
        conversation_id: args.conversationId,
        summary: markdown.slice(0, 120),
      });
      return;
    }
    if (note.method === "conversation.replace") {
      const nextDoc = String((note.params as any)?.documentText ?? "");
      if (!nextDoc) return;
      args.documentTextRef.value = nextDoc;
      replaceAssistantMessages(nextDoc, args.assistantMessages);
      args.events.push({
        event_id: newId("evt"),
        ts,
        kind: "conversation.replace",
        conversation_id: args.conversationId,
      });
      return;
    }
    if (note.method === "fork.created") {
      args.events.push({
        event_id: newId("evt"),
        ts,
        kind: "fork.created",
        conversation_id: args.conversationId,
        fork_id: String((note.params as any)?.forkId ?? ""),
      });
      return;
    }
    if (note.method === "conversation.supervisor_run_start" || note.method === "conversation.supervisor_run_end" || note.method === "conversation.supervisor_turn_decision") {
      args.events.push({
        event_id: newId("evt"),
        ts,
        kind: note.method,
        conversation_id: args.conversationId,
        summary: JSON.stringify(note.params ?? {}),
      });
      return;
    }
    if (note.method === "conversation.status" || note.method === "log") {
      const message = String((note.params as any)?.message ?? "").trim();
      if (message) {
        process.stderr.write(`[super] ${note.method === "log" ? "log" : "status"}: ${message}\n`);
      }
      return;
    }
  };
}
