import { describe, expect, it } from "bun:test";
import { validateSchemaValue, type JsonSchemaNode } from "./schema_validation.js";

describe("schema_validation", () => {
  it("validates const values", () => {
    const schema: JsonSchemaNode = { const: "stop" };
    expect(validateSchemaValue("stop", schema)).toBeUndefined();
    expect(validateSchemaValue("continue", schema)).toContain("expected const");
  });

  it("validates discriminated oneOf objects", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      required: ["decision", "payload"],
      properties: {
        decision: { type: "string", enum: ["stop", "append"] },
        payload: { type: "object" },
      },
      additionalProperties: false,
      oneOf: [
        {
          type: "object",
          required: ["decision", "payload"],
          properties: {
            decision: { const: "stop" },
            payload: {
              type: "object",
              required: ["reason"],
              properties: { reason: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
        {
          type: "object",
          required: ["decision", "payload"],
          properties: {
            decision: { const: "append" },
            payload: {
              type: "object",
              required: ["message"],
              properties: { message: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      ],
    };

    expect(validateSchemaValue({ decision: "stop", payload: { reason: "done" } }, schema)).toBeUndefined();
    expect(validateSchemaValue({ decision: "append", payload: { message: "go" } }, schema)).toBeUndefined();
    expect(validateSchemaValue({ decision: "append", payload: { reason: "bad" } }, schema)).toContain("oneOf");
  });

  it("supports anyOf and allOf", () => {
    const anySchema: JsonSchemaNode = {
      anyOf: [{ type: "string" }, { type: "number" }],
    };
    expect(validateSchemaValue("x", anySchema)).toBeUndefined();
    expect(validateSchemaValue(1, anySchema)).toBeUndefined();
    expect(validateSchemaValue(true, anySchema)).toContain("anyOf");

    const allSchema: JsonSchemaNode = {
      allOf: [
        { type: "object", required: ["a"], properties: { a: { type: "string" } } },
        { type: "object", required: ["b"], properties: { b: { type: "number" } } },
      ],
    };
    expect(validateSchemaValue({ a: "x", b: 1 }, allSchema)).toBeUndefined();
    expect(validateSchemaValue({ a: "x" }, allSchema)).toContain("$.b: required");
  });
});
