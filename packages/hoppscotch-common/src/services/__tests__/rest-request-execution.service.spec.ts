import { getDefaultRESTRequest } from "@hoppscotch/data"
import { TestContainer } from "dioc/testing"
import * as E from "fp-ts/Either"
import { Subject } from "rxjs"
import { ref } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { setPlatformDef } from "~/platform"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { WorkspaceService } from "~/services/workspace.service"
import {
  RESTRequestAlreadyRunningError,
  RESTRequestExecutionService,
} from "../rest-request-execution.service"
import { HoppRESTResponse } from "~/helpers/types/HoppRESTResponse"

const runRESTRequestMock = vi.hoisted(() => vi.fn())

vi.mock("~/services/kernel-interceptor.service", () => ({
  KernelInterceptorService: class MockKernelInterceptorService {
    static readonly ID = "KERNEL_INTERCEPTOR_SERVICE"
  },
}))

vi.mock("~/services/workspace.service", () => ({
  WorkspaceService: class MockWorkspaceService {
    static readonly ID = "WORKSPACE_SERVICE"
  },
}))

vi.mock("~/helpers/RequestRunner", () => ({
  runRESTRequest$: runRESTRequestMock,
}))

const testResults = {
  description: "",
  expectResults: [],
  tests: [],
  envDiff: {
    global: { additions: [], deletions: [], updations: [] },
    selected: { additions: [], deletions: [], updations: [] },
  },
  scriptError: false,
  consoleEntries: [],
}

const makeTab = () =>
  ref({
    id: "tab-1",
    document: {
      type: "request" as const,
      request: { ...getDefaultRESTRequest(), endpoint: "example.test/orders" },
      isDirty: false,
      response: null,
      testResults: null,
    },
  })

const bindService = () => {
  const container = new TestContainer()
  container.bindMock(KernelInterceptorService, {
    current: ref({ id: "browser" }),
  })
  container.bindMock(WorkspaceService, {
    currentWorkspace: ref({ type: "personal" }),
  })
  return container.bind(RESTRequestExecutionService)
}

describe("RESTRequestExecutionService", () => {
  beforeEach(() => {
    runRESTRequestMock.mockReset()
    setPlatformDef({
      analytics: { logEvent: vi.fn() },
    } as never)
  })

  it("normalizes, marks dirty, and resolves after tests complete", async () => {
    const responses = new Subject<HoppRESTResponse>()
    let finishRunner!: () => void
    const runnerCompletion = new Promise<void>((resolve) => {
      finishRunner = resolve
    })
    runRESTRequestMock.mockReturnValue([
      vi.fn(),
      Promise.resolve(E.right(responses)),
      runnerCompletion,
    ])
    const tab = makeTab()
    const service = bindService()

    const execution = service.send(tab, { initiator: "user" })
    await Promise.resolve()
    expect(tab.value.document.request.endpoint).toBe(
      "https://example.test/orders"
    )
    expect(tab.value.document.isDirty).toBe(true)
    expect(service.isRunning(tab.value.id).value).toBe(true)

    const response: HoppRESTResponse = {
      type: "success",
      headers: [],
      body: new ArrayBuffer(0),
      statusCode: 200,
      statusText: "OK",
      meta: { responseDuration: 12, responseSize: 0 },
      req: tab.value.document.request,
    }
    responses.next(response)
    tab.value.document.testResults = testResults
    let completed = false
    void execution.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    finishRunner()

    await expect(execution).resolves.toMatchObject({
      type: "completed",
      response,
    })
    expect(service.isRunning(tab.value.id).value).toBe(false)
  })

  it("installs cancellation before pre-request setup completes", async () => {
    let finishSetup!: (value: E.Either<"cancellation", never>) => void
    const setup = new Promise<E.Either<"cancellation", never>>((resolve) => {
      finishSetup = resolve
    })
    const runnerCancel = vi.fn()
    runRESTRequestMock.mockReturnValue([runnerCancel, setup, Promise.resolve()])
    const tab = makeTab()
    const service = bindService()

    const execution = service.send(tab, { initiator: "webmcp" })
    expect(tab.value.document.cancelFunction).toBeTypeOf("function")
    service.cancel(tab.value.id)
    expect(runnerCancel).toHaveBeenCalledOnce()
    finishSetup(E.left("cancellation"))
    await expect(execution).resolves.toEqual({ type: "cancelled" })
  })

  it("rejects concurrent execution in the same tab", async () => {
    let finishSetup!: (value: E.Either<"cancellation", never>) => void
    const setup = new Promise<E.Either<"cancellation", never>>((resolve) => {
      finishSetup = resolve
    })
    runRESTRequestMock.mockReturnValue([vi.fn(), setup, Promise.resolve()])
    const tab = makeTab()
    const service = bindService()
    const first = service.send(tab, { initiator: "user" })

    await expect(
      service.send(tab, { initiator: "webmcp" })
    ).rejects.toBeInstanceOf(RESTRequestAlreadyRunningError)
    service.cancel(tab.value.id)
    finishSetup(E.left("cancellation"))
    await first
  })
})
