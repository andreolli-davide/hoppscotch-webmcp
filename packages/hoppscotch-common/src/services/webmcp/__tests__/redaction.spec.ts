import { TestContainer } from "dioc/testing"
import { describe, expect, it } from "vitest"

import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { readRESTPayload, SecretRedactor } from "../projections"

describe("WebMCP secret redaction", () => {
  it("merges overlapping secret spans for scrub and mask", () => {
    const service = new TestContainer().bind(SecretEnvironmentService)
    service.addSecretEnvironment("env", [
      { key: "A", value: "abcd", initialValue: "", varIndex: 0 },
      { key: "B", value: "cdef", initialValue: "", varIndex: 1 },
    ])
    const redactor = new SecretRedactor(service)
    expect(redactor.scrub("abcdef")).toBe("[REDACTED]")
    expect(redactor.mask("abcdef")).toBe("******")
  })

  it("scrubs managed current and initial secret values", () => {
    const service = new TestContainer().bind(SecretEnvironmentService)
    service.addSecretEnvironment("env", [
      {
        key: "TOKEN",
        value: "current-secret",
        initialValue: "initial-secret",
        varIndex: 0,
      },
    ])

    const redactor = new SecretRedactor(service)
    expect(
      redactor.scrub(
        "Authorization: current-secret; fallback=initial-secret; safe=value"
      )
    ).toBe("Authorization: [REDACTED]; fallback=[REDACTED]; safe=value")
  })

  it("applies the output bound after redaction", () => {
    const service = new TestContainer().bind(SecretEnvironmentService)
    const redactor = new SecretRedactor(service)
    expect(redactor.scrub("abcdefgh", 4)).toBe("abcd")
  })
})

it("masks secret spans before request and response window selection", async () => {
  const service = new TestContainer().bind(SecretEnvironmentService)
  service.addSecretEnvironment("env", [
    { key: "TOKEN", value: "current-secret", initialValue: "", varIndex: 0 },
  ])
  const redactor = new SecretRedactor(service)
  const document = {
    request: { body: { contentType: "text/plain", body: "current-secret" } },
    response: {
      type: "success",
      body: new TextEncoder().encode("current-secret").buffer,
      headers: [{ key: "content-type", value: "text/plain" }],
    },
  } as any
  for (const source of ["request", "response"] as const) {
    for (let offset = 0; offset < 14; offset++) {
      const result = await readRESTPayload(
        document,
        source,
        offset,
        1,
        undefined,
        redactor
      )
      expect(result.text).toBe("*")
    }
  }
})
