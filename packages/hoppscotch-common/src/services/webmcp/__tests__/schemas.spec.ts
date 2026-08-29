import { describe, expect, it } from "vitest"

import {
  configureRESTAuthParser,
  editRESTScriptsParser,
  editRESTVariablesParser,
  editRESTRequestParser,
  listEnvironmentsParser,
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
        maxChars: 768,
      }).success
    ).toBe(true)
    expect(
      readRESTPayloadParser.safeParse({
        source: "response",
        expectedRevision: "rest-response:2",
        maxChars: 769,
      }).success
    ).toBe(false)
    expect(
      readRESTPayloadParser.safeParse({
        source: "response",
        expectedRevision: "",
      }).success
    ).toBe(false)
  })

  it("accepts environment references but rejects raw-looking auth templates", () => {
    expect(
      configureRESTAuthParser.safeParse({
        expectedRevision: "rest-document:4",
        authType: "bearer",
        active: true,
        references: { token: "API_TOKEN" },
      }).success
    ).toBe(true)
    expect(
      configureRESTAuthParser.safeParse({
        expectedRevision: "rest-document:4",
        authType: "bearer",
        active: true,
        references: { token: "<<API_TOKEN>>" },
      }).success
    ).toBe(false)
    expect(
      configureRESTAuthParser.safeParse({
        expectedRevision: "rest-document:4",
        authType: "bearer",
        active: true,
        token: "literal-secret",
      }).success
    ).toBe(false)
  })

  it("bounds request variables and scripts", () => {
    expect(
      editRESTVariablesParser.safeParse({
        expectedRevision: "rest-document:4",
        variables: [{ key: "ORDER_ID", value: "42", active: true }],
      }).success
    ).toBe(true)
    expect(
      editRESTVariablesParser.safeParse({
        expectedRevision: "rest-document:4",
        variables: [{ key: "", value: "42", active: true }],
      }).success
    ).toBe(false)
    expect(
      editRESTScriptsParser.safeParse({
        expectedRevision: "rest-document:4",
        target: "post_request",
        script: "x".repeat(32769),
      }).success
    ).toBe(false)
  })

  it("paginates environment choices with bounded offsets", () => {
    expect(listEnvironmentsParser.safeParse({}).data?.offset).toBe(0)
    expect(listEnvironmentsParser.safeParse({ offset: 4 }).success).toBe(true)
    expect(listEnvironmentsParser.safeParse({ offset: -1 }).success).toBe(false)
  })
})
