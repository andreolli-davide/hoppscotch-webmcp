import "~/services/persistence"
import { describe, expect, it } from "vitest"
import { ref } from "vue"
import { BehaviorSubject } from "rxjs"
import * as E from "fp-ts/Either"

import { setPlatformDef } from "~/platform"
import { getService } from "~/modules/dioc"
import { TestRunnerService } from "~/services/test-runner/test-runner.service"
import {
  KernelInterceptorService,
  KernelInterceptor,
} from "~/services/kernel-interceptor.service"
import { HoppTestRunnerDocument } from "~/helpers/rest/document"
import { HoppTab } from "~/services/tab"
import { getDefaultRESTRequest } from "~/helpers/rest/default"
import { makeCollection } from "@hoppscotch/data"
import { RelayResponse } from "@hoppscotch/kernel"

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

const createMockInterceptor = (): KernelInterceptor => ({
  id: "mock-interceptor",
  name: () => "Mock Interceptor",
  selectable: { type: "selectable" },
  capabilities: {},
  execute: () => ({
    cancel: async () => {},
    response: Promise.resolve(
      E.right({
        status: 200,
        headers: {},
        body: {
          mediaType: "application/json",
          body: new Uint8Array(Buffer.from(JSON.stringify({ success: true }))),
        },
        meta: {
          timing: {
            start: 100,
            end: 200,
          },
        },
      } as RelayResponse)
    ),
  }),
})

describe("WebMCP Collection Runner Service", () => {
  it("initializes runner document and updates status and metrics during run", async () => {
    const interceptorService = getService(KernelInterceptorService)
    interceptorService.register(createMockInterceptor())
    interceptorService.setActive("mock-interceptor")

    const runnerService = getService(TestRunnerService)

    const req1 = getDefaultRESTRequest()
    req1.name = "Request 1"
    req1.endpoint = "https://echo.hoppscotch.io/get"

    const collection = makeCollection({
      name: "Runner Test Collection",
      folders: [],
      requests: [req1],
      auth: { authType: "inherit", authActive: false },
      headers: [],
      variables: [],
    })

    const runnerDoc: HoppTestRunnerDocument = {
      type: "test-runner",
      collectionType: "my-collections",
      collectionID: "test-col-id",
      collection,
      isDirty: false,
      config: {
        iterations: 1,
        delay: 0,
        stopOnError: false,
        persistResponses: false,
        keepVariableValues: true,
      },
      status: "idle",
      request: null,
      testRunnerMeta: {
        completedRequests: 0,
        totalRequests: 1,
        totalTime: 0,
        failedTests: 0,
        passedTests: 0,
        totalTests: 0,
      },
    }

    const runnerTabRef = ref<HoppTab<HoppTestRunnerDocument>>({
      id: "test-runner-tab",
      document: runnerDoc,
    })

    const stopRef = ref(false)

    await runnerService.runTests(runnerTabRef, collection, {
      ...runnerDoc.config,
      stopRef,
    })

    expect(runnerTabRef.value.document.status).toBe("stopped")
    expect(runnerTabRef.value.document.testRunnerMeta.completedRequests).toBe(1)
    expect(runnerTabRef.value.document.resultCollection).toBeDefined()
    expect(runnerTabRef.value.document.resultCollection?.name).toBe(
      "Runner Test Collection"
    )
  })

  it("handles early cancellation via stopRef", async () => {
    const interceptorService = getService(KernelInterceptorService)
    interceptorService.register(createMockInterceptor())
    interceptorService.setActive("mock-interceptor")

    const runnerService = getService(TestRunnerService)

    const req1 = getDefaultRESTRequest()
    req1.name = "First Request"
    req1.endpoint = "https://echo.hoppscotch.io/get"

    const req2 = getDefaultRESTRequest()
    req2.name = "Second Request"
    req2.endpoint = "https://echo.hoppscotch.io/get"

    const collection = makeCollection({
      name: "Cancellable Collection",
      folders: [],
      requests: [req1, req2],
      auth: { authType: "inherit", authActive: false },
      headers: [],
      variables: [],
    })

    const runnerDoc: HoppTestRunnerDocument = {
      type: "test-runner",
      collectionType: "my-collections",
      collectionID: "cancel-col-id",
      collection,
      isDirty: false,
      config: {
        iterations: 1,
        delay: 100,
        stopOnError: false,
        persistResponses: false,
        keepVariableValues: true,
      },
      status: "idle",
      request: null,
      testRunnerMeta: {
        completedRequests: 0,
        totalRequests: 2,
        totalTime: 0,
        failedTests: 0,
        passedTests: 0,
        totalTests: 0,
      },
    }

    const runnerTabRef = ref<HoppTab<HoppTestRunnerDocument>>({
      id: "cancel-tab",
      document: runnerDoc,
    })

    const stopRef = ref(true) // Already stopped

    await runnerService.runTests(runnerTabRef, collection, {
      ...runnerDoc.config,
      stopRef,
    })

    expect(runnerTabRef.value.document.status).toBe("stopped")
    expect(runnerTabRef.value.document.testRunnerMeta.completedRequests).toBe(0)
  })
})
