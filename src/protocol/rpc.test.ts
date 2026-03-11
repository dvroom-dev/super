import { describe, it, expect } from "bun:test";
import { isRpcRequest, isRpcNotification } from "./rpc.js";

describe("isRpcRequest", () => {
  it("returns true for valid request", () => {
    const req = {
      jsonrpc: "2.0",
      id: "1",
      method: "test",
    };
    expect(isRpcRequest(req)).toBe(true);
  });

  it("returns true for request with params", () => {
    const req = {
      jsonrpc: "2.0",
      id: "abc",
      method: "test.method",
      params: { key: "value" },
    };
    expect(isRpcRequest(req)).toBe(true);
  });

  it("returns false when jsonrpc is missing", () => {
    const req = {
      id: "1",
      method: "test",
    };
    expect(isRpcRequest(req)).toBe(false);
  });

  it("returns false when jsonrpc is wrong version", () => {
    const req = {
      jsonrpc: "1.0",
      id: "1",
      method: "test",
    };
    expect(isRpcRequest(req)).toBe(false);
  });

  it("returns false when id is missing", () => {
    const req = {
      jsonrpc: "2.0",
      method: "test",
    };
    expect(isRpcRequest(req)).toBe(false);
  });

  it("returns false when id is not a string", () => {
    const req = {
      jsonrpc: "2.0",
      id: 123,
      method: "test",
    };
    expect(isRpcRequest(req)).toBe(false);
  });

  it("returns false when method is missing", () => {
    const req = {
      jsonrpc: "2.0",
      id: "1",
    };
    expect(isRpcRequest(req)).toBe(false);
  });

  it("returns false when method is not a string", () => {
    const req = {
      jsonrpc: "2.0",
      id: "1",
      method: 123,
    };
    expect(isRpcRequest(req)).toBe(false);
  });

  it("returns falsy for null", () => {
    expect(isRpcRequest(null)).toBeFalsy();
  });

  it("returns falsy for undefined", () => {
    expect(isRpcRequest(undefined)).toBeFalsy();
  });

  it("returns falsy for primitive types", () => {
    expect(isRpcRequest("string")).toBeFalsy();
    expect(isRpcRequest(123)).toBeFalsy();
    expect(isRpcRequest(true)).toBeFalsy();
  });
});

describe("isRpcNotification", () => {
  it("returns true for valid notification", () => {
    const notif = {
      jsonrpc: "2.0",
      method: "notify",
    };
    expect(isRpcNotification(notif)).toBe(true);
  });

  it("returns true for notification with params", () => {
    const notif = {
      jsonrpc: "2.0",
      method: "log",
      params: { level: "info", message: "test" },
    };
    expect(isRpcNotification(notif)).toBe(true);
  });

  it("returns false when id is present", () => {
    const notif = {
      jsonrpc: "2.0",
      id: "1",
      method: "notify",
    };
    expect(isRpcNotification(notif)).toBe(false);
  });

  it("returns false when jsonrpc is missing", () => {
    const notif = {
      method: "notify",
    };
    expect(isRpcNotification(notif)).toBe(false);
  });

  it("returns false when jsonrpc is wrong version", () => {
    const notif = {
      jsonrpc: "1.0",
      method: "notify",
    };
    expect(isRpcNotification(notif)).toBe(false);
  });

  it("returns false when method is missing", () => {
    const notif = {
      jsonrpc: "2.0",
    };
    expect(isRpcNotification(notif)).toBe(false);
  });

  it("returns false when method is not a string", () => {
    const notif = {
      jsonrpc: "2.0",
      method: 123,
    };
    expect(isRpcNotification(notif)).toBe(false);
  });

  it("returns falsy for null", () => {
    expect(isRpcNotification(null)).toBeFalsy();
  });

  it("returns falsy for undefined", () => {
    expect(isRpcNotification(undefined)).toBeFalsy();
  });
});
