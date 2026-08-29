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
})
