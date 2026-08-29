import {
  HoppCollection,
  HoppGQLRequest,
  HoppRESTRequest,
  getDefaultGQLRequest,
  makeCollection,
} from "@hoppscotch/data"
import { Service } from "dioc"
import { cloneDeep } from "lodash-es"
import { computed, ref, Ref, watch } from "vue"
import { Router } from "vue-router"

import {
  RESTRequestExecutionService,
  RESTRequestAlreadyRunningError,
} from "~/services/rest-request-execution.service"
import { RESTTabService } from "~/services/tab/rest"
import { GQLTabService } from "~/services/tab/graphql"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { WorkspaceService } from "~/services/workspace.service"
import {
  TestRunnerService,
  TestRunnerRequest,
} from "~/services/test-runner/test-runner.service"
import { getDefaultRESTRequest } from "~/helpers/rest/default"
import {
  restCollectionStore,
  graphqlCollectionStore,
  navigateToFolderWithIndexPath,
  getRESTCollectionByRefId,
  saveRESTRequestAs,
  editRESTRequest,
  saveGraphqlRequestAs,
  editGraphqlRequest,
  removeRESTCollection,
  removeRESTFolder,
  addRESTCollection,
  addRESTFolder,
  cascadeParentCollectionForProperties,
} from "~/newstore/collections"
import { restHistoryStore, graphqlHistoryStore } from "~/newstore/history"
import { HoppTab } from "~/services/tab"
import {
  HoppRequestDocument,
  HoppTestRunnerDocument,
} from "~/helpers/rest/document"
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
  deleteEnvironment,
  environmentsStore,
} from "~/newstore/environments"
import { CurrentValueService } from "~/services/current-environment-value.service"

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
  createEnvironmentInputSchema,
  createEnvironmentParser,
  editEnvironmentVariablesInputSchema,
  editEnvironmentVariablesParser,
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
  editRESTBodyInputSchema,
  editRESTBodyParser,
  readRESTScriptInputSchema,
  readRESTScriptParser,
  editGraphQLVariablesInputSchema,
  editGraphQLVariablesParser,
  switchTabInputSchema,
  switchTabParser,
  createTabInputSchema,
  createTabParser,
  closeTabInputSchema,
  closeTabParser,
  inspectCollectionInputSchema,
  inspectCollectionParser,
  saveRequestToCollectionInputSchema,
  saveRequestToCollectionParser,
  listHistoryInputSchema,
  listHistoryParser,
  loadHistoryEntryInputSchema,
  loadHistoryEntryParser,
  switchWorkspaceInputSchema,
  switchWorkspaceParser,
  runCollectionInputSchema,
  runCollectionParser,
  deleteCollectionInputSchema,
  deleteCollectionParser,
  deleteFolderInputSchema,
  deleteFolderParser,
  deleteEnvironmentInputSchema,
  deleteEnvironmentParser,
  createCollectionInputSchema,
  createCollectionParser,
  createFolderInputSchema,
  createFolderParser,
  getSkillInputSchema,
  getSkillParser,
} from "./schemas"
import { findSkill, listSkills } from "./skills"
import {
  applyJSONPointerOperations,
  diagnosticForError,
  diagnosticForFailure,
} from "./diagnostics"
import {
  RESTRequestPatch,
  WEBMCP_PROTOCOL_VERSION,
  WebMCPErrorCode,
  WebMCPRevisionScope,
  WebMCPToolFailure,
  WebMCPToolResult,
} from "./types"

const MAX_INPUT_BYTES = 128 * 1024
// Bounded tool output limit (8 KiB) protecting LLM context and IPC transport.
// Payload inspection details remain accessible via bounded read_rest_payload windows.
const MAX_OUTPUT_BYTES = 8192

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

const countCollectionRequests = (collection: HoppCollection): number => {
  let count = collection.requests.length
  for (const folder of collection.folders) {
    count += countCollectionRequests(folder)
  }
  return count
}

const extractRunnerResults = (
  collection: HoppCollection,
  redactor: SecretRedactor,
  results: Array<{
    name: string
    method: string
    endpoint: string
    statusCode: number | null
    duration: number | null
    passedTests: number
    failedTests: number
    error?: string
  }> = []
) => {
  for (const request of collection.requests as TestRunnerRequest[]) {
    if (results.length >= 50) break
    const response = request.response
    const statusCode = response && "status" in response ? response.status : null
    const duration =
      response && "meta" in response && response.meta?.responseDuration
        ? response.meta.responseDuration
        : null
    results.push({
      name: redactor.scrub(request.name || "Untitled", 64),
      method: request.method,
      endpoint: redactor.scrub(request.endpoint || "", 128),
      statusCode,
      duration,
      passedTests: request.passedTests ?? 0,
      failedTests: request.failedTests ?? 0,
      error: request.error ? redactor.scrub(request.error, 128) : undefined,
    })
  }
  for (const folder of collection.folders) {
    if (results.length >= 50) break
    extractRunnerResults(folder, redactor, results)
  }
  return results
}

export class WebMCPService extends Service {
  public static readonly ID = "WEBMCP_SERVICE"

  private readonly enabled = import.meta.env.VITE_ENABLE_WEBMCP === "true"
  private readonly adapter = new WebMCPAdapter(this.enabled)
  private readonly context = this.bind(ActiveAppContextService)
  private readonly restTabs = this.bind(RESTTabService)
  private readonly gqlTabs = this.bind(GQLTabService)
  private readonly workspace = this.bind(WorkspaceService)
  private readonly interceptor = this.bind(KernelInterceptorService)
  private readonly secrets = this.bind(SecretEnvironmentService)
  private readonly execution = this.bind(RESTRequestExecutionService)
  private readonly testRunner = this.bind(TestRunnerService)
  private readonly gqlExecution = this.bind(GQLRequestExecutionService)
  private readonly realtime = this.bind(RealtimeSessionService)
  private readonly environments = this.bind(WebMCPEnvironmentService)
  private readonly currentValues = this.bind(CurrentValueService)
  private readonly approval = this.bind(AgentActionApprovalService)
  private readonly activity = this.bind(AgentActivityService)

  private appController: AbortController | null = null
  private durableOpsController: AbortController | null = null
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
    if (import.meta.env.VITE_ENABLE_WEBMCP_DURABLE_OPS === "true") {
      this.durableOpsController = new AbortController()
      await this.registerDurableOpsPack(this.durableOpsController.signal)
    }
    await this.syncCapabilityPacks()
    this.stopCapabilityWatch = watch(
      () => [
        router.currentRoute.value.path,
        this.restTabs.currentTabID.value,
        this.restTabs.currentActiveTab.value?.document?.type,
        this.gqlTabs.currentTabID.value,
      ],
      () => void this.syncCapabilityPacks(),
      { flush: "post" }
    )
  }

  public stop() {
    this.stopCapabilityWatch?.()
    this.stopCapabilityWatch = null
    this.durableOpsController?.abort()
    this.durableOpsController = null
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
    this.context.dispose()
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
        diagnostics: [diagnosticForFailure(code, message, this.redactor())],
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
    await Promise.all([
      this.adapter.register(
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
      ),
      this.adapter.register(
        {
          name: "list_workspaces",
          title: "List available workspaces",
          description:
            "List personal and team workspaces with their names, roles, and current selection status.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (!this.validBoundary(input) || Object.keys(input).length !== 0) {
              return this.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            }
            const current = this.workspace.currentWorkspace.value
            const redactor = this.redactor()
            const listAdapter = this.workspace.acquireTeamListAdapter(null)
            const teams = listAdapter.teamList$.value
            const workspaces = [
              {
                id: "personal",
                name: "Personal Workspace",
                type: "personal",
                isCurrent: current.type === "personal",
              },
              ...teams.map((team) => ({
                id: team.id,
                name: redactor.scrub(team.name, 64),
                type: "team",
                role: team.myRole ? redactor.scrub(team.myRole, 32) : undefined,
                isCurrent:
                  current.type === "team" && current.teamID === team.id,
              })),
            ]
            return this.result("app-context", { workspaces })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "switch_workspace",
          title: "Switch active workspace",
          description:
            "Switch to the personal workspace or a team workspace by workspace ID.",
          inputSchema: switchWorkspaceInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = switchWorkspaceParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches("app-context", parsed.data.expectedRevision)
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }
            if (parsed.data.workspaceID === "personal") {
              this.workspace.changeWorkspace({ type: "personal" })
            } else {
              const listAdapter = this.workspace.acquireTeamListAdapter(null)
              const team = listAdapter.teamList$.value.find(
                (t) => t.id === parsed.data.workspaceID
              )
              if (!team) {
                return this.failure(
                  "INVALID_INPUT",
                  "The requested team workspace was not found.",
                  "app-context"
                )
              }
              this.workspace.changeWorkspace({
                type: "team",
                teamID: team.id,
                teamName: team.name,
                role: team.myRole,
              })
            }
            this.activity.record({
              tool: "switch_workspace",
              outcome: "changed",
              summary: `Switched workspace to ${parsed.data.workspaceID}`,
              revision: this.context.revision("app-context"),
            })
            return this.result("app-context", { switched: true })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "get_skill",
          title: "Get Hoppscotch skill or documentation",
          description:
            "Retrieve reference documentation, rules, API signatures, and code examples for Hoppscotch capabilities (e.g. 'scripting-sandbox', 'variables-and-environments', 'test-assertions', 'auth-configuration'). Omit name or pass 'list' to view the index of all available skills.",
          inputSchema: getSkillInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: false },
          execute: async (input: Record<string, unknown>) =>
            this.getSkill(input),
        },
        signal
      ),
    ])
  }

  private async registerDurableOpsPack(signal: AbortSignal) {
    await Promise.all([
      this.adapter.register(
        {
          name: "delete_collection",
          title: "Delete collection",
          description:
            "Permanently delete a collection from user storage. Requires exact collection confirmation name.",
          inputSchema: deleteCollectionInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = deleteCollectionParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }

            if (!/^\d+$/.test(parsed.data.collectionPath)) {
              return this.failure(
                "INVALID_INPUT",
                "Collection path must be a top-level collection index (e.g. '0'). For subfolders, use delete_folder.",
                "app-context"
              )
            }

            const pathIndex = parseInt(parsed.data.collectionPath, 10)
            const collection = restCollectionStore.value.state[pathIndex]
            if (!collection) {
              return this.failure(
                "INVALID_INPUT",
                `Collection at path ${parsed.data.collectionPath} not found.`,
                "app-context"
              )
            }

            if (collection.name !== parsed.data.confirmationName) {
              return this.failure(
                "INVALID_INPUT",
                `Confirmation name '${parsed.data.confirmationName}' does not match collection name '${collection.name}'.`,
                "app-context"
              )
            }

            const envName = this.context.capture().environment.name
            const workspaceType = this.context.capture().workspace.type

            const approved = await this.approval.request(
              {
                action: "DELETE collection",
                method: "DELETE",
                target: collection.name,
                environment: envName,
                workspace: workspaceType,
                grantKey: `delete-collection|${collection.name}|${envName}|${workspaceType}`,
              },
              executionSignal
            )

            if (!approved) {
              this.activity.record({
                tool: "delete_collection",
                outcome: "denied",
                summary: `Denied deleting collection '${collection.name}'`,
                revision: this.context.revision("app-context"),
              })
              return this.failure(
                "APPROVAL_DENIED",
                "The user rejected deleting the collection.",
                "app-context"
              )
            }

            const deletedName = collection.name
            removeRESTCollection(pathIndex, collection._ref_id || collection.id)

            this.activity.record({
              tool: "delete_collection",
              outcome: "changed",
              summary: `Permanently deleted collection '${deletedName}'`,
              revision: this.context.revision("app-context"),
            })

            return this.result("app-context", {
              success: true,
              deletedCollection: deletedName,
            })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "delete_folder",
          title: "Delete collection folder",
          description:
            "Permanently delete a subfolder from a collection. Requires exact folder confirmation name.",
          inputSchema: deleteFolderInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = deleteFolderParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }

            const pathSegments = parsed.data.folderPath
              .split("/")
              .map((x) => parseInt(x, 10))
            if (
              pathSegments.length < 2 ||
              pathSegments.some((n) => isNaN(n) || n < 0) ||
              !/^\d+(\/\d+)+$/.test(parsed.data.folderPath)
            ) {
              return this.failure(
                "INVALID_INPUT",
                "Folder path must specify both parent collection and subfolder index (e.g. '0/0').",
                "app-context"
              )
            }

            const target = navigateToFolderWithIndexPath(
              restCollectionStore.value.state,
              pathSegments
            )
            if (!target) {
              return this.failure(
                "INVALID_INPUT",
                `Folder at path ${parsed.data.folderPath} not found.`,
                "app-context"
              )
            }

            if (target.name !== parsed.data.confirmationName) {
              return this.failure(
                "INVALID_INPUT",
                `Confirmation name '${parsed.data.confirmationName}' does not match folder name '${target.name}'.`,
                "app-context"
              )
            }

            const envName = this.context.capture().environment.name
            const workspaceType = this.context.capture().workspace.type

            const approved = await this.approval.request(
              {
                action: "DELETE folder",
                method: "DELETE",
                target: target.name,
                environment: envName,
                workspace: workspaceType,
                grantKey: `delete-folder|${target.name}|${envName}|${workspaceType}`,
              },
              executionSignal
            )

            if (!approved) {
              this.activity.record({
                tool: "delete_folder",
                outcome: "denied",
                summary: `Denied deleting folder '${target.name}'`,
                revision: this.context.revision("app-context"),
              })
              return this.failure(
                "APPROVAL_DENIED",
                "The user rejected deleting the folder.",
                "app-context"
              )
            }

            const deletedName = target.name
            removeRESTFolder(parsed.data.folderPath, target.id)

            this.activity.record({
              tool: "delete_folder",
              outcome: "changed",
              summary: `Permanently deleted folder '${deletedName}'`,
              revision: this.context.revision("app-context"),
            })

            return this.result("app-context", {
              success: true,
              deletedFolder: deletedName,
            })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "create_collection",
          title: "Create collection",
          description:
            "Create a new top-level REST collection. Use this when the collection list is empty or when the user asks to create a collection before saving requests.",
          inputSchema: createCollectionInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = createCollectionParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }

            const envName = this.context.capture().environment.name
            const workspaceType = this.context.capture().workspace.type

            const approved = await this.approval.request(
              {
                action: "CREATE collection",
                method: "POST",
                target: parsed.data.name,
                environment: envName,
                workspace: workspaceType,
                allowSession: true,
                grantKey: `create-collection|${envName}|${workspaceType}`,
              },
              executionSignal
            )

            if (!approved) {
              this.activity.record({
                tool: "create_collection",
                outcome: "denied",
                summary: `Denied creating collection '${parsed.data.name}'`,
                revision: this.context.revision("app-context"),
              })
              return this.failure(
                "APPROVAL_DENIED",
                "The user rejected creating the collection.",
                "app-context"
              )
            }

            const newCollection = makeCollection({
              name: parsed.data.name,
              folders: [],
              requests: [],
              headers: [],
              variables: [],
              description: null,
              preRequestScript: "",
              testScript: "",
              auth: { authType: "inherit", authActive: false },
            })
            addRESTCollection(newCollection)

            const newIndex = restCollectionStore.value.state.length - 1

            const activityId = this.activity.record(
              {
                tool: "create_collection",
                outcome: "changed",
                summary: `Created collection '${parsed.data.name}' at path ${newIndex}`,
                revision: this.context.revision("app-context"),
              },
              () => {
                removeRESTCollection(
                  newIndex,
                  newCollection._ref_id || newCollection.id
                )
                return true
              }
            )
            void activityId

            return this.result("app-context", {
              success: true,
              collectionPath: String(newIndex),
              name: parsed.data.name,
            })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "create_folder",
          title: "Create collection folder",
          description:
            "Create a new subfolder inside an existing collection or folder. The new folder's path will be collectionPath/N where N is the appended index.",
          inputSchema: createFolderInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = createFolderParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }

            const pathSegments = parsed.data.collectionPath
              .split("/")
              .map((x) => parseInt(x, 10))
            if (
              pathSegments.some((n) => isNaN(n) || n < 0) ||
              !/^\d+(\/\d+)*$/.test(parsed.data.collectionPath)
            ) {
              return this.failure(
                "INVALID_INPUT",
                "Collection path must be a numeric index path (e.g. '0' or '0/1').",
                "app-context"
              )
            }

            const parent = navigateToFolderWithIndexPath(
              restCollectionStore.value.state,
              pathSegments
            )
            if (!parent) {
              return this.failure(
                "INVALID_INPUT",
                `Collection/folder at path ${parsed.data.collectionPath} not found.`,
                "app-context"
              )
            }

            const envName = this.context.capture().environment.name
            const workspaceType = this.context.capture().workspace.type

            const approved = await this.approval.request(
              {
                action: "CREATE folder",
                method: "POST",
                target: `${parsed.data.name} inside ${parent.name}`,
                environment: envName,
                workspace: workspaceType,
                allowSession: true,
                grantKey: `create-folder|${envName}|${workspaceType}`,
              },
              executionSignal
            )

            if (!approved) {
              this.activity.record({
                tool: "create_folder",
                outcome: "denied",
                summary: `Denied creating folder '${parsed.data.name}' in '${parent.name}'`,
                revision: this.context.revision("app-context"),
              })
              return this.failure(
                "APPROVAL_DENIED",
                "The user rejected creating the folder.",
                "app-context"
              )
            }

            addRESTFolder(parsed.data.name, parsed.data.collectionPath)

            const updatedParent = navigateToFolderWithIndexPath(
              restCollectionStore.value.state,
              pathSegments
            )
            const newFolderIndex = updatedParent
              ? updatedParent.folders.length - 1
              : 0
            const newFolderPath = `${parsed.data.collectionPath}/${newFolderIndex}`

            const activityId = this.activity.record(
              {
                tool: "create_folder",
                outcome: "changed",
                summary: `Created folder '${parsed.data.name}' at path ${newFolderPath}`,
                revision: this.context.revision("app-context"),
              },
              () => {
                removeRESTFolder(newFolderPath)
                return true
              }
            )
            void activityId

            return this.result("app-context", {
              success: true,
              folderPath: newFolderPath,
              name: parsed.data.name,
            })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "delete_environment",
          title: "Delete environment",
          description:
            "Permanently delete a custom environment definition. Requires exact environment confirmation name.",
          inputSchema: deleteEnvironmentInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = deleteEnvironmentParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }

            const envs = environmentsStore.value.environments
            const targetEnv = envs[parsed.data.environmentIndex]
            if (!targetEnv) {
              return this.failure(
                "INVALID_INPUT",
                `Environment at index ${parsed.data.environmentIndex} not found.`,
                "app-context"
              )
            }

            if (targetEnv.name !== parsed.data.confirmationName) {
              return this.failure(
                "INVALID_INPUT",
                `Confirmation name '${parsed.data.confirmationName}' does not match environment name '${targetEnv.name}'.`,
                "app-context"
              )
            }

            const currentEnvName = this.context.capture().environment.name
            const workspaceType = this.context.capture().workspace.type

            const approved = await this.approval.request(
              {
                action: "DELETE environment",
                method: "DELETE",
                target: targetEnv.name,
                environment: currentEnvName,
                workspace: workspaceType,
                grantKey: `delete-environment|${targetEnv.name}|${currentEnvName}|${workspaceType}`,
              },
              executionSignal
            )

            if (!approved) {
              this.activity.record({
                tool: "delete_environment",
                outcome: "denied",
                summary: `Denied deleting environment '${targetEnv.name}'`,
                revision: this.context.revision("app-context"),
              })
              return this.failure(
                "APPROVAL_DENIED",
                "The user rejected deleting the environment.",
                "app-context"
              )
            }

            const deletedName = targetEnv.name
            deleteEnvironment(parsed.data.environmentIndex, targetEnv.id)
            if (targetEnv.id) {
              this.currentValues.deleteEnvironment(targetEnv.id)
              this.secrets.deleteSecretEnvironment(targetEnv.id)
            }

            this.activity.record({
              tool: "delete_environment",
              outcome: "changed",
              summary: `Permanently deleted environment '${deletedName}'`,
              revision: this.context.revision("app-context"),
            })

            return this.result("app-context", {
              success: true,
              deletedEnvironment: deletedName,
            })
          },
        },
        signal
      ),
    ])
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
          name: "create_environment",
          title: "Create an environment",
          description:
            "Create a personal or team environment with optional initial variables and secrets. Secrets and team environments require human confirmation.",
          inputSchema: createEnvironmentInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) =>
            this.createEnvironment(input, executionSignal),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "edit_environment_variables",
          title: "Edit environment variables and secrets",
          description:
            "Batch add, update, or remove variables and secrets in an environment using an opaque environment handle. Secret updates and team environments require human confirmation; secrets cannot be downgraded to non-secrets.",
          inputSchema: editEnvironmentVariablesInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) =>
            this.editEnvironmentVariables(input, executionSignal),
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
            "Replace bounded active-request variables in the visible REST draft and return its updated unsaved state. Use get_skill({ name: 'variables-and-environments' }) for templating and cascade rules.",
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
            "Store a bounded pre-request or post-request test script in the visible draft for a separately approved request execution. Use get_skill({ name: 'scripting-sandbox' }) or get_skill({ name: 'test-assertions' }) for APIs and matchers.",
          inputSchema: editRESTScriptsInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.editRESTScripts(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "inspect_rest_scripting",
          title: "Inspect REST scripting",
          description:
            "Inspect visible request and inherited JavaScript script-chain metadata and static diagnostics without disclosing source text. Use get_skill({ name: 'scripting-sandbox' }) for sandbox API reference.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.validBoundary(input) && Object.keys(input).length === 0
              ? this.inspectRESTScripting()
              : this.failure(
                  "INVALID_INPUT",
                  "This tool accepts an empty object only."
                ),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "read_rest_script",
          title: "Read approved REST script window",
          description:
            "Disclose one bounded, revision-bound redacted script window after explicit per-read approval. Approval is never reusable.",
          inputSchema: readRESTScriptInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (
            input: Record<string, unknown>,
            { signal: actionSignal }: { signal: AbortSignal }
          ) => this.readRESTScript(input, actionSignal),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "edit_rest_body",
          title: "Edit structured REST body",
          description:
            "Apply revision-bound JSON, URL-encoded, or multipart text-part body edits. File and binary content remain opaque and read-only.",
          inputSchema: editRESTBodyInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.editRESTBody(input),
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
            "Apply an allow-listed revision-bound patch to the visible REST draft and return its updated unsaved state for name, method, URL, parameters, headers, and body fields.",
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
      this.adapter.register(
        {
          name: "list_tabs",
          title: "List open tabs",
          description:
            "List all open editor tabs for the current mode with their IDs, titles, dirty states, and active selection.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input) || Object.keys(input).length !== 0) {
              return this.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            }
            const redactor = this.redactor()
            const tabs = this.restTabs.getTabs().map((tab) => ({
              id: tab.id,
              title: redactor.scrub(
                tab.document.type === "request"
                  ? tab.document.request.name
                  : tab.document.type,
                64
              ),
              type: tab.document.type,
              isDirty: tab.document.isDirty,
              isActive: tab.id === this.restTabs.currentTabID.value,
              saveContext:
                tab.document.type === "request" && tab.document.saveContext
                  ? {
                      originLocation: tab.document.saveContext.originLocation,
                      folderPath:
                        tab.document.saveContext.originLocation ===
                        "user-collection"
                          ? tab.document.saveContext.folderPath
                          : undefined,
                    }
                  : undefined,
            }))
            return this.result("rest-document", { tabs })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "switch_tab",
          title: "Switch active tab",
          description: "Switch to a specific open tab by tab ID.",
          inputSchema: switchTabInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = switchTabParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "rest-document",
                true
              )
            }
            const tab = this.restTabs
              .getTabs()
              .find((t) => t.id === parsed.data.tabID)
            if (!tab) {
              return this.failure(
                "INVALID_INPUT",
                "The requested tab was not found.",
                "rest-document"
              )
            }
            this.restTabs.setActiveTab(parsed.data.tabID)
            this.activity.record({
              tool: "switch_tab",
              outcome: "changed",
              summary: `Switched active tab to ${parsed.data.tabID}`,
              revision: this.context.revision("rest-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "create_tab",
          title: "Create new tab",
          description:
            "Open a new blank request tab in the editor and set it as active.",
          inputSchema: createTabInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = createTabParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "rest-document",
                true
              )
            }
            const req = getDefaultRESTRequest()
            if (parsed.data.name) req.name = parsed.data.name
            const newTab = this.restTabs.createNewTab(
              {
                type: "request",
                request: req,
                isDirty: false,
                optionTabPreference: "params",
              },
              true
            )
            this.activity.record({
              tool: "create_tab",
              outcome: "changed",
              summary: `Created new tab ${newTab.id}`,
              revision: this.context.revision("rest-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "close_tab",
          title: "Close tab",
          description:
            "Close an open tab by ID. If the tab has unsaved changes, force must be set to true.",
          inputSchema: closeTabInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = closeTabParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "rest-document",
                true
              )
            }
            const tab = this.restTabs
              .getTabs()
              .find((t) => t.id === parsed.data.tabID)
            if (!tab) {
              return this.failure(
                "INVALID_INPUT",
                "The requested tab was not found.",
                "rest-document"
              )
            }
            if (this.restTabs.getTabs().length <= 1) {
              return this.failure(
                "INVALID_INPUT",
                "Cannot close the only open tab.",
                "rest-document"
              )
            }
            if (tab.document.isDirty && !parsed.data.force) {
              return this.failure(
                "DIRTY_TAB_UNSAVED_CHANGES",
                "The tab has unsaved changes. Save it to a collection or pass force: true to discard changes.",
                "rest-document"
              )
            }
            this.restTabs.closeTab(parsed.data.tabID)
            this.activity.record({
              tool: "close_tab",
              outcome: "changed",
              summary: `Closed tab ${parsed.data.tabID}`,
              revision: this.context.revision("rest-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "list_collections",
          title: "List collections",
          description:
            "List top-level collections with folder counts, request counts, and paths.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input) || Object.keys(input).length !== 0) {
              return this.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            }
            const redactor = this.redactor()
            const collections = restCollectionStore.value.state.map(
              (col, index) => ({
                id: col.id,
                name: redactor.scrub(col.name, 64),
                path: String(index),
                foldersCount: col.folders.length,
                requestsCount: col.requests.length,
              })
            )
            return this.result("rest-document", { collections })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "inspect_collection",
          title: "Inspect collection or folder",
          description:
            "Inspect the structure of a specific collection or folder by path.",
          inputSchema: inspectCollectionInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = inspectCollectionParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const target = navigateToFolderWithIndexPath(
              restCollectionStore.value.state,
              parsed.data.path.split("/").map((x) => parseInt(x, 10))
            )
            if (!target) {
              return this.failure(
                "INVALID_INPUT",
                "The requested collection or folder path was not found.",
                "rest-document"
              )
            }
            const redactor = this.redactor()
            return this.result("rest-document", {
              collection: {
                name: redactor.scrub(target.name, 64),
                path: parsed.data.path,
                authType: target.auth?.authType ?? "inherit",
                headersCount: target.headers?.length ?? 0,
                variablesCount: target.variables?.length ?? 0,
                folders: target.folders.map((f, i) => ({
                  name: redactor.scrub(f.name, 64),
                  path: `${parsed.data.path}/${i}`,
                  foldersCount: f.folders.length,
                  requestsCount: f.requests.length,
                })),
                requests: target.requests.map((r, i) => ({
                  name: redactor.scrub(r.name, 64),
                  method: (r as HoppRESTRequest).method,
                  endpoint: redactor.scrub(
                    (r as HoppRESTRequest).endpoint || "",
                    128
                  ),
                  index: i,
                })),
              },
            })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "save_request_to_collection",
          title: "Save request to collection",
          description:
            "Save the visible request draft into a collection/folder or update it in place.",
          inputSchema: saveRequestToCollectionInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = saveRequestToCollectionParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const rest = this.visibleREST()
            if ("ok" in rest) return rest
            if (
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The request draft changed; inspect it again.",
                "rest-document",
                true
              )
            }
            const activeTab = rest.tab
            const currentDoc = activeTab.document
            const reqToSave = cloneDeep(currentDoc.request)
            if (parsed.data.name) reqToSave.name = parsed.data.name

            let path = parsed.data.collectionPath
            if (
              !path &&
              currentDoc.saveContext?.originLocation === "user-collection"
            ) {
              path = currentDoc.saveContext.folderPath
            }
            if (!path) {
              path = "0"
            }

            const target = navigateToFolderWithIndexPath(
              restCollectionStore.value.state,
              path.split("/").map((x) => parseInt(x, 10))
            )
            if (!target) {
              return this.failure(
                "INVALID_INPUT",
                `Collection path ${path} not found.`,
                "rest-document"
              )
            }

            if (
              !parsed.data.collectionPath &&
              currentDoc.saveContext?.originLocation === "user-collection" &&
              currentDoc.saveContext.requestIndex !== undefined
            ) {
              editRESTRequest(
                path,
                currentDoc.saveContext.requestIndex,
                reqToSave
              )
              activeTab.document.isDirty = false
              activeTab.document.request = reqToSave
            } else {
              const insertionIndex = saveRESTRequestAs(path, reqToSave)
              activeTab.document.request = reqToSave
              activeTab.document.isDirty = false
              activeTab.document.saveContext = {
                originLocation: "user-collection",
                folderPath: path,
                requestIndex: insertionIndex,
                exampleID: undefined,
                requestRefID: reqToSave._ref_id,
              }
              activeTab.document.inheritedProperties =
                cascadeParentCollectionForProperties(path, "rest")
            }

            this.activity.record({
              tool: "save_request_to_collection",
              outcome: "changed",
              summary: `Saved request '${reqToSave.name}' to collection ${path}`,
              revision: this.context.revision("rest-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "list_history",
          title: "List execution history",
          description:
            "List recent request history entries for the current mode.",
          inputSchema: listHistoryInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = listHistoryParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const historyState = restHistoryStore.value.state
            const slice = historyState.slice(
              parsed.data.offset,
              parsed.data.offset + parsed.data.limit
            )
            const redactor = this.redactor()
            const entries = slice.map((entry, i) => ({
              index: parsed.data.offset + i,
              name: redactor.scrub(entry.request.name || "Untitled", 64),
              method: entry.request.method,
              endpoint: redactor.scrub(entry.request.endpoint, 128),
              statusCode: entry.responseMeta?.statusCode ?? null,
              duration: entry.responseMeta?.duration ?? null,
              star: entry.star,
              updatedOn: entry.updatedOn ? entry.updatedOn.toISOString() : null,
            }))
            return this.result("rest-document", {
              total: historyState.length,
              offset: parsed.data.offset,
              limit: parsed.data.limit,
              entries,
            })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "load_history_entry",
          title: "Load history entry into tab",
          description:
            "Load a request from execution history into an active or new tab.",
          inputSchema: loadHistoryEntryInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = loadHistoryEntryParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The editor state changed; inspect it again.",
                "rest-document",
                true
              )
            }
            const historyEntry = restHistoryStore.value.state[parsed.data.index]
            if (!historyEntry) {
              return this.failure(
                "INVALID_INPUT",
                `History entry at index ${parsed.data.index} not found.`,
                "rest-document"
              )
            }
            const reqToLoad = cloneDeep(historyEntry.request)
            if (parsed.data.targetTab === "new") {
              this.restTabs.createNewTab(
                {
                  type: "request",
                  request: reqToLoad,
                  isDirty: false,
                  optionTabPreference: "params",
                },
                true
              )
            } else {
              const rest = this.visibleREST()
              if ("ok" in rest) return rest
              if (rest.tab.document.isDirty) {
                return this.failure(
                  "DIRTY_TAB_UNSAVED_CHANGES",
                  "The active tab has unsaved changes. Save it or choose targetTab: 'new'.",
                  "rest-document"
                )
              }
              rest.tab.document.request = reqToLoad
              rest.tab.document.isDirty = false
              rest.tab.document.saveContext = undefined
              rest.tab.document.inheritedProperties = undefined
            }
            this.activity.record({
              tool: "load_history_entry",
              outcome: "changed",
              summary: `Loaded history entry ${parsed.data.index}`,
              revision: this.context.revision("rest-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "run_collection",
          title: "Run REST collection",
          description:
            "Run all requests in a REST collection or folder subtree as an automated test run with approval and cancellation support.",
          inputSchema: runCollectionInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal }) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = runCollectionParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              ) &&
              !this.context.matches("app-context", parsed.data.expectedRevision)
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }

            let collection: HoppCollection | undefined
            if (parsed.data.collectionPath) {
              collection =
                navigateToFolderWithIndexPath(
                  restCollectionStore.value.state,
                  parsed.data.collectionPath
                    .split("/")
                    .map((x) => parseInt(x, 10))
                ) ?? undefined
            } else if (parsed.data.collectionID) {
              collection =
                (await getRESTCollectionByRefId(parsed.data.collectionID)) ??
                undefined
            } else {
              collection = restCollectionStore.value.state[0]
            }

            if (!collection) {
              return this.failure(
                "INVALID_INPUT",
                "Collection not found.",
                "rest-document"
              )
            }

            const totalReqs = countCollectionRequests(collection)
            if (totalReqs === 0) {
              return this.failure(
                "INVALID_INPUT",
                "The collection contains no requests to run.",
                "rest-document"
              )
            }

            const envName = this.context.capture().environment.name
            const workspaceType = this.context.capture().workspace.type

            const approved = await this.approval.request(
              {
                action: "Run REST collection",
                method: "POST",
                target: `${collection.name} (${totalReqs} requests)`,
                environment: envName,
                workspace: workspaceType,
                grantKey: `run-collection|${collection.name}|${envName}|${workspaceType}`,
              },
              signal
            )

            if (!approved) {
              this.activity.record({
                tool: "run_collection",
                outcome: "denied",
                summary: `Denied running collection '${collection.name}'`,
                revision: this.context.revision("rest-document"),
              })
              return this.failure(
                "APPROVAL_DENIED",
                "The user rejected running the collection.",
                "rest-document"
              )
            }

            const stopRef = ref(false)
            const abortHandler = () => {
              stopRef.value = true
            }
            if (signal.aborted) {
              stopRef.value = true
            } else {
              signal.addEventListener("abort", abortHandler, {
                once: true,
              })
            }

            const runnerDoc: HoppTestRunnerDocument = {
              type: "test-runner",
              collectionType: "my-collections",
              collectionID: collection._ref_id || collection.id || "",
              collection: cloneDeep(collection),
              isDirty: false,
              config: {
                iterations: 1,
                delay: parsed.data.delay,
                stopOnError: parsed.data.stopOnError,
                persistResponses: parsed.data.persistResponses,
                keepVariableValues: parsed.data.keepVariableValues,
              },
              status: "idle",
              request: null,
              testRunnerMeta: {
                completedRequests: 0,
                totalRequests: totalReqs,
                totalTime: 0,
                failedTests: 0,
                passedTests: 0,
                totalTests: 0,
              },
            }

            const runnerTabRef = ref<HoppTab<HoppTestRunnerDocument>>({
              id: "webmcp-runner-tab",
              document: runnerDoc,
            })

            try {
              await this.testRunner.runTests(runnerTabRef, collection, {
                ...runnerDoc.config,
                stopRef,
              })
            } catch (err) {
              if (
                !(
                  err instanceof Error &&
                  err.message === "Test execution stopped"
                )
              ) {
                console.error("Collection runner error:", err)
              }
            } finally {
              signal.removeEventListener("abort", abortHandler)
            }

            const redactor = this.redactor()
            const results = extractRunnerResults(
              runnerTabRef.value.document.resultCollection ?? collection,
              redactor
            )

            const meta = runnerTabRef.value.document.testRunnerMeta
            const outcomeStatus = stopRef.value
              ? "stopped"
              : runnerTabRef.value.document.status

            this.activity.record({
              tool: "run_collection",
              outcome: "executed",
              summary: `Ran collection '${collection.name}': ${meta.completedRequests}/${totalReqs} completed (${meta.passedTests} passed, ${meta.failedTests} failed)`,
              revision: this.context.revision("rest-document"),
            })

            return this.result("rest-document", {
              summary: {
                status: outcomeStatus,
                collectionName: redactor.scrub(collection.name, 64),
                metrics: {
                  totalRequests: totalReqs,
                  completedRequests: meta.completedRequests,
                  passedTests: meta.passedTests,
                  failedTests: meta.failedTests,
                  totalTime: meta.totalTime,
                },
                results,
              },
            })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "inspect_collection_runner",
          title: "Inspect collection runner state",
          description: "Inspect the current test runner status and metrics.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input) || Object.keys(input).length !== 0) {
              return this.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            }
            const runnerTab = this.restTabs
              .getTabs()
              .find((t) => t.document.type === "test-runner") as
              | HoppTab<HoppTestRunnerDocument>
              | undefined

            if (!runnerTab) {
              return this.result("rest-document", {
                active: false,
                message: "No test runner tab is currently open.",
              })
            }

            const redactor = this.redactor()
            return this.result("rest-document", {
              active: true,
              status: runnerTab.document.status,
              collectionName: redactor.scrub(
                runnerTab.document.collection.name,
                64
              ),
              metrics: runnerTab.document.testRunnerMeta,
              config: runnerTab.document.config,
            })
          },
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
    const variablesDiagnostics = [] as Array<Record<string, unknown>>
    try {
      if (document.request.variables.trim())
        JSON.parse(document.request.variables)
    } catch (error) {
      variablesDiagnostics.push({
        ...diagnosticForError(error, redactor, {
          code: "MALFORMED_GRAPHQL_VARIABLES",
          phase: "payload",
          location: "variables",
        }),
        severity: "warning",
      })
    }
    const queryDiagnostics =
      document.request.query.trim() && !/[{}]/.test(document.request.query)
        ? [
            {
              code: "MALFORMED_GRAPHQL_QUERY",
              severity: "warning",
              phase: "validation",
              message: "The GraphQL document appears incomplete.",
              location: "query",
              untrustedContent: true,
            },
          ]
        : []
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
        diagnostics: {
          query: queryDiagnostics,
          variables: variablesDiagnostics,
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
            "Apply a bounded revision-bound patch to the visible GraphQL name, endpoint, document, variables, or headers without saving it.",
          inputSchema: editGraphQLOperationInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => this.editGraphQLOperation(input),
        },
        signal
      ),
      this.adapter.register(
        {
          name: "edit_graphql_variables",
          title: "Edit structured GraphQL variables",
          description:
            "Apply revision-bound whole-document or JSON Pointer edits to GraphQL variables without changing the legacy raw editor.",
          inputSchema: editGraphQLVariablesInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => this.editGraphQLVariables(input),
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
      this.adapter.register(
        {
          name: "list_gql_tabs",
          title: "List open GraphQL tabs",
          description:
            "List all open GraphQL editor tabs with their IDs, titles, dirty states, and active selection.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input) || Object.keys(input).length !== 0) {
              return this.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            }
            const redactor = this.redactor()
            const tabs = this.gqlTabs.getTabs().map((tab) => ({
              id: tab.id,
              title: redactor.scrub(
                tab.document.request.name || "Untitled",
                64
              ),
              isDirty: tab.document.isDirty,
              isActive: tab.id === this.gqlTabs.currentTabID.value,
              saveContext: tab.document.saveContext
                ? {
                    originLocation: tab.document.saveContext.originLocation,
                    folderPath:
                      tab.document.saveContext.originLocation ===
                      "user-collection"
                        ? tab.document.saveContext.folderPath
                        : undefined,
                  }
                : undefined,
            }))
            return this.result("graphql-document", { tabs })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "switch_gql_tab",
          title: "Switch active GraphQL tab",
          description: "Switch to a specific open GraphQL tab by tab ID.",
          inputSchema: switchTabInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = switchTabParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "graphql-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "graphql-document",
                true
              )
            }
            const tab = this.gqlTabs
              .getTabs()
              .find((t) => t.id === parsed.data.tabID)
            if (!tab) {
              return this.failure(
                "INVALID_INPUT",
                "The requested tab was not found.",
                "graphql-document"
              )
            }
            this.gqlTabs.setActiveTab(parsed.data.tabID)
            this.activity.record({
              tool: "switch_gql_tab",
              outcome: "changed",
              summary: `Switched active GraphQL tab to ${parsed.data.tabID}`,
              revision: this.context.revision("graphql-document"),
            })
            return this.gqlObservation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "create_gql_tab",
          title: "Create new GraphQL tab",
          description:
            "Open a new blank GraphQL request tab in the editor and set it as active.",
          inputSchema: createTabInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = createTabParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "graphql-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "graphql-document",
                true
              )
            }
            const req = getDefaultGQLRequest()
            if (parsed.data.name) req.name = parsed.data.name
            const newTab = this.gqlTabs.createNewTab(
              {
                type: "graphql",
                request: req,
                isDirty: false,
                response: null,
                optionTabPreference: "query",
              } as any,
              true
            )
            this.activity.record({
              tool: "create_gql_tab",
              outcome: "changed",
              summary: `Created new GraphQL tab ${newTab.id}`,
              revision: this.context.revision("graphql-document"),
            })
            return this.gqlObservation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "close_gql_tab",
          title: "Close GraphQL tab",
          description:
            "Close an open GraphQL tab by ID. If the tab has unsaved changes, force must be set to true.",
          inputSchema: closeTabInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = closeTabParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "graphql-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "graphql-document",
                true
              )
            }
            const tab = this.gqlTabs
              .getTabs()
              .find((t) => t.id === parsed.data.tabID)
            if (!tab) {
              return this.failure(
                "INVALID_INPUT",
                "The requested tab was not found.",
                "graphql-document"
              )
            }
            if (this.gqlTabs.getTabs().length <= 1) {
              return this.failure(
                "INVALID_INPUT",
                "Cannot close the only open tab.",
                "graphql-document"
              )
            }
            if (tab.document.isDirty && !parsed.data.force) {
              return this.failure(
                "DIRTY_TAB_UNSAVED_CHANGES",
                "The tab has unsaved changes. Save it to a collection or pass force: true to discard changes.",
                "graphql-document"
              )
            }
            this.gqlTabs.closeTab(parsed.data.tabID)
            this.activity.record({
              tool: "close_gql_tab",
              outcome: "changed",
              summary: `Closed GraphQL tab ${parsed.data.tabID}`,
              revision: this.context.revision("graphql-document"),
            })
            return this.gqlObservation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "list_gql_collections",
          title: "List GraphQL collections",
          description:
            "List top-level GraphQL collections with folder counts, request counts, and paths.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input) || Object.keys(input).length !== 0) {
              return this.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            }
            const redactor = this.redactor()
            const collections = graphqlCollectionStore.value.state.map(
              (col, index) => ({
                id: col.id,
                name: redactor.scrub(col.name, 64),
                path: String(index),
                foldersCount: col.folders.length,
                requestsCount: col.requests.length,
              })
            )
            return this.result("graphql-document", { collections })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "inspect_gql_collection",
          title: "Inspect GraphQL collection or folder",
          description:
            "Inspect the structure of a specific GraphQL collection or folder by path.",
          inputSchema: inspectCollectionInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = inspectCollectionParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const target = navigateToFolderWithIndexPath(
              graphqlCollectionStore.value.state,
              parsed.data.path.split("/").map((x) => parseInt(x, 10))
            )
            if (!target) {
              return this.failure(
                "INVALID_INPUT",
                "The requested collection or folder path was not found.",
                "graphql-document"
              )
            }
            const redactor = this.redactor()
            return this.result("graphql-document", {
              collection: {
                name: redactor.scrub(target.name, 64),
                path: parsed.data.path,
                authType: target.auth?.authType ?? "inherit",
                headersCount: target.headers?.length ?? 0,
                variablesCount: target.variables?.length ?? 0,
                folders: target.folders.map((f, i) => ({
                  name: redactor.scrub(f.name, 64),
                  path: `${parsed.data.path}/${i}`,
                  foldersCount: f.folders.length,
                  requestsCount: f.requests.length,
                })),
                requests: target.requests.map((r, i) => ({
                  name: redactor.scrub(r.name, 64),
                  index: i,
                })),
              },
            })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "save_gql_request_to_collection",
          title: "Save GraphQL request to collection",
          description:
            "Save the visible GraphQL request draft into a collection/folder or update it in place.",
          inputSchema: saveRequestToCollectionInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = saveRequestToCollectionParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const gql = this.visibleGQL()
            if ("ok" in gql) return gql
            if (
              !this.context.matches(
                "graphql-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The request draft changed; inspect it again.",
                "graphql-document",
                true
              )
            }
            const activeTab = gql.tab
            const currentDoc = activeTab.document
            const reqToSave = cloneDeep(currentDoc.request)
            if (parsed.data.name) reqToSave.name = parsed.data.name

            let path = parsed.data.collectionPath
            if (
              !path &&
              currentDoc.saveContext?.originLocation === "user-collection"
            ) {
              path = currentDoc.saveContext.folderPath
            }
            if (!path) {
              path = "0"
            }

            const target = navigateToFolderWithIndexPath(
              graphqlCollectionStore.value.state,
              path.split("/").map((x) => parseInt(x, 10))
            )
            if (!target) {
              return this.failure(
                "INVALID_INPUT",
                `Collection path ${path} not found.`,
                "graphql-document"
              )
            }

            if (
              !parsed.data.collectionPath &&
              currentDoc.saveContext?.originLocation === "user-collection" &&
              currentDoc.saveContext.requestIndex !== undefined
            ) {
              editGraphqlRequest(
                path,
                currentDoc.saveContext.requestIndex,
                reqToSave
              )
              activeTab.document.isDirty = false
              activeTab.document.request = reqToSave
            } else {
              const insertionIndex = saveGraphqlRequestAs(path, reqToSave)
              activeTab.document.request = reqToSave
              activeTab.document.isDirty = false
              activeTab.document.saveContext = {
                originLocation: "user-collection",
                folderPath: path,
                requestIndex: insertionIndex,
                requestRefID: reqToSave._ref_id,
              }
              activeTab.document.inheritedProperties =
                cascadeParentCollectionForProperties(path, "graphql")
            }

            this.activity.record({
              tool: "save_gql_request_to_collection",
              outcome: "changed",
              summary: `Saved GraphQL request '${reqToSave.name}' to collection ${path}`,
              revision: this.context.revision("graphql-document"),
            })
            return this.gqlObservation()
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "list_gql_history",
          title: "List GraphQL execution history",
          description: "List recent GraphQL request history entries.",
          inputSchema: listHistoryInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = listHistoryParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const historyState = graphqlHistoryStore.value.state
            const slice = historyState.slice(
              parsed.data.offset,
              parsed.data.offset + parsed.data.limit
            )
            const redactor = this.redactor()
            const entries = slice.map((entry, i) => ({
              index: parsed.data.offset + i,
              name: redactor.scrub(entry.request.name || "Untitled", 64),
              url: redactor.scrub(entry.request.url, 128),
              star: entry.star,
              updatedOn: entry.updatedOn ? entry.updatedOn.toISOString() : null,
            }))
            return this.result("graphql-document", {
              total: historyState.length,
              offset: parsed.data.offset,
              limit: parsed.data.limit,
              entries,
            })
          },
        },
        signal
      ),
      this.adapter.register(
        {
          name: "load_gql_history_entry",
          title: "Load GraphQL history entry into tab",
          description:
            "Load a GraphQL request from execution history into an active or new tab.",
          inputSchema: loadHistoryEntryInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.validBoundary(input)) {
              return this.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = loadHistoryEntryParser.safeParse(input)
            if (!parsed.success) {
              return this.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.context.matches(
                "graphql-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.failure(
                "STATE_CHANGED",
                "The editor state changed; inspect it again.",
                "graphql-document",
                true
              )
            }
            const historyEntry =
              graphqlHistoryStore.value.state[parsed.data.index]
            if (!historyEntry) {
              return this.failure(
                "INVALID_INPUT",
                `GraphQL history entry at index ${parsed.data.index} not found.`,
                "graphql-document"
              )
            }
            const reqToLoad = cloneDeep(historyEntry.request)
            if (parsed.data.targetTab === "new") {
              this.gqlTabs.createNewTab(
                {
                  type: "graphql",
                  request: reqToLoad,
                  isDirty: false,
                  response: null,
                  optionTabPreference: "query",
                } as any,
                true
              )
            } else {
              const gql = this.visibleGQL()
              if ("ok" in gql) return gql
              if (gql.tab.document.isDirty) {
                return this.failure(
                  "DIRTY_TAB_UNSAVED_CHANGES",
                  "The active tab has unsaved changes. Save it or choose targetTab: 'new'.",
                  "graphql-document"
                )
              }
              gql.tab.document.request = reqToLoad
              gql.tab.document.isDirty = false
              gql.tab.document.saveContext = undefined
              gql.tab.document.inheritedProperties = undefined
            }
            this.activity.record({
              tool: "load_gql_history_entry",
              outcome: "changed",
              summary: `Loaded GraphQL history entry ${parsed.data.index}`,
              revision: this.context.revision("graphql-document"),
            })
            return this.gqlObservation()
          },
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
    if (parsed.data.patch.name !== undefined)
      candidate.name = parsed.data.patch.name
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
    const changedFields = Object.keys(parsed.data.patch)
    return this.result("graphql-document", {
      updated: true,
      changedFields,
      draft: {
        dirty: gql.tab.document.isDirty,
        provenance: gql.tab.document.saveContext?.originLocation ?? "unsaved",
      },
    })
  }

  private async editGraphQLVariables(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = editGraphQLVariablesParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.visibleGQL()
    if ("ok" in gql) return gql
    if (!this.context.matches("graphql-document", parsed.data.expectedRevision))
      return this.failure(
        "STATE_CHANGED",
        "The GraphQL draft changed; inspect it again.",
        "graphql-document",
        true
      )
    try {
      const original = cloneDeep(gql.tab.document.request)
      const originalDirty = gql.tab.document.isDirty
      const document =
        parsed.data.operation.kind === "replace_document"
          ? parsed.data.operation.document
          : applyJSONPointerOperations(
              JSON.parse(original.variables || "{}"),
              parsed.data.operation.operations
            )
      const candidate = {
        ...original,
        variables: JSON.stringify(document, null, 2),
      }
      const validated = HoppGQLRequest.safeParse(candidate)
      if (validated.type !== "ok")
        return this.failure(
          "INVALID_INPUT",
          "The variables edit does not produce a valid GraphQL request.",
          "graphql-document"
        )
      gql.tab.document.request = validated.value
      gql.tab.document.isDirty = true
      const revision = this.context.revision("graphql-document")
      const token = gql.token
      this.activity.record(
        {
          tool: "edit_graphql_variables",
          outcome: "changed",
          summary: "Edited structured GraphQL variables",
          revision,
        },
        () => {
          const current = this.context.captureVisibleGQL()
          if (
            !current ||
            current.token !== token ||
            !this.context.matches("graphql-document", revision)
          )
            return false
          current.tab.document.request = original
          current.tab.document.isDirty = originalDirty
          return true
        }
      )
      return this.result("graphql-document", {
        updated: true,
        changedFields: ["variables"],
        draft: {
          dirty: gql.tab.document.isDirty,
          provenance: gql.tab.document.saveContext?.originLocation ?? "unsaved",
        },
      })
    } catch (error) {
      return this.failure(
        "INVALID_INPUT",
        error instanceof Error
          ? error.message
          : "Invalid GraphQL variables edit.",
        "graphql-document"
      )
    }
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
      return this.result("graphql-document", {
        updated: true,
        changedFields: ["auth"],
        draft: {
          dirty: gql.tab.document.isDirty,
          provenance: gql.tab.document.saveContext?.originLocation ?? "unsaved",
        },
      })
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
          grantKey: `graphql|${action}|${
            gql.tab.document.request.url.includes("<<")
              ? parsed.data.expectedRevision
              : safeTarget(gql.tab.document.request.url)
          }|${this.context.capture().environment.name}|${this.context.capture().workspace.type}`,
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
      if (action === "connect") await this.gqlExecution.connect(gql.tab, signal)
      else if (action === "disconnect") this.gqlExecution.disconnect()
      else if (action === "execute")
        await this.gqlExecution.executeConnected(gql.tab, null, signal)
      else if (action === "subscribe")
        this.gqlExecution.startSubscriptionConnected(gql.tab, signal)
      else this.gqlExecution.stopSubscription()
      this.activity.record({
        tool: `${action}_graphql`,
        outcome: action === "execute" ? "executed" : "changed",
        summary: `GraphQL ${action}`,
        revision: this.context.revision("graphql-document"),
      })
      return this.gqlObservation()
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error &&
          error.message.toLowerCase().includes("cancelled"))
      ) {
        return this.failure(
          "CANCELLED",
          "The GraphQL action was cancelled.",
          "graphql-document"
        )
      }
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
    const configurationDiagnostics: Array<Record<string, unknown>> = []
    try {
      new URL(snapshot.endpoint)
    } catch {
      if (snapshot.endpoint.trim()) {
        configurationDiagnostics.push({
          code: "INVALID_REALTIME_ENDPOINT",
          severity: "warning",
          phase: "configuration",
          message: "The realtime endpoint is not a complete URL.",
          location: "endpoint",
          untrustedContent: true,
        })
      }
    }
    const rawConfig = snapshot.configuration
    const safeConfiguration: Record<string, unknown> = { ...rawConfig }
    if (
      mode === "socketio" &&
      rawConfig.auth &&
      typeof rawConfig.auth === "object"
    ) {
      const auth = rawConfig.auth as Record<string, unknown>
      const token = typeof auth.bearerToken === "string" ? auth.bearerToken : ""
      safeConfiguration.auth = {
        authType: auth.authType ?? "None",
        authActive: auth.authActive ?? true,
        bearerToken:
          token.startsWith("<<") && token.endsWith(">>")
            ? redactor.scrub(token, 128)
            : token.trim()
              ? "[REDACTED]"
              : "",
      }
    } else if (mode === "mqtt") {
      if (typeof rawConfig.username === "string") {
        safeConfiguration.username = redactor.scrub(rawConfig.username, 128)
      }
      if (typeof rawConfig.password === "string") {
        const pass = rawConfig.password
        safeConfiguration.password =
          pass.startsWith("<<") && pass.endsWith(">>")
            ? redactor.scrub(pass, 128)
            : pass.trim()
              ? "[REDACTED]"
              : ""
      }
    }
    return this.result("realtime-session", {
      session: {
        mode,
        endpoint: redactor.scrub(snapshot.endpoint, 128),
        state: snapshot.state,
        configuration: safeConfiguration,
        diagnostics: configurationDiagnostics,
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
    return this.result("realtime-session", {
      updated: true,
      changedFields: fields,
    })
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
          grantKey: `realtime|${mode}|${action}|${
            snapshot.endpoint.includes("<<")
              ? parsed.data.expectedRevision
              : safeTarget(snapshot.endpoint)
          }|${this.context.capture().environment.name}|${this.context.capture().workspace.type}`,
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
      const format = "format" in parsed.data ? parsed.data.format : "text"
      const message = "message" in parsed.data ? parsed.data.message : undefined
      const actionDiagnostics: Array<Record<string, unknown>> = []
      if (format === "json" && typeof message === "string") {
        try {
          JSON.parse(message)
        } catch (error) {
          actionDiagnostics.push({
            ...diagnosticForError(error, this.redactor(), {
              code: "MALFORMED_JSON_MESSAGE",
              phase: "payload",
              location: "message",
            }),
            severity: "warning",
          })
        }
      }
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
      const observation = await this.realtimeObservation(mode)
      return observation.ok
        ? { ...observation, actionDiagnostics }
        : observation
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

  private async createEnvironment(
    input: Record<string, unknown>,
    executionSignal?: AbortSignal
  ) {
    if (!this.validBoundary(input)) {
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    }
    const parsed = createEnvironmentParser.safeParse(input)
    if (!parsed.success) {
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.context.matches("app-context", parsed.data.expectedRevision) &&
      !this.context.matches("rest-document", parsed.data.expectedRevision)
    ) {
      return this.failure(
        "STATE_CHANGED",
        "The application context changed; inspect it again.",
        "app-context",
        true
      )
    }

    const hasSecrets = parsed.data.variables.some((v) => v.secret)
    const isTeam = parsed.data.scope === "team"
    const currentEnvName = this.context.capture().environment.name
    const workspaceType = this.context.capture().workspace.type

    if (isTeam || hasSecrets) {
      const approved = await this.approval.request(
        {
          action: isTeam
            ? "CREATE team environment"
            : "CREATE personal environment with secrets",
          method: "CREATE",
          target: parsed.data.name,
          environment: currentEnvName,
          workspace: workspaceType,
          grantKey: `create-environment|${parsed.data.name}|${parsed.data.scope}|${workspaceType}`,
          description: hasSecrets
            ? `Create environment '${parsed.data.name}' containing secret variable(s)`
            : `Create team environment '${parsed.data.name}' in team workspace`,
        },
        executionSignal ?? new AbortController().signal
      )

      if (!approved) {
        this.activity.record({
          tool: "create_environment",
          outcome: "denied",
          summary: `Denied creating environment '${parsed.data.name}'`,
          revision: this.context.revision("app-context"),
        })
        return this.failure(
          "APPROVAL_DENIED",
          "The user rejected creating the environment.",
          "app-context"
        )
      }
    }

    let created: {
      id: string
      name: string
      handle: string
      variableCount: number
      secretVariableCount: number
    }

    if (parsed.data.scope === "personal") {
      created = this.environments.createPersonal(
        parsed.data.name,
        parsed.data.variables
      )
    } else {
      const res = await this.environments.createTeam(
        parsed.data.name,
        parsed.data.variables
      )
      if ("error" in res) {
        if (res.error === "PERMISSION_DENIED") {
          return this.failure(
            "PERMISSION_DENIED",
            "You do not have permission to create team environments.",
            "app-context"
          )
        }
        return this.failure(
          "INVALID_INPUT",
          `Failed to create team environment: ${res.error}`,
          "app-context"
        )
      }
      created = res
    }

    const resultingRevision = this.context.revision("app-context")
    this.activity.record({
      tool: "create_environment",
      outcome: "changed",
      summary: `Created ${parsed.data.scope} environment '${created.name}' with ${created.variableCount} variables`,
      revision: resultingRevision,
    })

    return this.result("app-context", {
      environmentHandle: created.handle,
      name: this.redactor().scrub(created.name, 64),
      scope: parsed.data.scope,
      variableCount: created.variableCount,
      secretVariableCount: created.secretVariableCount,
      valuesOmitted: true,
    })
  }

  private async editEnvironmentVariables(
    input: Record<string, unknown>,
    executionSignal?: AbortSignal
  ) {
    if (!this.validBoundary(input)) {
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    }
    const parsed = editEnvironmentVariablesParser.safeParse(input)
    if (!parsed.success) {
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.context.matches("app-context", parsed.data.expectedRevision) &&
      !this.context.matches("rest-document", parsed.data.expectedRevision)
    ) {
      return this.failure(
        "STATE_CHANGED",
        "The application context changed; inspect it again.",
        "app-context",
        true
      )
    }

    const choice = await this.environments.resolveHandle(
      parsed.data.environmentHandle
    )
    if (!choice || !choice.environment) {
      return this.failure(
        "ENVIRONMENT_NOT_FOUND",
        "The environment handle is no longer available; list environments again.",
        "app-context",
        true
      )
    }

    if (!choice.editable) {
      return this.failure(
        "PERMISSION_DENIED",
        "You do not have permission to edit this environment.",
        "app-context"
      )
    }

    const hasSecretOps = parsed.data.operations.some(
      (op) =>
        (op.op === "add" && op.secret) ||
        (op.op === "update" && op.secret) ||
        (op.op === "update" &&
          choice.environment?.variables.find((v) => v.key === op.key)?.secret)
    )
    const isTeam = choice.scope === "team"
    const currentEnvName = this.context.capture().environment.name
    const workspaceType = this.context.capture().workspace.type

    if (isTeam || hasSecretOps) {
      const keysAffected = parsed.data.operations.map((o) => o.key).join(", ")
      const approved = await this.approval.request(
        {
          action: isTeam
            ? "EDIT team environment variables"
            : "EDIT environment secrets",
          method: "UPDATE",
          target: `${choice.environment.name} (${keysAffected})`,
          environment: currentEnvName,
          workspace: workspaceType,
          grantKey: `edit-env-vars|${choice.environment.id}|${keysAffected}|${workspaceType}`,
          description: isTeam
            ? `Modify variables in team environment '${choice.environment.name}'`
            : `Modify secret variable(s) in environment '${choice.environment.name}'`,
        },
        executionSignal ?? new AbortController().signal
      )

      if (!approved) {
        this.activity.record({
          tool: "edit_environment_variables",
          outcome: "denied",
          summary: `Denied editing variables in environment '${choice.environment.name}'`,
          revision: this.context.revision("app-context"),
        })
        return this.failure(
          "APPROVAL_DENIED",
          "The user rejected editing the environment variables.",
          "app-context"
        )
      }
    }

    const res = await this.environments.mutateVariables(
      parsed.data.environmentHandle,
      parsed.data.operations
    )

    if (!res.ok) {
      if (res.code === "PERMISSION_DENIED") {
        return this.failure("PERMISSION_DENIED", res.error, "app-context")
      }
      return this.failure("INVALID_INPUT", res.error, "app-context")
    }

    const resultingRevision = this.context.revision("app-context")
    const envName = this.redactor().scrub(res.environmentName, 64)
    this.activity.record(
      {
        tool: "edit_environment_variables",
        outcome: "changed",
        summary: `Updated variables [${res.updatedKeys.join(", ")}] in environment '${envName}'`,
        revision: resultingRevision,
      },
      () => {
        const undoResult = res.undo()
        return typeof undoResult === "boolean" ? undoResult : true
      }
    )

    return this.result("app-context", {
      environmentHandle: parsed.data.environmentHandle,
      environmentName: envName,
      updatedKeys: res.updatedKeys.map((k) => this.redactor().scrub(k, 64)),
      variableCount: res.variableCount,
      secretVariableCount: res.secretVariableCount,
      valuesOmitted: true,
    })
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
    if (patch.name !== undefined) candidate.name = patch.name
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

    return this.result("rest-document", {
      updated: true,
      changedFields,
      draft: {
        dirty: rest.tab.document.isDirty,
        provenance: rest.tab.document.saveContext?.originLocation ?? "unsaved",
      },
    })
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

  private scriptSources(rest: VisibleRESTContext) {
    const own = [
      {
        handle: "request:pre",
        origin: "request",
        phase: "pre_request",
        source: rest.tab.document.request.preRequestScript,
      },
      {
        handle: "request:post",
        origin: "request",
        phase: "post_request",
        source: rest.tab.document.request.testScript,
      },
    ]
    const inherited = (
      rest.tab.document.inheritedProperties?.scripts ?? []
    ).flatMap((script, index) => [
      {
        handle: `inherited:${index}:pre`,
        origin: "inherited",
        phase: "pre_request",
        source: script.preRequestScript ?? "",
      },
      {
        handle: `inherited:${index}:post`,
        origin: "inherited",
        phase: "post_request",
        source: script.testScript ?? "",
      },
    ])
    return [...inherited, ...own]
  }

  private scriptDiagnostics(source: string, sourceHandle: string) {
    const result: Array<Record<string, unknown>> = []
    const typeScript =
      /(^|[;\n]\s*)(interface|type|enum)\s+|\sas\s+[A-Z_$]|:\s*(string|number|boolean|unknown|any)\b/.exec(
        source
      )
    if (typeScript)
      result.push({
        code: "TYPESCRIPT_UNSUPPORTED",
        severity: "error",
        phase: "script",
        message:
          "TypeScript syntax is not supported; scripts execute as JavaScript.",
        range: {
          start: typeScript.index,
          end: typeScript.index + typeScript[0].length,
        },
        sourceHandle,
        untrustedContent: true,
      })
    const imported = /\b(import|export)\b/.exec(source)
    if (imported)
      result.push({
        code: "MODULE_SYNTAX_UNSUPPORTED",
        severity: "error",
        phase: "script",
        message:
          "ES module imports and exports are not supported by the request sandbox.",
        range: {
          start: imported.index,
          end: imported.index + imported[0].length,
        },
        sourceHandle,
        untrustedContent: true,
      })
    const reserved =
      /\b(?:const|let|var|function|class)\s+(hopp|pw|request|response)\b/.exec(
        source
      )
    if (reserved)
      result.push({
        code: "RESERVED_BINDING",
        severity: "error",
        phase: "script",
        message: "This binding is reserved by the request scripting sandbox.",
        range: {
          start: reserved.index,
          end: reserved.index + reserved[0].length,
        },
        sourceHandle,
        untrustedContent: true,
      })
    if (!typeScript && !imported) {
      try {
        new Function(source)
      } catch (error) {
        result.push({
          ...diagnosticForError(error, this.redactor(), {
            code: "JAVASCRIPT_SYNTAX",
            phase: "script",
            sourceHandle,
          }),
          range: undefined,
        })
      }
    }
    return result
  }

  private async getSkill(input: Record<string, unknown>) {
    if (!this.validBoundary(input)) {
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    }
    const parsed = getSkillParser.safeParse(input)
    if (!parsed.success) {
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }

    if (!parsed.data.name || parsed.data.name.toLowerCase() === "list") {
      return this.result("app-context", {
        skills: listSkills(),
      })
    }

    const skill = findSkill(parsed.data.name)
    if (!skill) {
      const available = listSkills()
        .map((s) => `'${s.name}'`)
        .join(", ")
      return this.failure(
        "INVALID_INPUT",
        `Skill '${parsed.data.name}' not found. Available skills: ${available}.`,
        "app-context"
      )
    }

    return this.result("app-context", {
      skill,
    })
  }

  private async inspectRESTScripting() {
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    const sources = this.scriptSources(rest)
    return this.result("rest-document", {
      executionMode: "javascript",
      scripts: sources.map(({ handle, origin, phase, source }) => ({
        sourceHandle: handle,
        origin,
        phase,
        length: source.length,
        // Handle rather than source text keeps script disclosure approval-gated.
        digest: `${source.length}:${[...source].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0).toString(16)}`,
        diagnostics: this.scriptDiagnostics(source, handle),
      })),
    })
  }

  private async readRESTScript(
    input: Record<string, unknown>,
    signal: AbortSignal
  ) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = readRESTScriptParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    if (!this.context.matches("rest-document", parsed.data.expectedRevision))
      return this.failure(
        "STATE_CHANGED",
        "The REST draft changed; inspect it again.",
        "rest-document",
        true
      )
    const source = this.scriptSources(rest).find(
      ({ handle }) => handle === parsed.data.sourceHandle
    )
    if (!source)
      return this.failure(
        "INVALID_INPUT",
        "The script source handle is no longer available.",
        "rest-document"
      )
    // The nonce deliberately makes a session decision unusable for later disclosures.
    const approved = await this.approval.request(
      {
        action: "Allow script source read",
        method: "READ",
        target: source.handle,
        environment: this.context.capture().environment.name,
        workspace: this.context.capture().workspace.type,
        grantKey: `script-read:${crypto.randomUUID()}`,
        description:
          "An agent wants to read a bounded window of request script source. Script content can contain sensitive data.",
        allowSession: false,
      },
      signal
    )
    if (!approved) {
      this.activity.record({
        tool: "read_rest_script",
        outcome: signal.aborted ? "cancelled" : "denied",
        summary: `Script disclosure ${source.handle}`,
        revision: this.context.revision("rest-document"),
      })
      return this.failure(
        signal.aborted ? "CANCELLED" : "APPROVAL_DENIED",
        signal.aborted
          ? "The script disclosure was cancelled."
          : "The user denied script disclosure.",
        "rest-document"
      )
    }
    if (!this.context.matches("rest-document", parsed.data.expectedRevision))
      return this.failure(
        "STATE_CHANGED",
        "The REST draft changed while approval was open.",
        "rest-document",
        true
      )
    const text = this.redactor().scrub(
      source.source,
      parsed.data.offset + parsed.data.maxChars
    )
    this.activity.record({
      tool: "read_rest_script",
      outcome: "executed",
      summary: `Disclosed script window ${source.handle}`,
      revision: this.context.revision("rest-document"),
    })
    return this.result("rest-document", {
      sourceHandle: source.handle,
      offset: parsed.data.offset,
      text: text.slice(
        parsed.data.offset,
        parsed.data.offset + parsed.data.maxChars
      ),
      totalChars: text.length,
      truncated: parsed.data.offset + parsed.data.maxChars < text.length,
    })
  }

  private async editRESTBody(input: Record<string, unknown>) {
    if (!this.validBoundary(input))
      return this.failure("INVALID_INPUT", "The input is not safe JSON data.")
    const parsed = editRESTBodyParser.safeParse(input)
    if (!parsed.success)
      return this.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.visibleREST()
    if ("ok" in rest) return rest
    if (!this.context.matches("rest-document", parsed.data.expectedRevision))
      return this.failure(
        "STATE_CHANGED",
        "The REST draft changed; inspect it again.",
        "rest-document",
        true
      )
    try {
      const body = cloneDeep(rest.tab.document.request.body)
      const operation = parsed.data.operation
      if (body.contentType === "application/octet-stream")
        throw new Error("Binary request bodies are read-only.")
      if (operation.kind === "set_urlencoded_entries") {
        if (body.contentType !== "application/x-www-form-urlencoded")
          throw new Error("This operation requires a URL-encoded body.")
        body.body = operation.entries
          .filter(({ active }) => active)
          .map(
            ({ key, value }) =>
              `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
          )
          .join("&")
      } else if (operation.kind === "set_multipart_text_entries") {
        if (body.contentType !== "multipart/form-data")
          throw new Error("This operation requires a multipart body.")
        const files = body.body.filter((part) => part.isFile)
        body.body = [
          ...operation.entries.map(({ key, value, active }) => ({
            key,
            value,
            active,
            isFile: false as const,
          })),
          ...files,
        ]
      } else {
        if (!/json/i.test(body.contentType ?? ""))
          throw new Error("Structured JSON edits require a JSON request body.")
        const document =
          operation.kind === "replace_document"
            ? operation.document
            : applyJSONPointerOperations(
                JSON.parse(String(body.body)),
                operation.operations
              )
        body.body = JSON.stringify(document, null, 2)
      }
      const validated = HoppRESTRequest.safeParse({
        ...cloneDeep(rest.tab.document.request),
        body,
      })
      if (validated.type !== "ok")
        throw new Error("The body edit does not produce a valid REST request.")
      return this.commitRESTDraft(
        rest,
        validated.value,
        "edit_rest_body",
        "Edited structured REST body",
        ["body"]
      )
    } catch (error) {
      return this.failure(
        "INVALID_INPUT",
        error instanceof Error
          ? error.message
          : "Invalid structured body edit.",
        "rest-document"
      )
    }
  }

  private async commitRESTDraft(
    rest: VisibleRESTContext,
    request: HoppRESTRequest,
    tool:
      | "configure_rest_auth"
      | "edit_rest_variables"
      | "edit_rest_scripts"
      | "edit_rest_body",
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
    return this.result("rest-document", {
      updated: true,
      changedFields,
      draft: {
        dirty: rest.tab.document.isDirty,
        provenance: rest.tab.document.saveContext?.originLocation ?? "unsaved",
      },
    })
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
