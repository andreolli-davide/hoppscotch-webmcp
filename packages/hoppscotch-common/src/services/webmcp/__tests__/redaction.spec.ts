import { TestContainer } from "dioc/testing"
import { describe, expect, it } from "vitest"

import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { SecretRedactor } from "../projections"

describe("WebMCP secret redaction", () => {
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
