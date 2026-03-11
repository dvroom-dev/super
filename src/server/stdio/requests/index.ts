import type { RuntimeContext } from "./context.js";
import { handleInitialize } from "./initialize.js";
import { handleDocumentParse } from "./document.js";
import { handleToolExecute } from "./tool.js";
import { handleForkList, handleForkListByDoc, handleForkTree, handleForkCheckout } from "./fork.js";
import { handleConversationContext } from "./conversation_context.js";
import { handleConversationNewDocument } from "./conversation_new_document.js";
import { handleConversationSupervise } from "./conversation_supervise.js";
import { handleConversationInspect } from "./conversation_inspect.js";
import { handleConversationStop } from "./conversation_stop.js";

export async function handleRequest(ctx: RuntimeContext, method: string, params: any) {
  switch (method) {
    case "initialize":
      return handleInitialize(ctx, params);
    case "document.parse":
      return handleDocumentParse(ctx, params);
    case "conversation.context":
      return handleConversationContext(ctx, params);
    case "conversation.newDocument":
      return handleConversationNewDocument(ctx, params);
    case "tool.execute":
      return handleToolExecute(ctx, params);
    case "fork.list":
      return handleForkList(ctx, params);
    case "fork.list_by_doc":
      return handleForkListByDoc(ctx, params);
    case "fork.tree":
      return handleForkTree(ctx, params);
    case "fork.checkout":
      return handleForkCheckout(ctx, params);
    case "conversation.supervise":
      return handleConversationSupervise(ctx, params);
    case "conversation.inspect":
      return handleConversationInspect(ctx, params);
    case "conversation.stop":
      return handleConversationStop(ctx, params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
