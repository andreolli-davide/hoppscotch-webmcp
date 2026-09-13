import "~/services/persistence"
import { Container } from "dioc"
import { BehaviorSubject } from "rxjs"
import { createMemoryHistory, createRouter } from "vue-router"
import { describe, expect, it, vi } from "vitest"

import { setPlatformDef } from "~/platform"
import { getDefaultRESTRequest } from "~/helpers/rest/default"
import { makeCollection } from "@hoppscotch/data"
import { setRESTCollections, restCollectionStore } from "~/newstore/collections"
import { GQLTabService } from "~/services/tab/graphql"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { TestRunnerService } from "~/services/test-runner/test-runner.service"
import { ActiveAppContextService } from "../context"
import { WebMCPAdapter } from "../adapter"
import { AgentActionApprovalService } from "../human-control"
import { WebMCPService } from "../service"

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

const setup = async (path = "/") => {
  vi.stubEnv("VITE_ENABLE_WEBMCP_DURABLE_OPS", "true")
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
  const approval = container.bind(AgentActionApprovalService)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: {} },
      { path: "/graphql", component: {} },
    ],
  })
  await router.push(path)
  await service.start(router)
  return { available, register, service, context, approval, tools, container }
}

describe("registered WebMCP lifecycle guards", () => {
  it("rejects create_collection when state changes during approval", async () => {
    const setupState = await setup()
    try {
      const { context, approval, tools } = setupState
      const pending = tools.get("create_collection").execute(
        {
          expectedRevision: context.revision("app-context"),
          name: "Pending",
        },
        { signal: new AbortController().signal }
      )
      setRESTCollections([...restCollectionStore.value.state])
      approval.resolve("once")
      const result = await pending
      expect(result.error.code).toBe("STATE_CHANGED")
      expect(
        restCollectionStore.value.state.some((item) => item.name === "Pending")
      ).toBe(false)
    } finally {
      setupState.service.stop()
      setupState.available.mockRestore()
      setupState.register.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it("runs a valid folder subtree through the test runner", async () => {
    const setupState = await setup()
    try {
      const request = getDefaultRESTRequest()
      request.endpoint = "https://example.test"
      const child = makeCollection({
        name: "Child",
        folders: [],
        requests: [request],
        auth: { authType: "inherit", authActive: false },
        headers: [],
        variables: [],
      })
      const root = makeCollection({
        name: "Root",
        folders: [child],
        requests: [],
        auth: { authType: "inherit", authActive: false },
        headers: [],
        variables: [],
      })
      setRESTCollections([root])
      const runner = setupState.container.bind(TestRunnerService)
      const runTests = vi.spyOn(runner, "runTests").mockResolvedValue(undefined)
      const { context, approval, tools } = setupState
      const pending = tools.get("run_collection").execute(
        {
          expectedRevision: context.revision("rest-document"),
          collectionPath: "0/0",
        },
        { signal: new AbortController().signal }
      )
      approval.resolve("once")
      const result = await pending
      expect(result.ok).toBe(true)
      expect(runTests).toHaveBeenCalledOnce()
      expect(runTests.mock.calls[0][1]).toBe(child)
    } finally {
      setupState.service.stop()
      setupState.available.mockRestore()
      setupState.register.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it("rejects GraphQL execution when a managed secret changes during approval", async () => {
    const setupState = await setup("/graphql")
    try {
      const { context, approval, tools, container } = setupState
      const tabs = container.bind(GQLTabService)
      const secrets = container.bind(SecretEnvironmentService)
      const executeConnected = vi
        .spyOn((setupState.service as any).gqlExecution, "executeConnected")
        .mockResolvedValue(undefined)
      tabs.currentActiveTab.value!.document.request.query = "query { viewer }"
      const pending = tools.get("execute_graphql_operation").execute(
        {
          expectedRevision: context.revision("graphql-document"),
        },
        { signal: new AbortController().signal }
      )
      secrets.addSecretEnvironment("managed", [
        { key: "TOKEN", value: "changed", varIndex: 0 },
      ])
      approval.resolve("once")
      const result = await pending
      expect(result.error.code).toBe("STATE_CHANGED")
      expect(executeConnected).not.toHaveBeenCalled()
    } finally {
      setupState.service.stop()
      setupState.available.mockRestore()
      setupState.register.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})
