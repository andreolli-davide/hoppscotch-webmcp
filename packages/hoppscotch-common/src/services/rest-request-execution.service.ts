import * as E from "fp-ts/Either"
import { Service } from "dioc"
import { Subscription } from "rxjs"
import { computed, reactive, Ref, watch } from "vue"

import { runRESTRequest$ } from "~/helpers/RequestRunner"
import { HoppRequestDocument } from "~/helpers/rest/document"
import { HoppRESTResponse } from "~/helpers/types/HoppRESTResponse"
import { HoppTestResult } from "~/helpers/types/HoppTestResult"
import { platform } from "~/platform"
import { HoppTab } from "~/services/tab"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { WorkspaceService } from "~/services/workspace.service"

export type RESTExecutionInitiator = "user" | "webmcp"

export type RESTExecutionOutcome =
  | {
      type: "completed"
      response: HoppRESTResponse
      testResults: HoppTestResult
    }
  | { type: "cancelled" }
  | { type: "script_failed"; error: Error }
  | { type: "failed"; error: Error }

export class RESTRequestAlreadyRunningError extends Error {
  constructor() {
    super("A request is already running in this tab")
    this.name = "RESTRequestAlreadyRunningError"
  }
}

const emptyTestResult = (scriptError = false): HoppTestResult => ({
  description: "",
  expectResults: [],
  tests: [],
  envDiff: {
    global: { additions: [], deletions: [], updations: [] },
    selected: { additions: [], deletions: [], updations: [] },
  },
  scriptError,
  consoleEntries: [],
})

const normalizeEndpoint = (endpoint: string) => {
  const trimmed = endpoint.trim()
  if (/^http[s]?:\/\//.test(trimmed) || trimmed.startsWith("<<")) {
    return trimmed
  }

  const domain = trimmed.split(/[/:#?]+/)[0]
  return domain === "localhost" || /([0-9]+\.)*[0-9]/.test(domain)
    ? `http://${trimmed}`
    : `https://${trimmed}`
}

type RunningExecution = {
  cancel: () => void
  subscription: Subscription | null
}

/**
 * Owns the normal REST execution lifecycle for a tab. UI and semantic agent
 * actions both use this service so loading, cancellation and terminal state
 * cannot diverge between callers.
 */
export class RESTRequestExecutionService extends Service {
  public static readonly ID = "REST_REQUEST_EXECUTION_SERVICE"

  private readonly interceptorService = this.bind(KernelInterceptorService)
  private readonly workspaceService = this.bind(WorkspaceService)
  private readonly running = reactive(new Map<string, RunningExecution>())

  public isRunning(tabID: string) {
    return computed(() => this.running.has(tabID))
  }

  public cancel(tabID: string) {
    this.running.get(tabID)?.cancel()
  }

  public async send(
    tab: Ref<HoppTab<HoppRequestDocument>>,
    options: {
      signal?: AbortSignal
      initiator: RESTExecutionInitiator
    }
  ): Promise<RESTExecutionOutcome> {
    const tabID = tab.value.id
    if (this.running.has(tabID)) throw new RESTRequestAlreadyRunningError()

    const originalEndpoint = tab.value.document.request.endpoint
    if (originalEndpoint.trim() === "") {
      return {
        type: "failed",
        error: new Error("The request endpoint is empty"),
      }
    }

    const endpoint = normalizeEndpoint(originalEndpoint)
    if (endpoint !== originalEndpoint) {
      tab.value.document.request.endpoint = endpoint
      tab.value.document.isDirty = true
    }

    tab.value.document.response = {
      type: "loading",
      req: tab.value.document.request,
    }
    tab.value.document.testResults = null

    platform.analytics?.logEvent({
      type: "HOPP_REQUEST_RUN",
      platform: "rest",
      strategy: this.interceptorService.current.value!.id,
      workspaceType: this.workspaceService.currentWorkspace.value.type,
    })

    const [runnerCancel, streamPromise, runnerCompletion] = runRESTRequest$(tab)
    let settled = false
    let runnerComplete = false
    let terminalResponse: HoppRESTResponse | null = null
    let stopTestWatch: (() => void) | null = null
    let resolveOutcome!: (outcome: RESTExecutionOutcome) => void
    const outcome = new Promise<RESTExecutionOutcome>((resolve) => {
      resolveOutcome = resolve
    })

    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort)
      stopTestWatch?.()
      const execution = this.running.get(tabID)
      execution?.subscription?.unsubscribe()
      tab.value.document.cancelFunction = undefined
      this.running.delete(tabID)
    }

    const settle = (result: RESTExecutionOutcome) => {
      if (settled) return
      settled = true
      cleanup()
      resolveOutcome(result)
    }

    const settleCompleted = () => {
      const tests = tab.value.document.testResults
      if (!runnerComplete || !terminalResponse || !tests) return
      settle({
        type: "completed",
        response: terminalResponse,
        testResults: tests,
      })
    }

    void runnerCompletion.then(() => {
      runnerComplete = true
      settleCompleted()
    })

    const cancel = () => {
      runnerCancel()
      if (tab.value.document.response?.type === "loading") {
        tab.value.document.response = null
      }
      if (tab.value.document.testResults === null) {
        tab.value.document.testResults = emptyTestResult()
      }
      settle({ type: "cancelled" })
    }
    const abort = () => cancel()

    tab.value.document.cancelFunction = cancel
    this.running.set(tabID, { cancel, subscription: null })
    options.signal?.addEventListener("abort", abort, { once: true })

    if (options.signal?.aborted) {
      cancel()
      return outcome
    }

    let streamResult: Awaited<typeof streamPromise>
    try {
      streamResult = await streamPromise
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error("REST request setup failed unexpectedly")
      tab.value.document.response = { type: "script_fail", error }
      tab.value.document.testResults = emptyTestResult(true)
      settle({ type: "failed", error })
      return outcome
    }
    if (settled) return outcome

    if (E.isLeft(streamResult)) {
      if (streamResult.left === "cancellation") {
        cancel()
      } else {
        const error = new Error("The pre-request script failed")
        error.name = "RequestFailure"
        tab.value.document.response = { type: "script_fail", error }
        tab.value.document.testResults = emptyTestResult(true)
        settle({ type: "script_failed", error })
      }
      return outcome
    }

    stopTestWatch = watch(
      () => tab.value.document.testResults,
      () => settleCompleted(),
      { flush: "sync" }
    )

    const subscription = streamResult.right.subscribe({
      next: (response) => {
        if (settled) return
        tab.value.document.response = response

        if (
          response.type === "network_fail" ||
          response.type === "extension_error" ||
          response.type === "interceptor_error"
        ) {
          terminalResponse = response
          tab.value.document.testResults = emptyTestResult()
          settleCompleted()
          return
        }

        if (response.type === "success" || response.type === "failure") {
          terminalResponse = response
          settleCompleted()
        }
      },
      error: (cause: unknown) => {
        const error =
          cause instanceof Error
            ? cause
            : new Error("REST response stream failed")
        if (tab.value.document.testResults === null) {
          tab.value.document.testResults = emptyTestResult()
        }
        settle({ type: "failed", error })
      },
      complete: () => {
        if (!terminalResponse && !settled) cancel()
      },
    })

    const running = this.running.get(tabID)
    if (running) running.subscription = subscription

    return outcome
  }
}
