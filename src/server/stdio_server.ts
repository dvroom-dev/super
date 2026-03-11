import readline from "node:readline";
import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { SupervisorStore } from "../store/store.js";
import type { RpcRequest, RpcResponse, RpcNotification, RpcNotificationInput } from "../protocol/rpc.js";
import { handleRequest } from "./stdio/requests/index.js";
import type { ServerState } from "./stdio/types.js";

export class StdioRpcServer {
  private store: SupervisorStore;
  private state: ServerState = {};
  private rl: readline.Interface;
  private logPath: string;

  constructor(store: SupervisorStore) {
    this.store = store;
    this.rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    this.logPath = path.join(this.store.getSupervisorHome(), "logs", "stdio.log");
  }

  private log(line: string) {
    const stamp = new Date().toISOString();
    const entry = `[${stamp}] ${line}\n`;
    const dir = path.dirname(this.logPath);
    void fs
      .mkdir(dir, { recursive: true })
      .then(() => fs.appendFile(this.logPath, entry))
      .catch(() => undefined);
  }

  start() {
    this.rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: RpcRequest;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.log(`error: failed to parse JSON (len=${trimmed.length})`);
        this.sendNotification({ method: "log", params: { level: "error", message: "Failed to parse JSON line" } });
        return;
      }
      if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || typeof msg.id !== "string") {
        this.log(`error: invalid RPC request (method=${String((msg as any)?.method ?? "unknown")})`);
        this.sendNotification({ method: "log", params: { level: "error", message: "Invalid RPC request" } });
        return;
      }
      try {
        const result = await handleRequest(
          {
            store: this.store,
            state: this.state,
            sendNotification: (note) => this.sendNotification(note),
            requireWorkspaceRoot: (params) => this.requireWorkspaceRoot(params),
          },
          msg.method,
          msg.params
        );
        this.sendResponse({ jsonrpc: "2.0", id: msg.id, result });
      } catch (e: any) {
        this.log(
          `error: method=${msg.method} message=${e?.message ?? String(e)}${e?.stack ? ` stack=${String(e.stack)}` : ""}`
        );
        this.sendResponse({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: 1, message: e?.message ?? String(e), data: e?.stack ? { stack: String(e.stack) } : undefined },
        });
      }
    });

    this.log("server started");
    this.sendNotification({ method: "ready", params: { supervisorHome: this.store.getSupervisorHome() } });
  }

  private send(obj: RpcResponse | RpcNotification) {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }

  private sendResponse(res: RpcResponse) {
    this.send(res);
  }

  private sendNotification(note: RpcNotificationInput) {
    const payload: RpcNotification = { jsonrpc: "2.0", method: note.method, params: note.params };
    this.send(payload);
  }

  private requireWorkspaceRoot(params: any): string {
    const wr = params?.workspaceRoot ?? this.state.workspaceRoot;
    if (!wr || typeof wr !== "string") throw new Error("workspaceRoot is required");
    this.state.workspaceRoot = wr;
    return wr;
  }
}
