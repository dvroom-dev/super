import { describe, expect, it } from "bun:test";
import { createNotificationHandler } from "./notifications.ts";

describe("createNotificationHandler", () => {
  it("replaces the captured assistant sink when conversation.replace arrives", () => {
    const documentTextRef = { value: "" };
    const assistantMessages: string[] = [];
    const events: any[] = [];
    const handleNotification = createNotificationHandler({
      documentTextRef,
      assistantMessages,
      events,
      conversationId: "conversation_test",
    });

    handleNotification({
      method: "conversation.append",
      params: {
        markdown: [
          "```chat role=assistant",
          "old assistant",
          "```",
        ].join("\n"),
      },
    });
    handleNotification({
      method: "conversation.replace",
      params: {
        documentText: [
          "---",
          "conversation_id: conversation_test",
          "fork_id: fork_test",
          "---",
          "",
          "```chat role=assistant",
          "new assistant",
          "```",
        ].join("\n"),
      },
    });

    expect(assistantMessages).toEqual(["new assistant"]);
    expect(documentTextRef.value).toContain("new assistant");
  });
});
