import { Service } from "dioc"
import { computed } from "vue"

import { RESTRequestExecutionService } from "~/services/rest-request-execution.service"
import { RESTTabService } from "~/services/tab/rest"
import { GQLTabService } from "~/services/tab/graphql"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { WorkspaceService } from "~/services/workspace.service"
import { TestRunnerService } from "~/services/test-runner/test-runner.service"
import { GQLRequestExecutionService } from "~/services/graphql-execution.service"
import {
  RealtimeSessionService,
  RealtimeMode,
} from "~/services/realtime-session.service"
import { CurrentValueService } from "~/services/current-environment-value.service"

import { WebMCPAdapter } from "./adapter"
import { ActiveAppContextService } from "./context"
import { WebMCPEnvironmentService } from "./environment"
import {
  AgentActionApprovalService,
  AgentActivityService,
} from "./human-control"
import { SecretRedactor } from "./redaction"
import { diagnosticForFailure } from "./diagnostics"
import {
  WEBMCP_PROTOCOL_VERSION,
  WebMCPErrorCode,
  WebMCPRevisionScope,
  WebMCPToolFailure,
  WebMCPToolResult,
} from "./types"

const MAX_INPUT_BYTES = 128 * 1024
const MAX_OUTPUT_BYTES = 8192

const isPlainData = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return true
  const seen = new WeakSet<object>()
  const pending: object[] = [value]
  let visited = 0
  while (pending.length) {
    const current = pending.pop()!
    if (++visited > 10_000 || seen.has(current)) return false
    seen.add(current)
    if (
      !Array.isArray(current) &&
      Object.getPrototypeOf(current) !== Object.prototype
    )
      return false
    for (const child of Object.values(current))
      if (child !== null && typeof child === "object") pending.push(child)
  }
  return true
}

export class WebMCPRuntime extends Service {
  public static readonly ID = "WEBMCP_RUNTIME"
  public readonly enabled = import.meta.env.VITE_ENABLE_WEBMCP === "true"
  public readonly adapter = new WebMCPAdapter(this.enabled)
  public readonly context = this.bind(ActiveAppContextService)
  public readonly restTabs = this.bind(RESTTabService)
  public readonly gqlTabs = this.bind(GQLTabService)
  public readonly workspace = this.bind(WorkspaceService)
  public readonly interceptor = this.bind(KernelInterceptorService)
  public readonly secrets = this.bind(SecretEnvironmentService)
  public readonly execution = this.bind(RESTRequestExecutionService)
  public readonly testRunner = this.bind(TestRunnerService)
  public readonly gqlExecution = this.bind(GQLRequestExecutionService)
  public readonly realtime = this.bind(RealtimeSessionService)
  public readonly environments = this.bind(WebMCPEnvironmentService)
  public readonly currentValues = this.bind(CurrentValueService)
  public readonly approval = this.bind(AgentActionApprovalService)
  public readonly activity = this.bind(AgentActivityService)
  public readonly diagnostic = computed(() => this.adapter.diagnostic.value)

  public base(scope: WebMCPRevisionScope) {
    const appContext = this.context.capture()
    const redactor = this.redactor()
    appContext.mode = redactor.scrub(appContext.mode, 32)
    appContext.environment.name = redactor.scrub(
      appContext.environment.name,
      64
    )
    if (appContext.workspace.name)
      appContext.workspace.name = redactor.scrub(appContext.workspace.name, 64)
    if (appContext.workspace.role)
      appContext.workspace.role = redactor.scrub(appContext.workspace.role, 32)
    return {
      protocolVersion: WEBMCP_PROTOCOL_VERSION,
      appContext,
      revisionScope: scope,
      revision: this.context.revision(scope),
    }
  }

  public failure(
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
        diagnostics: [diagnosticForFailure(code, message, this.redactor())],
      },
    }
  }

  public result<T extends object>(
    scope: WebMCPRevisionScope,
    payload: T
  ): WebMCPToolResult<T> {
    const result = { ...this.base(scope), ok: true as const, ...payload }
    if (
      new TextEncoder().encode(JSON.stringify(result)).byteLength >
      MAX_OUTPUT_BYTES
    )
      return this.failure(
        "OUTPUT_LIMIT_EXCEEDED",
        "The safe projection exceeded the WebMCP output limit.",
        scope
      )
    return result
  }

  public validBoundary(input: unknown) {
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

  public redactor() {
    return new SecretRedactor(this.secrets)
  }

  public visibleREST() {
    return (
      this.context.captureVisibleREST() ??
      this.failure(
        "NO_ACTIVE_REST_REQUEST",
        "The normal REST request editor is no longer visible.",
        "app-context",
        true
      )
    )
  }

  public visibleGQL() {
    return (
      this.context.captureVisibleGQL() ??
      this.failure(
        "NO_ACTIVE_GRAPHQL_REQUEST",
        "The GraphQL request editor is no longer visible.",
        "app-context",
        true
      )
    )
  }

  public visibleRealtime(mode: RealtimeMode) {
    return this.context.realtimeMode() === mode
      ? true
      : this.failure(
          "NO_ACTIVE_REALTIME_SESSION",
          "The requested realtime session is no longer visible.",
          "app-context",
          true
        )
  }
}
