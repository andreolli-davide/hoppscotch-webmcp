import { describe, expect, it } from "vitest"

import { applyJSONPointerOperations } from "../diagnostics"

describe("WebMCP structured diagnostics helpers", () => {
  it("applies bounded JSON Pointer edits without mutating the source", () => {
    const source = { users: [{ name: "Ada" }] }
    const result = applyJSONPointerOperations(source, [
      { op: "add", path: "/users/1", value: { name: "Lin" } },
      { op: "replace", path: "/users/0/name", value: "Grace" },
    ])

    expect(result).toEqual({
      users: [{ name: "Grace" }, { name: "Lin" }],
    })
    expect(source).toEqual({ users: [{ name: "Ada" }] })
  })

  it("refuses prototype-polluting JSON Pointer paths", () => {
    expect(() =>
      applyJSONPointerOperations({}, [
        { op: "add", path: "/__proto__/polluted", value: true },
      ])
    ).toThrow("Unsafe JSON Pointer path")
  })

  it("refuses root replacement and invalid array index format", () => {
    expect(() =>
      applyJSONPointerOperations({ a: 1 }, [
        { op: "replace", path: "/", value: { b: 2 } },
      ])
    ).toThrow("Replacing the document requires replace_document")

    expect(() =>
      applyJSONPointerOperations({ arr: [1, 2] }, [
        { op: "replace", path: "/arr/01", value: 3 },
      ])
    ).toThrow("Invalid JSON Pointer array index")
  })
})
