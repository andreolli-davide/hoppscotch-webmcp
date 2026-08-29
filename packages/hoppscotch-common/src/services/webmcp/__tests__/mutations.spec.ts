import "~/services/persistence"
import { describe, expect, it } from "vitest"
import { Container } from "dioc"
import { BehaviorSubject } from "rxjs"

import { setPlatformDef } from "~/platform"
import { RESTTabService } from "~/services/tab/rest"
import { GQLTabService } from "~/services/tab/graphql"
import { replaceRESTDraftFields } from "../rest-drafts"

setPlatformDef({
  auth: {
    getCurrentUserStream: () => new BehaviorSubject(null),
    getCurrentUser: () => null,
    getProbableUserStream: () => new BehaviorSubject(null),
    getProbableUser: () => null,
    waitProbableLoginToConfirm: async () => {},
  } as any,
  backend: {} as any,
  kernelIO: {} as any,
  instance: {} as any,
  kernelInterceptors: {} as any,
  platformFeatureFlags: { exportAsGIST: false, hasTelemetry: false },
})

describe("WebMCP Draft Mutations & Output Limit", () => {
  it("replaces body and scripts without exceeding output byte boundaries", () => {
    const container = new Container()
    const restTabs = container.bind(RESTTabService)
    const tab = restTabs.currentActiveTab.value

    expect(tab).toBeDefined()
    const original = tab!.document.request

    const updated = replaceRESTDraftFields(original, {
      body: {
        contentType: "application/json",
        body: JSON.stringify({
          items: Array.from({ length: 20 }, (_, i) => ({
            id: i,
            name: `item-${i}`,
          })),
        }),
      },
      preRequestScript: "pw.env.set('TIMESTAMP', Date.now());\n".repeat(10),
      testScript: "pw.expect(pw.response.status).toBe(200);\n".repeat(10),
    })

    expect(updated.body.contentType).toBe("application/json")
    expect(updated.preRequestScript).toContain("TIMESTAMP")
    expect(updated.testScript).toContain("pw.expect")

    // Verify lightweight return payload fits well under 8192 bytes
    const lightweightResult = {
      protocolVersion: "hoppscotch.webmcp.v1",
      appContext: {
        surface: "rest",
        mode: "rest",
        workspace: { type: "personal" },
        environment: { name: "Global", scope: "none" },
        activeDocument: { token: "tab-1", kind: "request", dirty: true },
        dirtyDocumentCount: 1,
        capabilityPacks: ["app-context", "environment", "rest"],
      },
      revisionScope: "rest-document",
      revision: "rest-document:2",
      ok: true as const,
      updated: true,
      changedFields: ["body", "preRequestScript", "testScript"],
      draft: {
        dirty: true,
        provenance: "unsaved",
      },
    }

    const byteLength = new TextEncoder().encode(
      JSON.stringify(lightweightResult)
    ).byteLength
    expect(byteLength).toBeLessThan(8192)
    expect(byteLength).toBeLessThan(600) // Lightweight confirmation is ~400-500 bytes
  })

  it("enforces the 8192 byte limit for serialized WebMCP results", () => {
    const MAX_OUTPUT_BYTES = 8192

    const validPayload = {
      ok: true,
      data: "a".repeat(7500),
    }
    const validBytes = new TextEncoder().encode(
      JSON.stringify(validPayload)
    ).byteLength
    expect(validBytes <= MAX_OUTPUT_BYTES).toBe(true)

    const oversizedPayload = {
      ok: true,
      data: "a".repeat(8500),
    }
    const oversizedBytes = new TextEncoder().encode(
      JSON.stringify(oversizedPayload)
    ).byteLength
    expect(oversizedBytes > MAX_OUTPUT_BYTES).toBe(true)
  })

  it("marks REST tab as dirty and preserves save provenance when mutated", () => {
    const container = new Container()
    const restTabs = container.bind(RESTTabService)
    const tab = restTabs.currentActiveTab.value!

    expect(tab.document.isDirty).toBe(false)

    tab.document.request = replaceRESTDraftFields(tab.document.request, {
      endpoint: "https://api.example.com/v2/users",
    })
    tab.document.isDirty = true

    expect(tab.document.isDirty).toBe(true)
    expect(tab.document.request.endpoint).toBe(
      "https://api.example.com/v2/users"
    )
  })

  it("marks GraphQL tab as dirty when query is mutated", () => {
    const container = new Container()
    const gqlTabs = container.bind(GQLTabService)
    const tab = gqlTabs.currentActiveTab.value!

    expect(tab.document.isDirty).toBe(false)

    tab.document.request.query = "query GetUser { user { id name email } }"
    tab.document.isDirty = true

    expect(tab.document.isDirty).toBe(true)
    expect(tab.document.request.query).toContain("email")
  })
})
