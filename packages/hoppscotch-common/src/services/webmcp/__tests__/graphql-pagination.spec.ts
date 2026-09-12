import "~/services/persistence"
import { expect, it, vi } from "vitest"
import { Container } from "dioc"
import { BehaviorSubject } from "rxjs"

import { setPlatformDef } from "~/platform"
import { GQLTabService } from "~/services/tab/graphql"

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

import { createRouter, createMemoryHistory } from "vue-router"
import { ActiveAppContextService } from "../context"
import { WebMCPService } from "../service"
import { WebMCPAdapter } from "../adapter"

import { SecretEnvironmentService } from "~/services/secret-environment.service"

it("reports full redacted GraphQL length and accurate completion across windows", async () => {
  const available = vi
    .spyOn(WebMCPAdapter.prototype, "isAvailable")
    .mockReturnValue(true)
  const tools = new Map<string, any>()
  const register = vi
    .spyOn(WebMCPAdapter.prototype, "register")
    .mockImplementation(async (tool) => {
      tools.set(tool.name, tool)
      return true
    })
  const container = new Container()
  const service = container.bind(WebMCPService)
  const context = container.bind(ActiveAppContextService)
  const tabs = container.bind(GQLTabService)
  const secrets = container.bind(SecretEnvironmentService)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/graphql", component: {} }],
  })
  await router.push("/graphql")
  try {
    await service.start(router)
    secrets.addSecretEnvironment("test", [
      { key: "TOKEN", value: "xyz", varIndex: 0 },
    ])
    tabs.currentActiveTab.value!.document.request.query = "prefix xyz suffix"
    const expected = "prefix [REDACTED] suffix"
    const execute = (offset: number) =>
      tools.get("read_graphql_payload").execute({
        source: "query",
        expectedRevision: context.revision("graphql-document"),
        offset,
        maxChars: 8,
      })
    let reconstructed = ""
    for (let offset = 0; offset < expected.length; offset += 8) {
      const result = await execute(offset)
      expect(result.ok).toBe(true)
      expect(result.payload.totalChars).toBe(expected.length)
      expect(result.payload.truncated).toBe(offset + 8 < expected.length)
      reconstructed += result.payload.text
    }
    expect(reconstructed).toBe(expected)
    const end = await execute(expected.length)
    expect(end.payload.text).toBe("")
    expect(end.payload.truncated).toBe(false)
    expect(end.payload.totalChars).toBe(expected.length)
  } finally {
    service.stop()
    available.mockRestore()
    register.mockRestore()
  }
})
