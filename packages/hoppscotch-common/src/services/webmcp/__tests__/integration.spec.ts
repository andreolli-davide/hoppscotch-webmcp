import "~/services/persistence"
import { Container } from "dioc"
import { BehaviorSubject } from "rxjs"
import { createMemoryHistory, createRouter as makeRouter } from "vue-router"
import { nextTick } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setPlatformDef } from "~/platform"
import { restCollectionStore, setRESTCollections } from "~/newstore/collections"
import { type WebMCPToolDefinition } from "../adapter"
import { ActiveAppContextService } from "../context"
import { AgentActionApprovalService } from "../human-control"
import { WebMCPService } from "../service"

const originalModelContextDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "modelContext"
)
const originalSecureContextDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "isSecureContext"
)

const restoreProperty = (
  target: object,
  key: string,
  descriptor?: PropertyDescriptor
) => {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else delete (target as Record<string, unknown>)[key]
}

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

type BrowserTool = Omit<WebMCPToolDefinition, "execute"> & {
  execute: (
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => unknown | Promise<unknown>
}

type Registration = { tool: BrowserTool; signal?: AbortSignal }

type DeferredRegistration = {
  entered: Promise<void>
  release: () => void
}

class ModelContextFixture {
  public readonly calls: BrowserTool[] = []
  public readonly active = new Map<string, Registration>()
  private readonly deferred = new Map<
    string,
    { entered: () => void; released: Promise<void> }
  >()

  public defer(name: string): DeferredRegistration {
    let resolveEntered!: () => void
    let resolveRelease!: () => void
    const entered = new Promise<void>((resolve) => (resolveEntered = resolve))
    const released = new Promise<void>((resolve) => (resolveRelease = resolve))
    this.deferred.set(name, {
      entered: resolveEntered,
      released,
    })
    return {
      entered,
      release: () => {
        this.deferred.delete(name)
        resolveRelease()
      },
    }
  }

  public registerTool = async (
    tool: BrowserTool,
    options?: { signal?: AbortSignal }
  ) => {
    const registration: Registration = { tool, signal: options?.signal }
    this.calls.push(tool)
    const finish = () => {
      if (registration.signal?.aborted) return
      this.active.set(tool.name, registration)
      registration.signal?.addEventListener(
        "abort",
        () => {
          if (this.active.get(tool.name) === registration)
            this.active.delete(tool.name)
        },
        { once: true }
      )
    }
    const pending = this.deferred.get(tool.name)
    if (pending) {
      this.deferred.delete(tool.name)
      pending.entered()
      await pending.released.then(() => {
        finish()
      })
    } else finish()
  }

  public tool(name: string) {
    return this.active.get(name)?.tool
  }
}

const createRouter = async (path = "/") => {
  const router = createRouterImpl()
  await router.push(path)
  return router
}

const createRouterImpl = () =>
  makeRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: {} },
      { path: "/graphql", component: {} },
      { path: "/realtime", component: {} },
      { path: "/realtime/:mode", component: {} },
    ],
  })

const installFixture = (fixture: ModelContextFixture) => {
  vi.stubEnv("VITE_ENABLE_WEBMCP", "true")
  vi.stubEnv("VITE_ENABLE_WEBMCP_DURABLE_OPS", "true")
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  })
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: { registerTool: fixture.registerTool },
  })
}

const setup = async (path = "/", durable = true) => {
  vi.stubEnv("VITE_ENABLE_WEBMCP", "true")
  vi.stubEnv("VITE_ENABLE_WEBMCP_DURABLE_OPS", durable ? "true" : "false")
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  })
  const fixture = new ModelContextFixture()
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: { registerTool: fixture.registerTool },
  })
  const router = await createRouter(path)
  const container = new Container()
  const service = container.bind(WebMCPService)
  await service.start(router)
  return { container, fixture, router, service }
}

beforeEach(() => setRESTCollections([]))
afterEach(() => {
  vi.restoreAllMocks()
  restoreProperty(document, "modelContext", originalModelContextDescriptor)
  restoreProperty(window, "isSecureContext", originalSecureContextDescriptor)
  vi.unstubAllEnvs()
})

describe("WebMCP browser integration lifecycle", () => {
  it("invokes visible REST tools through the real adapter with omitted and empty options", async () => {
    const state = await setup()
    try {
      const read = state.fixture.tool("inspect_rest_exchange")!
      const edit = state.fixture.tool("edit_rest_request")!
      const context = state.container.bind(ActiveAppContextService)
      const expectedRevision = context.revision("rest-document")
      const first = await read.execute({})
      const second = await read.execute({}, {})
      expect(first).toMatchObject({ ok: true })
      expect(second).toMatchObject({ ok: true })
      const result = await edit.execute(
        { expectedRevision, patch: { name: "Through browser" } },
        {}
      )
      expect(result).toMatchObject({ ok: true, updated: true })
    } finally {
      state.service.stop()
    }
  })

  it("unregisters stale REST tools across REST, GraphQL, and realtime routes", async () => {
    const state = await setup()
    try {
      expect(state.fixture.tool("inspect_rest_exchange")).toBeDefined()
      await state.router.push("/graphql")
      await nextTick()
      expect(state.fixture.tool("inspect_rest_exchange")).toBeUndefined()
      expect(state.fixture.tool("inspect_graphql_operation")).toBeDefined()
      const stale = state.fixture.calls.find(
        (tool) => tool.name === "inspect_rest_exchange"
      )!
      await state.router.push("/realtime")
      await nextTick()
      expect(state.fixture.tool("inspect_graphql_operation")).toBeUndefined()
      expect(state.fixture.tool("inspect_realtime_session")).toBeDefined()
      await expect(stale.execute({})).rejects.toBeDefined()
    } finally {
      state.service.stop()
    }
  })

  it("keeps durable operations disabled and enabled across stop and restart", async () => {
    const state = await setup("/", false)
    try {
      expect(state.fixture.tool("create_collection")).toBeUndefined()
      state.service.stop()
      vi.stubEnv("VITE_ENABLE_WEBMCP_DURABLE_OPS", "true")
      await state.service.start(state.router)
      expect(state.fixture.tool("create_collection")).toBeDefined()
    } finally {
      state.service.stop()
    }
  })

  it("rejects a stale durable approval through the browser tool before mutation", async () => {
    const state = await setup()
    try {
      const context = state.container.bind(ActiveAppContextService)
      const approval = state.container.bind(AgentActionApprovalService)
      const pending = state.fixture.tool("create_collection")!.execute({
        expectedRevision: context.revision("app-context"),
        name: "Pending browser collection",
      })
      setRESTCollections([...restCollectionStore.value.state])
      approval.resolve("once")
      const result = await pending
      expect(result).toMatchObject({
        ok: false,
        error: { code: "STATE_CHANGED" },
      })
      expect(
        restCollectionStore.value.state.some(
          (item) => item.name === "Pending browser collection"
        )
      ).toBe(false)
    } finally {
      state.service.stop()
    }
  })

  it("does not install packs or watchers when stopped while app registration is deferred", async () => {
    const fixture = new ModelContextFixture()
    const appRegistration = fixture.defer("inspect_app_context")
    installFixture(fixture)
    const router = await createRouter()
    const container = new Container()
    const service = container.bind(WebMCPService)
    try {
      const starting = service.start(router)
      service.stop()
      appRegistration.release()
      await starting
      expect(fixture.active.size).toBe(0)
      expect(
        fixture.calls.some((tool) => tool.name === "inspect_rest_exchange")
      ).toBe(false)
    } finally {
      service.stop()
    }
  })

  it("does not duplicate live registrations when overlapping starts settle out of order", async () => {
    const fixture = new ModelContextFixture()
    const appRegistration = fixture.defer("inspect_app_context")
    installFixture(fixture)
    const router = await createRouter()
    const container = new Container()
    const service = container.bind(WebMCPService)
    try {
      const first = service.start(router)
      await appRegistration.entered
      const second = service.start(router)
      await second
      appRegistration.release()
      await first
      expect(fixture.active.size).toBeGreaterThan(0)
      expect(fixture.active.get("inspect_app_context")).toBeDefined()
      expect(
        fixture.calls.filter((tool) => tool.name === "inspect_rest_exchange")
      ).toHaveLength(1)
      expect(
        fixture.calls.filter((tool) => tool.name === "create_collection")
      ).toHaveLength(1)
    } finally {
      service.stop()
      const callsAfterStop = fixture.calls.length
      await router.push("/graphql")
      await nextTick()
      expect(fixture.calls).toHaveLength(callsAfterStop)
      expect(fixture.active.size).toBe(0)
    }
  })

  it("syncs a route change that happens while initial REST registration is pending", async () => {
    const fixture = new ModelContextFixture()
    const restRegistration = fixture.defer("inspect_rest_exchange")
    installFixture(fixture)
    const router = await createRouter()
    const container = new Container()
    const service = container.bind(WebMCPService)
    try {
      const starting = service.start(router)
      await restRegistration.entered
      await router.push("/graphql")
      restRegistration.release()
      await starting
      await nextTick()
      expect(fixture.tool("inspect_rest_exchange")).toBeUndefined()
      expect(fixture.tool("inspect_graphql_operation")).toBeDefined()
    } finally {
      service.stop()
      const callsAfterStop = fixture.calls.length
      await router.push("/")
      await nextTick()
      expect(fixture.calls).toHaveLength(callsAfterStop)
      expect(fixture.active.size).toBe(0)
    }
  })
})
