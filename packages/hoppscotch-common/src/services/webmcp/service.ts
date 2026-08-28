import { HoppRESTRequest } from "@hoppscotch/data"
import { Service } from "dioc"
import { cloneDeep } from "lodash-es"
import { computed, Ref, watch } from "vue"
import { Router } from "vue-router"

import {
  RESTRequestExecutionService,
  RESTRequestAlreadyRunningError,
} from "~/services/rest-request-execution.service"
import { RESTTabService } from "~/services/tab/rest"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { HoppTab } from "~/services/tab"
import { HoppRequestDocument } from "~/helpers/rest/document"

import { WebMCPAdapter } from "./adapter"
import { ActiveAppContextService } from "./context"
import {
  AgentActionApprovalService,
  AgentActivityService,
} from "./human-control"
import {
  projectRESTExchange,
  readRESTPayload,
  SecretRedactor,
} from "./projections"
import {
  editRESTRequestInputSchema,
  editRESTRequestParser,
  emptyInputSchema,
  executeRESTRequestParser,
  expectedRevisionSchema,
  readRESTPayloadInputSchema,
  readRESTPayloadParser,
} from "./schemas"
import {
  RESTRequestPatch,
  WEBMCP_PROTOCOL_VERSION,
  WebMCPErrorCode,
  WebMCPRevisionScope,
  WebMCPToolFailure,
  WebMCPToolResult,
} from "./types"

const MAX_INPUT_BYTES = 128 * 1024
// Chrome recommends keeping each individual tool result near 1.5K characters.
// Payload details are available through the bounded read_rest_payload tool.
const MAX_OUTPUT_BYTES = 1536

const isPlainData = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return true
  if (Array.isArray(value)) return value.every(isPlainData)
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.values(value).every(isPlainData)
}

const safeTarget = (endpoint: string) => {
  if (endpoint.includes("<<")) return "templated endpoint"
  try {
    const trimmed = endpoint.trim()
    const domain = trimmed.split(/[/:#?]+/)[0]
    const normalized = /^https?:\/\//.test(trimmed)
      ? trimmed
      : domain === "localhost" || /([0-9]+\.)*[0-9]/.test(domain)
        ? `http://${trimmed}`
        : `https://${trimmed}`
    const url = new URL(normalized)
    return `${url.origin}${url.pathname}`.slice(0, 512)
  } catch {
    return "invalid endpoint"
  }
}

export class WebMCPService extends Service {
  public static readonly ID = "WEBMCP_SERVICE"

  private readonly enabled = import.meta.env.VITE_ENABLE_WEBMCP === "true"
  private readonly adapter = new WebMCPAdapter(this.enabled)
  private readonly context = this.bind(ActiveAppContextService)
  private readonly restTabs = this.bind(RESTTabService)
  private readonly interceptor = this.bind(KernelInterceptorService)
  private readonly secrets = this.bind(SecretEnvironmentService)
  private readonly execution = this.bind(RESTRequestExecutionService)
  private readonly approval = this.bind(AgentActionApprovalService)
  private readonly activity = this.bind(AgentActivityService)

  private appController: AbortController | null = null
  private restController: AbortController | null = null
  private stopCapabilityWatch: (() => void) | null = null

  public readonly diagnostic = computed(() => this.adapter.diagnostic.value)

  public async start(router: Router) {
    this.stop()
    this.context.attachRouter(router)
    if (!this.adapter.isAvailable()) {
      if (import.meta.env.DEV) {
        console.info(`[WebMCP] ${this.adapter.diagnostic.value}`)
      }
      return
    }

    this.appController = new AbortController()
    await this.registerAppPack(this.appController.signal)
    await this.syncRESTPack()
    this.stopCapabilityWatch = watch(
      () => [
        router.currentRoute.value.path,
        this.restTabs.currentTabID.value,
        this.restTabs.currentActiveTab.value.document.type,
      ],
      () => void this.syncRESTPack(),
      { flush: "post" }
    )
  }

  public stop() {
    this.stopCapabilityWatch?.()
    this.stopCapabilityWatch = null
    this.restController?.abort()
    this.restController = null
    this.appController?.abort()
    this.appController = null
    this.approval.clear()
  }

  private async syncRESTPack() {
    const available = this.context.isRESTAvailable()
    if (available && !this.restController) {
      this.restController = new AbortController()
      await this.registerRESTPack(this.restController.signal)
    } else if (!available && this.restController) {
      this.restController.abort()
      this.restController = null
    }
  }

  private base(scope: WebMCPRevisionScope) {
    const appContext = this.context.capture()
    const redactor = this.redactor()
    appContext.mode = redactor.scrub(appContext.mode, 32)
    appContext.environment.name = redactor.scrub(
      appContext.environment.name,
      64
    )
    if (appContext.workspace.name) {
      appContext.workspace.name = redactor.scrub(appContext.workspace.name, 64)
    }
    if (appContext.workspace.role) {
      appContext.workspace.role = redactor.scrub(appContext.workspace.role, 32)
    }
    return {
      protocolVersion: WEBMCP_PROTOCOL_VERSION,
      appContext,
      revisionScope: scope,
      revision: this.context.revision(scope),
    }
  }

  private failure(
    code: WebMCPErrorCode,
    message: string,
    scope: WebMCPRevisionScope = "app-context",
    retryable = false
  ): WebMCPToolFailure {
    return {
      ...this.base(scope),
      ok: false,
      error: {
        code,
        message: this.redactor().scrub(message, 512),
        retryable,
      },
    }
  }

  private result<T extends object>(
    scope: WebMCPRevisionScope,
    payload: T
  ): WebMCPToolResult<T> {
    const result = { ...this.base(scope), ok: true as const, ...payload }
    if (
      new TextEncoder().encode(JSON.stringify(result)).byteLength >
      MAX_OUTPUT_BYTES
    ) {
      return this.failure(
        "OUTPUT_LIMIT_EXCEEDED",
        "The safe projection exceeded the WebMCP output limit.",
        scope
      )
    }
    return result
  }

  private validBoundary(input: unknown) {
    if (!isPlainData(input)) return false
    try {
      return (
        new TextEncoder().encode(JSON.stringify(input)).byteLength <=
        MAX_INPUT_BYTES
      )
    } catch {
      return false
    }
  }

  private visibleREST() {
    const rest = this.context.captureVisibleREST()
    return (
      rest ??
      this.failure(
        "NO_ACTIVE_REST_REQUEST",
        "The normal REST request editor is no longer visible.",
        "app-context",
        true
      )
    )
  }

  private redactor() {
    return new SecretRedactor(this.secrets)
  }

  private async observation() {
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    return this.result("rest-document", {
      responseRevision: this.context.revision("rest-response"),
      exchange: await projectRESTExchange(
        rest.tab.document,
        this.redactor(),
        this.interceptor
      ),
    })
  }

  private async registerAppPack(signal: AbortSignal) {
    await this.adapter.register(
      {
        name: "inspect_app_context",
        title: "Inspect Hoppscotch context",
        description:
          "Inspect the visible Hoppscotch surface, workspace, selected environment, active live artifact, and capability packs. Results use bounded, redacted projections.",
        inputSchema: emptyInputSchema,
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input: Record<string, unknown>) => {
          if (!this.validBoundary(input) || Object.keys(input).length !== 0) {
            return this.failure(
              "INVALID_INPUT",
              "This tool accepts an empty object only."
            )
          }
          return this.result("app-context", {})
        },
      },
      signal
    )
  }

  private async registerRESTPack(signal: AbortSignal) {
    await Promise.all([
      this.adapter.register(
        {
          name: "inspect_rest_exchange",
          title: "Inspect current REST exchange",
          description:
            "Inspect the visible REST request and latest response as a bounded, redacted summary with draft state, environment dependencies, interceptor, diagnostics, and test outcomes.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (!this.validBoundary(input) || Object.keys(input).length !== 0) {
              return this.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            }
            return this.observation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "read_rest_payload",
          title: "Read REST payload window",
          description:
            "Read a bounded, revision-bound window from the visible REST request or response. Text is redacted and binary or file content is represented by metadata.",
          inputSchema: readRESTPayloadInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = readRESTPayloadParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const rest = this.visibleREST()
            if ("ok" in rest) return rest
            const scope =
              parsed.data.source === "request"
                ? "rest-document"
                : "rest-response"
            if (!this.context.matches(scope, parsed.data.expectedRevision)) {
              return this.failure(
                "STATE_CHANGED",
                "The payload changed; inspect it again.",
                scope,
                true
              )
            }
            try {
              const payload = await readRESTPayload(
                rest.tab.document,
                parsed.data.source,
                parsed.data.offset,
                parsed.data.maxChars,
                parsed.data.partIndex,
                this.redactor()
              )
              return this.result(scope, { payload })
            } catch (error) {
              return this.failure(
                "INVALID_INPUT",
                error instanceof Error
                  ? error.message
                  : "The payload cannot be read.",
                scope
              )
            }
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "edit_rest_request",
          title: "Edit current REST request",
          description:
            "Apply an allow-listed revision-bound patch to the visible REST draft. The updated draft is returned as unsaved state, while protected credential and script fields remain managed by the app.",
          inputSchema: editRESTRequestInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.editRESTRequest(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "execute_rest_request",
          title: "Execute current REST request",
          description:
            "Execute the visible REST request through Hoppscotch's normal pipeline after app approval and return a bounded, redacted response and test outcome.",
          inputSchema: expectedRevisionSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (
            input: Record<string, unknown>,
            { signal: executionSignal }: { signal: AbortSignal }
          ) => this.executeRESTRequest(input, executionSignal),
        },
        signal
      ),
    ])
  }

  private async editRESTRequest(input: Record<string, unknown>) {
    if (!this.validBoundary(input)) {
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    }
    const parsed = editRESTRequestParser.safeParse(input)
    if (!parsed.success) {
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    if (!this.context.matches("rest-document", parsed.data.expectedRevision)) {
      return this.failure(
        "STATE_CHANGED",
        "The REST draft changed; inspect it again.",
        "rest-document",
        true
      )
    }

    const originalRequest = cloneDeep(rest.tab.document.request)
    const originalDirty = rest.tab.document.isDirty
    const candidate = cloneDeep(rest.tab.document.request)
    const patch = parsed.data.patch as RESTRequestPatch
    if (patch.method !== undefined) candidate.method = patch.method
    if (patch.endpoint !== undefined) candidate.endpoint = patch.endpoint
    if (patch.params !== undefined) {
      candidate.params = cloneDeep(patch.params).map((param) => ({
        ...param,
        description: "",
      }))
    }
    if (patch.headers !== undefined) {
      candidate.headers = cloneDeep(patch.headers).map((header) => ({
        ...header,
        description: "",
      }))
    }
    if (patch.body !== undefined) candidate.body = cloneDeep(patch.body)

    const validated = HoppRESTRequest.safeParse(candidate)
    if (validated.type !== "ok") {
      return this.failure(
        "INVALID_INPUT",
        "The patch does not produce a valid REST request.",
        "rest-document"
      )
    }

    rest.tab.document.request = validated.value
    rest.tab.document.isDirty = true
    const changedFields = Object.keys(patch)
    const resultingRevision = this.context.revision("rest-document")
    const token = rest.token
    this.activity.record(
      {
        tool: "edit_rest_request",
        outcome: "changed",
        summary: `Changed REST ${changedFields.join(", ")}`.slice(0, 256),
        revision: resultingRevision,
      },
      () => {
        const current = this.context.captureVisibleREST()
        if (
          !current ||
          current.token !== token ||
          !this.context.matches("rest-document", resultingRevision)
        )
          return false
        current.tab.document.request = originalRequest
        current.tab.document.isDirty = originalDirty
        return true
      }
    )

    const observation = await this.observation()
    return observation.ok ? { ...observation, changedFields } : observation
  }

  private async executeRESTRequest(
    input: Record<string, unknown>,
    signal: AbortSignal
  ) {
    if (!this.validBoundary(input)) {
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    }
    const parsed = executeRESTRequestParser.safeParse(input)
    if (!parsed.success) {
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    if (!this.context.matches("rest-document", parsed.data.expectedRevision)) {
      return this.failure(
        "STATE_CHANGED",
        "The REST draft changed; inspect it again.",
        "rest-document",
        true
      )
    }

    const endpoint = rest.tab.document.request.endpoint
    const redactor = this.redactor()
    const target = redactor.scrub(safeTarget(endpoint), 512)
    const safeMethod = redactor.scrub(rest.tab.document.request.method, 32)
    const environment = this.context.capture().environment.name
    const workspace = this.context.capture().workspace.type
    const grantKey = [
      "execute",
      "rest",
      endpoint.includes("<<") ? parsed.data.expectedRevision : target,
      environment,
      workspace,
    ].join("|")
    const approved = await this.approval.request(
      {
        action: "Execute REST request",
        method: safeMethod,
        target,
        environment,
        workspace,
        grantKey,
      },
      signal
    )
    if (!approved) {
      const cancelled = signal.aborted
      this.activity.record({
        tool: "execute_rest_request",
        outcome: cancelled ? "cancelled" : "denied",
        summary: `${safeMethod} ${target}`.slice(0, 256),
        revision: this.context.revision("rest-document"),
      })
      return this.failure(
        cancelled ? "CANCELLED" : "APPROVAL_DENIED",
        cancelled
          ? "The execution was cancelled."
          : "The user denied execution.",
        "rest-document"
      )
    }

    const current = this.context.captureVisibleREST()
    if (
      !current ||
      current.token !== rest.token ||
      !this.context.matches("rest-document", parsed.data.expectedRevision)
    ) {
      return this.failure(
        "STATE_CHANGED",
        "The REST draft changed while approval was open.",
        "rest-document",
        true
      )
    }

    try {
      const tabRef = this.restTabs.getTabRef(rest.tab.id) as Ref<
        HoppTab<HoppRequestDocument>
      >
      const outcome = await this.execution.send(tabRef, {
        initiator: "webmcp",
        signal,
      })
      const activityBase = {
        tool: "execute_rest_request",
        summary: `${safeMethod} ${target}`.slice(0, 256),
        revision: this.context.revision("rest-document"),
      }
      if (outcome.type === "cancelled") {
        this.activity.record({ ...activityBase, outcome: "cancelled" })
        return this.failure(
          "CANCELLED",
          "The REST execution was cancelled.",
          "rest-document"
        )
      }
      if (outcome.type === "script_failed") {
        this.activity.record({ ...activityBase, outcome: "failed" })
        return this.failure(
          "SCRIPT_FAILED",
          "A request script failed.",
          "rest-document"
        )
      }
      if (outcome.type === "failed") {
        this.activity.record({ ...activityBase, outcome: "failed" })
        return this.failure(
          "EXECUTION_FAILED",
          outcome.error.message,
          "rest-document"
        )
      }
      this.activity.record({ ...activityBase, outcome: "executed" })
      const exchange = await projectRESTExchange(
        rest.tab.document,
        this.redactor(),
        this.interceptor
      )
      return this.result("rest-document", {
        responseRevision: this.context.revision("rest-response"),
        isStillCurrent: this.context.captureVisibleREST()?.token === rest.token,
        exchange,
      })
    } catch (error) {
      if (error instanceof RESTRequestAlreadyRunningError) {
        return this.failure(
          "REQUEST_ALREADY_RUNNING",
          error.message,
          "rest-document",
          true
        )
      }
      return this.failure(
        "EXECUTION_FAILED",
        error instanceof Error ? error.message : "REST execution failed.",
        "rest-document"
      )
    }
  }
}
