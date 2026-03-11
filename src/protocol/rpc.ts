export type JsonValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | JsonValue[]
  | { [k: string]: JsonValue };

export type RpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: JsonValue;
};

export type RpcNotificationInput = {
  method: string;
  params?: JsonValue;
};

export type RpcNotification = RpcNotificationInput & {
  jsonrpc: "2.0";
};

export type RpcResponse =
  | { jsonrpc: "2.0"; id: string; result: JsonValue }
  | { jsonrpc: "2.0"; id: string; error: { code: number; message: string; data?: JsonValue } };

export function isRpcRequest(v: any): v is RpcRequest {
  return v && v.jsonrpc === "2.0" && typeof v.id === "string" && typeof v.method === "string";
}

export function isRpcNotification(v: any): v is RpcNotification {
  return v && v.jsonrpc === "2.0" && v.id === undefined && typeof v.method === "string";
}
