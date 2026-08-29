import { HoppGQLRequest, HoppRESTRequest } from "@hoppscotch/data"
import { Service } from "dioc"
import { cloneDeep } from "lodash-es"
import { computed, Ref, watch } from "vue"
import { Router } from "vue-router"

import {
  RESTRequestExecutionService,
  RESTRequestAlreadyRunningError,
} from "~/services/rest-request-execution.service"
import { RESTTabService } from "~/services/tab/rest"
import { GQLTabService } from "~/services/tab/graphql"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { HoppTab } from "~/services/tab"
import { HoppRequestDocument } from "~/helpers/rest/document"
import { HoppGQLDocument } from "~/helpers/graphql/document"
import { connection, gqlMessageEvent } from "~/helpers/graphql/connection"
import { GQLRequestExecutionService } from "~/services/graphql-execution.service"
import {
  RealtimeMode,
  RealtimeSessionService,
} from "~/services/realtime-session.service"
import {
  getSelectedEnvironmentIndex,
  setSelectedEnvironmentIndex,
} from "~/newstore/environments"

import { WebMCPAdapter } from "./adapter"
import { ActiveAppContextService, VisibleRESTContext } from "./context"
import { WebMCPEnvironmentService } from "./environment"
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
  configureGQLAuth,
  configureRESTAuth,
  replaceRESTDraftFields,
} from "./rest-drafts"
import {
  configureRESTAuthInputSchema,
  configureRESTAuthParser,
  editRESTScriptsInputSchema,
  editRESTScriptsParser,
  editRESTVariablesInputSchema,
  editRESTVariablesParser,
  editRESTRequestInputSchema,
  editRESTRequestParser,
  emptyInputSchema,
  executeRESTRequestParser,
  expectedRevisionSchema,
  inspectEnvironmentInputSchema,
  inspectEnvironmentParser,
  listEnvironmentsInputSchema,
  listEnvironmentsParser,
  readRESTPayloadInputSchema,
  readRESTPayloadParser,
  selectEnvironmentInputSchema,
  selectEnvironmentParser,
  editGraphQLOperationInputSchema,
  editGraphQLOperationParser,
  graphqlPayloadInputSchema,
  graphqlPayloadParser,
  graphqlSchemaSearchInputSchema,
  graphqlSchemaSearchParser,
  editRealtimeSessionInputSchema,
  editRealtimeSessionParser,
  mqttTopicInputSchema,
  mqttTopicParser,
  realtimeLogInputSchema,
  realtimeLogParser,
  realtimeMessageInputSchema,
  realtimeMessageParser,
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
    const normalized = /^(https?|wss?):\/\//.test(trimmed)
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
  private readonly gqlTabs = this.bind(GQLTabService)
  private readonly interceptor = this.bind(KernelInterceptorService)
  private readonly secrets = this.bind(SecretEnvironmentService)
  private readonly execution = this.bind(RESTRequestExecutionService)
  private readonly gqlExecution = this.bind(GQLRequestExecutionService)
  private readonly realtime = this.bind(RealtimeSessionService)
  private readonly environments = this.bind(WebMCPEnvironmentService)
  private readonly approval = this.bind(AgentActionApprovalService)
  private readonly activity = this.bind(AgentActivityService)

  private appController: AbortController | null = null
  private restController: AbortController | null = null
  private gqlController: AbortController | null = null
  private realtimeController: AbortController | null = null
  private registeredRealtimeMode: RealtimeMode | null = null
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
    await this.syncCapabilityPacks()
    this.stopCapabilityWatch = watch(
      () => [
        router.currentRoute.value.path,
        this.restTabs.currentTabID.value,
        this.restTabs.currentActiveTab.value.document.type,
        this.gqlTabs.currentTabID.value,
      ],
      () => void this.syncCapabilityPacks(),
      { flush: "post" }
    )
  }

  public stop() {
    this.stopCapabilityWatch?.()
    this.stopCapabilityWatch = null
    this.restController?.abort()
    this.restController = null
    this.gqlController?.abort()
    this.gqlController = null
    this.realtimeController?.abort()
    this.realtimeController = null
    this.registeredRealtimeMode = null
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

  private async syncGraphQLPack() {
    const available = this.context.isGQLAvailable()
    if (available && !this.gqlController) {
      this.gqlController = new AbortController()
      await this.registerGraphQLPack(this.gqlController.signal)
    } else if (!available && this.gqlController) {
      this.gqlController.abort()
      this.gqlController = null
    }
  }

  private async syncCapabilityPacks() {
    await Promise.all([
      this.syncRESTPack(),
      this.syncGraphQLPack(),
      this.syncRealtimePack(),
    ])
  }

  private async syncRealtimePack() {
    const mode = this.context.realtimeMode()
    if (mode === this.registeredRealtimeMode) return
    this.realtimeController?.abort()
    this.realtimeController = null
    this.registeredRealtimeMode = null
    if (!mode) return
    this.realtimeController = new AbortController()
    this.registeredRealtimeMode = mode
    await this.registerRealtimePack(mode, this.realtimeController.signal)
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
          name: "list_environments",
          title: "List available environments",
          description:
            "List personal and current-workspace environment choices as bounded metadata with opaque handles, names, scope, selection, and variable counts.",
          inputSchema: listEnvironmentsInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = listEnvironmentsParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const rest = this.visibleREST()
            if ("ok" in rest) return rest
            const listed = await this.environments.list(parsed.data.offset)
            const current = this.visibleREST()
            if ("ok" in current) return current
            const redactor = this.redactor()
            listed.environments = listed.environments.map((environment) => ({
              ...environment,
              name: redactor.scrub(environment.name, 64),
            }))
            return this.result("app-context", listed)
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "inspect_environment",
          title: "Inspect selected environment",
          description:
            "Inspect the selected environment through variable names, classification, and value-availability metadata.",
          inputSchema: inspectEnvironmentInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.inspectEnvironment(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "select_environment",
          title: "Select an environment",
          description:
            "Select an app-provided environment for the visible REST workspace using a revision-bound opaque handle. This visibly updates normal app state.",
          inputSchema: selectEnvironmentInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.selectEnvironment(input),
        },
        signal
      ),
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
          name: "configure_rest_auth",
          title: "Configure REST authorization",
          description:
            "Configure REST authorization in the visible draft with credential references supplied as environment variable names.",
          inputSchema: configureRESTAuthInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.configureRESTAuth(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "edit_rest_variables",
          title: "Edit REST request variables",
          description:
            "Replace bounded active-request variables in the visible REST draft and return its updated unsaved state.",
          inputSchema: editRESTVariablesInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.editRESTVariables(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "edit_rest_scripts",
          title: "Edit REST request scripts",
          description:
            "Store a bounded pre-request or post-request test script in the visible draft for a separately approved request execution.",
          inputSchema: editRESTScriptsInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.editRESTScripts(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "read_rest_payload",
          title: "Read REST payload window",
          description:
            "Read a bounded, revision-bound window from the visible REST request or response as redacted text or binary and file metadata.",
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
            "Apply an allow-listed revision-bound patch to the visible REST draft and return its updated unsaved state for request, URL, parameters, headers, and body fields.",
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

  private visibleGQL() {
    const gql = this.context.captureVisibleGQL()
    return (
      gql ??
      this.failure(
        "NO_ACTIVE_GRAPHQL_REQUEST",
        "The GraphQL request editor is no longer visible.",
        "app-context",
        true
      )
    )
  }

  private gqlExchange(document: HoppGQLDocument) {
    const redactor = this.redactor()
    const response = gqlMessageEvent.value
    const safeHeaders = document.request.headers.slice(0, 4).map((header) => ({
      key: redactor.scrub(header.key, 48),
      active: header.active,
      value: /authorization|cookie|token|secret|api[-_]?key/i.test(header.key)
        ? "[REDACTED]"
        : redactor.scrub(header.value, 48),
    }))
    const responseText =
      response && response !== "reset" && response.type === "response"
        ? redactor.scrub(response.data, 256)
        : undefined
    return {
      draft: {
        dirty: document.isDirty,
        provenance: document.saveContext?.originLocation ?? "unsaved",
      },
      operation: {
        endpoint: redactor.scrub(document.request.url, 128),
        queryPreview: redactor.scrub(document.request.query, 256),
        variablesPreview: redactor.scrub(document.request.variables, 128),
        headers: safeHeaders,
        auth: {
          type: document.request.auth?.authType ?? "none",
          active: document.request.auth?.authActive ?? false,
        },
      },
      connection: {
        state: connection.state,
        schemaLoaded: Boolean(connection.schema),
        subscriptionState:
          connection.subscriptionState.get(this.gqlTabs.currentTabID.value) ??
          "UNSUBSCRIBED",
      },
      response:
        response && response !== "reset"
          ? response.type === "error"
            ? {
                state: "error",
                message: redactor.scrub(response.error.message, 128),
              }
            : {
                state: "success",
                preview: responseText,
                status: response.document?.statusCode,
              }
          : { state: "empty" },
    }
  }

  private gqlObservation() {
    const gql = this.visibleGQL()
    if ("ok" in gql) return gql
    return this.result("graphql-document", {
      responseRevision: this.context.revision("graphql-response"),
      operation: this.gqlExchange(gql.tab.document),
    })
  }

  private async registerGraphQLPack(signal: AbortSignal) {
    await Promise.all([
      this.adapter.register(
        {
          name: "inspect_graphql_operation",
          title: "Inspect current GraphQL operation",
          description:
            "Inspect the visible GraphQL operation, connection, latest response, and draft state with bounded redacted content.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) =>
            this.validBoundary(input) && Object.keys(input).length === 0
              ? this.gqlObservation()
              : this.failure(
                  "INVALID_INPUT",
                  "This tool accepts an empty object only."
                ),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "read_graphql_payload",
          title: "Read GraphQL payload window",
          description:
            "Read a bounded revision-bound query, variables, or response text window from the visible GraphQL operation.",
          inputSchema: graphqlPayloadInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => this.readGraphQLPayload(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "search_graphql_schema",
          title: "Search GraphQL schema",
          description:
            "Search the loaded GraphQL schema by type or field name and return a bounded structural summary.",
          inputSchema: graphqlSchemaSearchInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => this.searchGraphQLSchema(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "edit_graphql_operation",
          title: "Edit current GraphQL operation",
          description:
            "Apply a bounded revision-bound patch to the visible GraphQL endpoint, document, variables, or headers without saving it.",
          inputSchema: editGraphQLOperationInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => this.editGraphQLOperation(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "configure_graphql_auth",
          title: "Configure GraphQL authorization",
          description:
            "Configure visible GraphQL authorization with environment variable references, never literal credential values.",
          inputSchema: configureRESTAuthInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => this.configureGraphQLAuth(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "connect_graphql",
          title: "Connect GraphQL schema",
          description:
            "Connect the visible GraphQL request to load its schema after approval.",
          inputSchema: expectedRevisionSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: actionSignal }) =>
            this.runGraphQLAction(input, actionSignal, "connect"),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "disconnect_graphql",
          title: "Disconnect GraphQL schema",
          description: "Disconnect the visible GraphQL schema connection.",
          inputSchema: expectedRevisionSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) =>
            this.runGraphQLAction(
              input,
              new AbortController().signal,
              "disconnect"
            ),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "execute_graphql_operation",
          title: "Execute GraphQL operation",
          description:
            "Execute a visible GraphQL query or mutation through an established GraphQL connection after approval.",
          inputSchema: expectedRevisionSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: actionSignal }) =>
            this.runGraphQLAction(input, actionSignal, "execute"),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "start_gql_subscription",
          title: "Start GraphQL subscription",
          description:
            "Start the visible GraphQL subscription after approval and return its lifecycle state.",
          inputSchema: expectedRevisionSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: actionSignal }) =>
            this.runGraphQLAction(input, actionSignal, "subscribe"),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "stop_gql_subscription",
          title: "Stop GraphQL subscription",
          description: "Stop the active visible GraphQL subscription.",
          inputSchema: expectedRevisionSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) =>
            this.runGraphQLAction(
              input,
              new AbortController().signal,
              "unsubscribe"
            ),
        },
        signal
      ),
    ])
  }

  private async readGraphQLPayload(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = graphqlPayloadParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.visibleGQL()
    if ("ok" in gql) return gql
    const scope =
      parsed.data.source === "response"
        ? "graphql-response"
        : "graphql-document"
    if (!this.context.matches(scope, parsed.data.expectedRevision)) {
      return this.failure(
        "STATE_CHANGED",
        "The payload changed; inspect it again.",
        scope,
        true
      )
    }
    const response = gqlMessageEvent.value
    const value =
      parsed.data.source === "query"
        ? gql.tab.document.request.query
        : parsed.data.source === "variables"
          ? gql.tab.document.request.variables
          : response && response !== "reset" && response.type === "response"
            ? response.data
            : ""
    const text = this.redactor().scrub(
      value,
      parsed.data.offset + parsed.data.maxChars
    )
    return this.result(scope, {
      payload: {
        source: parsed.data.source,
        offset: parsed.data.offset,
        text: text.slice(
          parsed.data.offset,
          parsed.data.offset + parsed.data.maxChars
        ),
        totalChars: text.length,
        truncated: parsed.data.offset + parsed.data.maxChars < text.length,
      },
    })
  }

  private async searchGraphQLSchema(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = graphqlSchemaSearchParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.visibleGQL()
    if ("ok" in gql) return gql
    const needle = parsed.data.query.toLocaleLowerCase()
    const matches = connection.schema
      ? Object.values(connection.schema.getTypeMap())
          .filter((item) => item.name.toLocaleLowerCase().includes(needle))
          .slice(0, 8)
          .map((item) => ({
            name: item.name,
            kind: item.astNode?.kind ?? "type",
          }))
      : []
    return this.result("graphql-document", {
      schemaLoaded: Boolean(connection.schema),
      matches,
    })
  }

  private async editGraphQLOperation(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = editGraphQLOperationParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.visibleGQL()
    if ("ok" in gql) return gql
    if (
      !this.context.matches("graphql-document", parsed.data.expectedRevision)
    ) {
      return this.failure(
        "STATE_CHANGED",
        "The GraphQL draft changed; inspect it again.",
        "graphql-document",
        true
      )
    }
    const original = cloneDeep(gql.tab.document.request)
    const candidate = { ...cloneDeep(original) }
    if (parsed.data.patch.endpoint !== undefined)
      candidate.url = parsed.data.patch.endpoint
    if (parsed.data.patch.query !== undefined)
      candidate.query = parsed.data.patch.query
    if (parsed.data.patch.variables !== undefined)
      candidate.variables = parsed.data.patch.variables
    if (parsed.data.patch.headers !== undefined)
      candidate.headers = parsed.data.patch.headers.map((header) => ({
        ...header,
        description: "",
      }))
    const validated = HoppGQLRequest.safeParse(candidate)
    if (validated.type !== "ok")
      return this.failure(
        "INVALID_INPUT",
        "The patch does not produce a valid GraphQL request.",
        "graphql-document"
      )
    gql.tab.document.request = validated.value
    gql.tab.document.isDirty = true
    const revision = this.context.revision("graphql-document")
    this.activity.record({
      tool: "edit_graphql_operation",
      outcome: "changed",
      summary:
        `Changed GraphQL ${Object.keys(parsed.data.patch).join(", ")}`.slice(
          0,
          256
        ),
      revision,
    })
    const observation = this.gqlObservation()
    return observation.ok
      ? { ...observation, changedFields: Object.keys(parsed.data.patch) }
      : observation
  }

  private async configureGraphQLAuth(input: Record<string, unknown>) {
    if (!this.validBoundary(input)) {
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    }
    const parsed = configureRESTAuthParser.safeParse(input)
    if (!parsed.success) {
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const gql = this.visibleGQL()
    if ("ok" in gql) return gql
    if (
      !this.context.matches("graphql-document", parsed.data.expectedRevision)
    ) {
      return this.failure(
        "STATE_CHANGED",
        "The GraphQL draft changed; inspect it again.",
        "graphql-document",
        true
      )
    }
    try {
      const { expectedRevision: _, ...configuration } = parsed.data
      gql.tab.document.request = {
        ...cloneDeep(gql.tab.document.request),
        auth: configureGQLAuth(gql.tab.document.request.auth, configuration),
      }
      gql.tab.document.isDirty = true
      this.activity.record({
        tool: "configure_graphql_auth",
        outcome: "changed",
        summary: `Configured GraphQL ${configuration.authType} authorization`,
        revision: this.context.revision("graphql-document"),
      })
      return this.gqlObservation()
    } catch (error) {
      return this.failure(
        "INVALID_INPUT",
        error instanceof Error ? error.message : "Invalid authorization",
        "graphql-document"
      )
    }
  }

  private async runGraphQLAction(
    input: Record<string, unknown>,
    signal: AbortSignal,
    action: "connect" | "disconnect" | "execute" | "subscribe" | "unsubscribe"
  ) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = executeRESTRequestParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.visibleGQL()
    if ("ok" in gql) return gql
    if (
      !this.context.matches("graphql-document", parsed.data.expectedRevision)
    ) {
      return this.failure(
        "STATE_CHANGED",
        "The GraphQL draft changed; inspect it again.",
        "graphql-document",
        true
      )
    }
    const consequential =
      action === "connect" || action === "execute" || action === "subscribe"
    if (consequential) {
      const approved = await this.approval.request(
        {
          action: `${action === "execute" ? "Execute" : action === "subscribe" ? "Start" : "Connect"} GraphQL`,
          method: "POST",
          target: this.redactor().scrub(
            safeTarget(gql.tab.document.request.url),
            256
          ),
          environment: this.context.capture().environment.name,
          workspace: this.context.capture().workspace.type,
          grantKey: `graphql|${action}|${this.context.capture().environment.name}|${this.context.capture().workspace.type}`,
        },
        signal
      )
      if (!approved)
        return this.failure(
          signal.aborted ? "CANCELLED" : "APPROVAL_DENIED",
          signal.aborted
            ? "The action was cancelled."
            : "The user denied the action.",
          "graphql-document"
        )
      if (
        !this.context.matches(
          "graphql-document",
          parsed.data.expectedRevision
        ) ||
        this.context.captureVisibleGQL()?.token !== gql.token
      ) {
        return this.failure(
          "STATE_CHANGED",
          "The GraphQL draft changed while approval was open.",
          "graphql-document",
          true
        )
      }
    }
    try {
      if (action === "connect") await this.gqlExecution.connect(gql.tab)
      else if (action === "disconnect") this.gqlExecution.disconnect()
      else if (action === "execute")
        await this.gqlExecution.executeConnected(gql.tab)
      else if (action === "subscribe")
        this.gqlExecution.startSubscriptionConnected(gql.tab)
      else this.gqlExecution.stopSubscription()
      this.activity.record({
        tool: `${action}_graphql`,
        outcome: action === "execute" ? "executed" : "changed",
        summary: `GraphQL ${action}`,
        revision: this.context.revision("graphql-document"),
      })
      return this.gqlObservation()
    } catch (error) {
      return this.failure(
        "EXECUTION_FAILED",
        error instanceof Error ? error.message : "GraphQL action failed.",
        "graphql-document"
      )
    }
  }

  private visibleRealtime(mode: RealtimeMode) {
    return this.context.realtimeMode() === mode
      ? true
      : this.failure(
          "NO_ACTIVE_REALTIME_SESSION",
          "The requested realtime session is no longer visible.",
          "app-context",
          true
        )
  }

  private async realtimeObservation(mode: RealtimeMode) {
    const visible = this.visibleRealtime(mode)
    if (visible !== true) return visible
    const snapshot = await this.realtime.snapshot(mode)
    const redactor = this.redactor()
    return this.result("realtime-session", {
      session: {
        mode,
        endpoint: redactor.scrub(snapshot.endpoint, 128),
        state: snapshot.state,
        configuration: snapshot.configuration,
        log: {
          total: snapshot.log.length,
          tail: snapshot.log.slice(-3).map((line) => ({
            source: redactor.scrub(line.source, 32),
            prefix: line.prefix ? redactor.scrub(line.prefix, 48) : undefined,
            payload: redactor.scrub(line.payload, 128),
            timestamp: line.ts,
          })),
        },
      },
    })
  }

  private async registerRealtimePack(mode: RealtimeMode, signal: AbortSignal) {
    const common = [
      this.adapter.register(
        {
          name: "inspect_realtime_session",
          title: "Inspect realtime session",
          description:
            "Inspect the visible realtime session configuration, connection state, and bounded redacted log tail.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) =>
            this.validBoundary(input) && Object.keys(input).length === 0
              ? this.realtimeObservation(mode)
              : this.failure(
                  "INVALID_INPUT",
                  "This tool accepts an empty object only."
                ),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "edit_realtime_session",
          title: "Edit realtime session",
          description:
            "Apply a bounded revision-bound configuration patch to the visible realtime session without creating a saved resource.",
          inputSchema: editRealtimeSessionInputSchema(mode),
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => this.editRealtimeSession(mode, input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "connect_realtime",
          title: "Connect realtime session",
          description:
            "Connect the visible realtime session after explicit app approval.",
          inputSchema: expectedRevisionSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: actionSignal }) =>
            this.runRealtimeAction(mode, "connect", input, actionSignal),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "disconnect_realtime",
          title: "Disconnect realtime session",
          description: "Disconnect the visible realtime session.",
          inputSchema: expectedRevisionSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) =>
            this.runRealtimeAction(
              mode,
              "disconnect",
              input,
              new AbortController().signal
            ),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "read_realtime_log",
          title: "Read realtime log window",
          description:
            "Read a bounded revision-bound window of the visible realtime session log.",
          inputSchema: realtimeLogInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => this.readRealtimeLog(mode, input),
        },
        signal
      ),
    ]
    if (mode === "websocket" || mode === "socketio") {
      common.push(
        this.adapter.register(
          {
            name: "send_realtime_message",
            title: "Send realtime message",
            description:
              "Send a message through the visible realtime connection after approval. Socket.IO requires an event name.",
            inputSchema: realtimeMessageInputSchema,
            annotations: { readOnlyHint: false, untrustedContentHint: true },
            execute: async (input, { signal: actionSignal }) =>
              this.runRealtimeAction(mode, "send", input, actionSignal),
          },
          signal
        )
      )
    }
    if (mode === "mqtt") {
      for (const [name, action, description] of [
        [
          "publish_mqtt_message",
          "publish",
          "Publish a message to an MQTT topic after approval.",
        ],
        [
          "subscribe_mqtt_topic",
          "subscribe",
          "Subscribe the visible MQTT session to a topic after approval.",
        ],
        [
          "unsubscribe_mqtt_topic",
          "unsubscribe",
          "Unsubscribe the visible MQTT session from a topic after approval.",
        ],
      ] as const) {
        common.push(
          this.adapter.register(
            {
              name,
              title: description.slice(0, 48),
              description,
              inputSchema: mqttTopicInputSchema,
              annotations: { readOnlyHint: false, untrustedContentHint: true },
              execute: async (input, { signal: actionSignal }) =>
                this.runRealtimeAction(mode, action, input, actionSignal),
            },
            signal
          )
        )
      }
    }
    await Promise.all(common)
  }

  private async editRealtimeSession(
    mode: RealtimeMode,
    input: Record<string, unknown>
  ) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = editRealtimeSessionParser(mode).safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const visible = this.visibleRealtime(mode)
    if (visible !== true) return visible
    if (
      !this.context.matches("realtime-session", parsed.data.expectedRevision)
    ) {
      return this.failure(
        "STATE_CHANGED",
        "The realtime session changed; inspect it again.",
        "realtime-session",
        true
      )
    }
    const fields = Object.keys(parsed.data.patch)
    await this.realtime.edit(mode, parsed.data.patch)
    this.activity.record({
      tool: "edit_realtime_session",
      outcome: "changed",
      summary: `Changed ${mode} ${fields.join(", ")}`.slice(0, 256),
      revision: this.context.revision("realtime-session"),
    })
    return this.realtimeObservation(mode)
  }

  private async readRealtimeLog(
    mode: RealtimeMode,
    input: Record<string, unknown>
  ) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = realtimeLogParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const visible = this.visibleRealtime(mode)
    if (visible !== true) return visible
    if (
      !this.context.matches("realtime-session", parsed.data.expectedRevision)
    ) {
      return this.failure(
        "STATE_CHANGED",
        "The realtime log changed; inspect it again.",
        "realtime-session",
        true
      )
    }
    const snapshot = await this.realtime.snapshot(mode)
    const redactor = this.redactor()
    const entries = snapshot.log
      .slice(parsed.data.offset, parsed.data.offset + parsed.data.limit)
      .map((line) => ({
        source: redactor.scrub(line.source, 32),
        prefix: line.prefix ? redactor.scrub(line.prefix, 48) : undefined,
        payload: redactor.scrub(line.payload, 256),
        timestamp: line.ts,
      }))
    return this.result("realtime-session", {
      log: {
        offset: parsed.data.offset,
        entries,
        total: snapshot.log.length,
        truncated: parsed.data.offset + entries.length < snapshot.log.length,
      },
    })
  }

  private async runRealtimeAction(
    mode: RealtimeMode,
    action:
      | "connect"
      | "disconnect"
      | "send"
      | "publish"
      | "subscribe"
      | "unsubscribe",
    input: Record<string, unknown>,
    signal: AbortSignal
  ) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parser =
      action === "send"
        ? realtimeMessageParser
        : action === "publish" ||
            action === "subscribe" ||
            action === "unsubscribe"
          ? mqttTopicParser
          : executeRESTRequestParser
    const parsed = parser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const visible = this.visibleRealtime(mode)
    if (visible !== true) return visible
    if (
      !this.context.matches("realtime-session", parsed.data.expectedRevision)
    ) {
      return this.failure(
        "STATE_CHANGED",
        "The realtime session changed; inspect it again.",
        "realtime-session",
        true
      )
    }
    const consequential = action !== "disconnect"
    const snapshot = await this.realtime.snapshot(mode)
    if (consequential) {
      const approved = await this.approval.request(
        {
          action: `${action[0].toUpperCase()}${action.slice(1)} ${mode}`,
          method: action.toUpperCase(),
          target: this.redactor().scrub(safeTarget(snapshot.endpoint), 256),
          environment: this.context.capture().environment.name,
          workspace: this.context.capture().workspace.type,
          grantKey: `realtime|${mode}|${action}|${snapshot.endpoint}|${this.context.capture().environment.name}`,
        },
        signal
      )
      if (!approved)
        return this.failure(
          signal.aborted ? "CANCELLED" : "APPROVAL_DENIED",
          signal.aborted
            ? "The action was cancelled."
            : "The user denied the action.",
          "realtime-session"
        )
      if (
        !this.context.matches(
          "realtime-session",
          parsed.data.expectedRevision
        ) ||
        this.visibleRealtime(mode) !== true
      ) {
        return this.failure(
          "STATE_CHANGED",
          "The realtime session changed while approval was open.",
          "realtime-session",
          true
        )
      }
    }
    try {
      if (action === "connect") {
        await this.realtime.connect(mode, signal)
      } else if (action === "disconnect") await this.realtime.disconnect(mode)
      else if (action === "send") {
        const message = realtimeMessageParser.parse(input)
        await this.realtime.send(
          mode as "websocket" | "socketio",
          message.message,
          message.eventName
        )
      } else {
        const topic = mqttTopicParser.parse(input)
        if (action === "publish")
          await this.realtime.publish(topic.topic, topic.message ?? "")
        else if (action === "subscribe")
          await this.realtime.subscribe(topic.topic, topic.qos)
        else await this.realtime.unsubscribe(topic.topic)
      }
      this.activity.record({
        tool: `${action}_${mode}`,
        outcome: consequential ? "executed" : "changed",
        summary: `${action} ${mode}`.slice(0, 256),
        revision: this.context.revision("realtime-session"),
      })
      return this.realtimeObservation(mode)
    } catch (error) {
      return this.failure(
        "EXECUTION_FAILED",
        error instanceof Error ? error.message : "Realtime action failed.",
        "realtime-session"
      )
    }
  }

  private async inspectEnvironment(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = inspectEnvironmentParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    const referencedNames = parsed.data.referencedOnly
      ? new Set(
          [
            ...JSON.stringify(rest.tab.document.request).matchAll(
              /<<([^<>]+)>>/g
            ),
          ].map((match) => match[1])
        )
      : undefined
    const environment = this.environments.inspectSelected(referencedNames)
    const redactor = this.redactor()
    environment.name = redactor.scrub(environment.name, 64)
    environment.variables = environment.variables.map((variable) => ({
      ...variable,
      name: redactor.scrub(variable.name, 64),
    }))
    return this.result("rest-document", { environment })
  }

  private async selectEnvironment(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = selectEnvironmentParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    if (!this.context.matches("app-context", parsed.data.expectedRevision)) {
      return this.failure(
        "STATE_CHANGED",
        "The app context changed; list environments again.",
        "app-context",
        true
      )
    }

    const original = cloneDeep(getSelectedEnvironmentIndex())
    if (!this.environments.select(parsed.data.environmentHandle)) {
      return this.failure(
        "ENVIRONMENT_NOT_FOUND",
        "The environment handle is no longer available; list environments again.",
        "app-context",
        true
      )
    }
    const resultingRevision = this.context.revision("app-context")
    const token = rest.token
    const selectedName = this.redactor().scrub(
      this.context.capture().environment.name,
      64
    )
    this.activity.record(
      {
        tool: "select_environment",
        outcome: "changed",
        summary: `Selected environment ${selectedName}`.slice(0, 256),
        revision: resultingRevision,
      },
      () => {
        if (
          this.context.captureVisibleREST()?.token !== token ||
          !this.context.matches("app-context", resultingRevision)
        )
          return false
        setSelectedEnvironmentIndex(original)
        return true
      }
    )
    return this.result("app-context", { selected: true })
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

  private async configureRESTAuth(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = configureRESTAuthParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
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

    try {
      const { expectedRevision: _, ...configuration } = parsed.data
      const auth = configureRESTAuth(
        rest.tab.document.request.auth,
        configuration
      )
      const request = replaceRESTDraftFields(rest.tab.document.request, {
        auth,
      })
      return this.commitRESTDraft(
        rest,
        request,
        "configure_rest_auth",
        `Configured REST ${configuration.authType} authorization`,
        ["auth"]
      )
    } catch (error) {
      return this.failure(
        "INVALID_INPUT",
        error instanceof Error ? error.message : "Invalid authorization",
        "rest-document"
      )
    }
  }

  private async editRESTVariables(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = editRESTVariablesParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
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

    try {
      const request = replaceRESTDraftFields(rest.tab.document.request, {
        requestVariables: parsed.data.variables,
      })
      return this.commitRESTDraft(
        rest,
        request,
        "edit_rest_variables",
        `Replaced ${parsed.data.variables.length} REST request variables`,
        ["requestVariables"]
      )
    } catch (error) {
      return this.failure(
        "INVALID_INPUT",
        error instanceof Error ? error.message : "Invalid request variables",
        "rest-document"
      )
    }
  }

  private async editRESTScripts(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = editRESTScriptsParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
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

    try {
      const field =
        parsed.data.target === "pre_request" ? "preRequestScript" : "testScript"
      const request = replaceRESTDraftFields(rest.tab.document.request, {
        [field]: parsed.data.script,
      })
      return this.commitRESTDraft(
        rest,
        request,
        "edit_rest_scripts",
        `Replaced REST ${parsed.data.target} script`,
        [field]
      )
    } catch (error) {
      return this.failure(
        "INVALID_INPUT",
        error instanceof Error ? error.message : "Invalid request script",
        "rest-document"
      )
    }
  }

  private async commitRESTDraft(
    rest: VisibleRESTContext,
    request: HoppRESTRequest,
    tool: "configure_rest_auth" | "edit_rest_variables" | "edit_rest_scripts",
    summary: string,
    changedFields: string[]
  ) {
    const originalRequest = cloneDeep(rest.tab.document.request)
    const originalDirty = rest.tab.document.isDirty
    rest.tab.document.request = request
    rest.tab.document.isDirty = true
    const resultingRevision = this.context.revision("rest-document")
    const token = rest.token
    this.activity.record(
      {
        tool,
        outcome: "changed",
        summary: summary.slice(0, 256),
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
