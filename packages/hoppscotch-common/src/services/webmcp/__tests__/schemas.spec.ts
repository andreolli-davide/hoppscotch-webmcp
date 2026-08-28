import { describe, expect, it } from "vitest"

import {
  editRESTRequestParser,
  readRESTPayloadParser,
  requestPatchSchema,
} from "../schemas"

describe("WebMCP REST input schemas", () => {
  it("accepts the allow-listed draft fields", () => {
    expect(
      editRESTRequestParser.safeParse({
        expectedRevision: "rest-document:4",
        patch: {
          method: "POST",
          endpoint: "https://example.test/orders",
          headers: [
            { key: "Content-Type", value: "application/json", active: true },
          ],
          body: { contentType: "application/json", body: '{"quantity":1}' },
        },
      }).success
    ).toBe(true)
  })

  it("rejects empty patches, extra properties and oversized values", () => {
    expect(requestPatchSchema.safeParse({}).success).toBe(false)
    expect(
      requestPatchSchema.safeParse({ auth: { authType: "none" } }).success
    ).toBe(false)
    expect(
      requestPatchSchema.safeParse({ endpoint: "x".repeat(8193) }).success
    ).toBe(false)
    expect(
      requestPatchSchema.safeParse({
        headers: [{ key: "x", value: "y", active: true, secret: true }],
      }).success
    ).toBe(false)
  })

  it("bounds payload windows and revisions", () => {
    expect(
      readRESTPayloadParser.safeParse({
        source: "response",
        expectedRevision: "rest-response:2",
        maxChars: 4096,
      }).success
    ).toBe(true)
    expect(
      readRESTPayloadParser.safeParse({
        source: "response",
        expectedRevision: "rest-response:2",
        maxChars: 4097,
      }).success
    ).toBe(false)
    expect(
      readRESTPayloadParser.safeParse({
        source: "response",
        expectedRevision: "",
      }).success
    ).toBe(false)
  })
})
