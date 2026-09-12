import { TestContainer } from "dioc/testing"
import { expect, it } from "vitest"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { readRESTPayload, SecretRedactor } from "../projections"

it.each(["abcdefghijklmnop", "aé😀中z", "😀😀😀"])(
  "reads every response character exactly once: %s",
  async (body) => {
    const redactor = new SecretRedactor(
      new TestContainer().bind(SecretEnvironmentService)
    )
    const document = {
      response: {
        type: "success",
        body: new TextEncoder().encode(body).buffer,
        headers: [{ key: "content-type", value: "text/plain" }],
      },
    } as any
    let offset = 0
    let reconstructed = ""
    for (let page = 0; page < 20; page++) {
      const result = await readRESTPayload(
        document,
        "response",
        offset,
        2,
        undefined,
        redactor
      )
      reconstructed += result.text
      expect(result.nextOffset).toBeGreaterThan(offset)
      offset = result.nextOffset!
      if (!result.truncated) break
    }
    expect(reconstructed).toBe(body)
    expect(offset).toBe(new TextEncoder().encode(body).length)
  }
)
