import { makeCollection } from "@hoppscotch/data"
import { Service } from "dioc"
import { computed, watch } from "vue"
import { Router } from "vue-router"
import {
  restCollectionStore,
  navigateToFolderWithIndexPath,
  removeRESTCollection,
  removeRESTFolder,
  addRESTCollection,
  addRESTFolder,
} from "~/newstore/collections"
import {
  getCurrentEnvironment,
  getSelectedEnvironmentType,
  deleteEnvironment,
  environmentsStore,
} from "~/newstore/environments"
import { RealtimeMode } from "~/services/realtime-session.service"
import { WebMCPRuntime } from "./runtime"
import { AppCapability } from "./capabilities/app"
import { GraphQLCapability } from "./capabilities/graphql"
import { RESTCapability } from "./capabilities/rest"
import { RealtimeCapability } from "./capabilities/realtime"
import { approvalIdentity } from "./approval-scope"
import { runWebMCPExecution } from "./execution-lifecycle"
import {
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
} from "./schemas"

export class WebMCPService extends Service {
  public static readonly ID = "WEBMCP_SERVICE"

  private readonly runtime = this.bind(WebMCPRuntime)

  private appController: AbortController | null = null
  private durableOpsController: AbortController | null = null
  private restController: AbortController | null = null
  private gqlController: AbortController | null = null
  private realtimeController: AbortController | null = null
  private registeredRealtimeMode: RealtimeMode | null = null
  private stopCapabilityWatch: (() => void) | null = null

  public readonly diagnostic = computed(
    () => this.runtime.adapter.diagnostic.value
  )

  public async start(router: Router) {
    this.stop()
    this.runtime.context.attachRouter(router)
    if (!this.runtime.adapter.isAvailable()) {
      if (import.meta.env.DEV) {
        console.info(`[WebMCP] ${this.runtime.adapter.diagnostic.value}`)
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
        this.runtime.restTabs.currentTabID.value,
        this.runtime.restTabs.currentActiveTab.value?.document?.type,
        this.runtime.gqlTabs.currentTabID.value,
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
    this.runtime.approval.clear()
    this.runtime.context.dispose()
  }

  private async syncRESTPack() {
    const available = this.runtime.context.isRESTAvailable()
    if (available && !this.restController) {
      this.restController = new AbortController()
      await new RESTCapability(this.runtime).register(
        this.restController.signal
      )
    } else if (!available && this.restController) {
      this.restController.abort()
      this.restController = null
    }
  }

  private async syncGraphQLPack() {
    const available = this.runtime.context.isGQLAvailable()
    if (available && !this.gqlController) {
      this.gqlController = new AbortController()
      await new GraphQLCapability(this.runtime).register(
        this.gqlController.signal
      )
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
    const mode = this.runtime.context.realtimeMode()
    if (mode === this.registeredRealtimeMode) return
    this.realtimeController?.abort()
    this.realtimeController = null
    this.registeredRealtimeMode = null
    if (!mode) return
    this.realtimeController = new AbortController()
    this.registeredRealtimeMode = mode
    await new RealtimeCapability(this.runtime).register(
      mode,
      this.realtimeController.signal
    )
  }

  private async registerAppPack(signal: AbortSignal) {
    await new AppCapability(this.runtime).register(signal)
  }
  private async registerDurableOpsPack(signal: AbortSignal) {
    await Promise.all([
      this.runtime.adapter.register(
        {
          name: "delete_collection",
          title: "Delete collection",
          description:
            "Permanently delete a collection from user storage. Requires exact collection confirmation name.",
          inputSchema: deleteCollectionInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = deleteCollectionParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.runtime.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.runtime.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }

            if (!/^\d+$/.test(parsed.data.collectionPath)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "Collection path must be a top-level collection index (e.g. '0'). For subfolders, use delete_folder.",
                "app-context"
              )
            }

            const pathIndex = parseInt(parsed.data.collectionPath, 10)
            const collection = restCollectionStore.value.state[pathIndex]
            if (!collection) {
              return this.runtime.failure(
                "INVALID_INPUT",
                `Collection at path ${parsed.data.collectionPath} not found.`,
                "app-context"
              )
            }

            if (collection.name !== parsed.data.confirmationName) {
              return this.runtime.failure(
                "INVALID_INPUT",
                `Confirmation name '${parsed.data.confirmationName}' does not match collection name '${collection.name}'.`,
                "app-context"
              )
            }

            const envName = this.runtime.context.capture().environment.name
            const workspaceType = this.runtime.context.capture().workspace.type

            return runWebMCPExecution({
              approval: this.runtime.approval,
              request: {
                action: "DELETE collection",
                method: "DELETE",
                target: collection.name,
                environment: envName,
                workspace: workspaceType,
                grantKey: approvalIdentity({
                  operation: "delete_collection",
                  workspaceID: this.runtime.workspace.currentWorkspace.value,
                  environmentScope: getSelectedEnvironmentType(),
                  revision: this.runtime.context.revision("app-context"),
                  target: collection.name,
                  allowSession: false,
                }),
                allowSession: false,
              },
              signal: executionSignal,
              capture: () => ({
                collection,
                revision: this.runtime.context.revision("app-context"),
              }),
              revalidate: (snapshot) =>
                this.runtime.context.matches(
                  "app-context",
                  snapshot.revision
                ) &&
                restCollectionStore.value.state[pathIndex] ===
                  snapshot.collection &&
                snapshot.collection.name === parsed.data.confirmationName,
              denied: (cancelled) => {
                this.runtime.activity.record({
                  tool: "delete_collection",
                  outcome: cancelled ? "cancelled" : "denied",
                  summary: `Denied deleting collection '${collection.name}'`,
                  revision: this.runtime.context.revision("app-context"),
                })
                return this.runtime.failure(
                  cancelled ? "CANCELLED" : "APPROVAL_DENIED",
                  cancelled
                    ? "The deletion was cancelled."
                    : "The user rejected deleting the collection.",
                  "app-context"
                )
              },
              stale: () =>
                this.runtime.failure(
                  "STATE_CHANGED",
                  "The collection or application context changed while approval was open.",
                  "app-context",
                  true
                ),
              error: (error) =>
                this.runtime.failure(
                  "EXECUTION_FAILED",
                  error instanceof Error
                    ? error.message
                    : "Collection deletion failed",
                  "app-context"
                ),
              execute: (snapshot) => {
                const deletedName = snapshot.collection.name
                removeRESTCollection(
                  pathIndex,
                  snapshot.collection._ref_id || snapshot.collection.id
                )

                this.runtime.activity.record({
                  tool: "delete_collection",
                  outcome: "changed",
                  summary: `Permanently deleted collection '${deletedName}'`,
                  revision: this.runtime.context.revision("app-context"),
                })

                return this.runtime.result("app-context", {
                  success: true,
                  deletedCollection: deletedName,
                })
              },
            })
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "delete_folder",
          title: "Delete collection folder",
          description:
            "Permanently delete a subfolder from a collection. Requires exact folder confirmation name.",
          inputSchema: deleteFolderInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = deleteFolderParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.runtime.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.runtime.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
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
              return this.runtime.failure(
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
              return this.runtime.failure(
                "INVALID_INPUT",
                `Folder at path ${parsed.data.folderPath} not found.`,
                "app-context"
              )
            }

            if (target.name !== parsed.data.confirmationName) {
              return this.runtime.failure(
                "INVALID_INPUT",
                `Confirmation name '${parsed.data.confirmationName}' does not match folder name '${target.name}'.`,
                "app-context"
              )
            }

            const envName = this.runtime.context.capture().environment.name
            const workspaceType = this.runtime.context.capture().workspace.type

            return runWebMCPExecution({
              approval: this.runtime.approval,
              request: {
                action: "DELETE folder",
                method: "DELETE",
                target: target.name,
                environment: envName,
                workspace: workspaceType,
                grantKey: approvalIdentity({
                  operation: "delete_folder",
                  environmentScope: getSelectedEnvironmentType(),
                  workspaceID: this.runtime.workspace.currentWorkspace.value,
                  revision: this.runtime.context.revision("app-context"),
                  target: parsed.data.folderPath,
                  allowSession: false,
                }),
                allowSession: false,
              },
              signal: executionSignal,
              capture: () => ({
                target,
                revision: this.runtime.context.revision("app-context"),
              }),
              revalidate: (snapshot) =>
                this.runtime.context.matches(
                  "app-context",
                  snapshot.revision
                ) &&
                navigateToFolderWithIndexPath(
                  restCollectionStore.value.state,
                  pathSegments
                ) === snapshot.target &&
                snapshot.target.name === parsed.data.confirmationName,
              denied: (cancelled) => {
                this.runtime.activity.record({
                  tool: "delete_folder",
                  outcome: cancelled ? "cancelled" : "denied",
                  summary: `Denied deleting folder '${target.name}'`,
                  revision: this.runtime.context.revision("app-context"),
                })
                return this.runtime.failure(
                  cancelled ? "CANCELLED" : "APPROVAL_DENIED",
                  cancelled
                    ? "The deletion was cancelled."
                    : "The user rejected deleting the folder.",
                  "app-context"
                )
              },
              stale: () =>
                this.runtime.failure(
                  "STATE_CHANGED",
                  "The folder or application context changed while approval was open.",
                  "app-context",
                  true
                ),
              error: (error) =>
                this.runtime.failure(
                  "INVALID_INPUT",
                  error instanceof Error
                    ? error.message
                    : "Folder deletion failed",
                  "app-context"
                ),
              execute: (snapshot) => {
                const deletedName = snapshot.target.name
                removeRESTFolder(parsed.data.folderPath, snapshot.target.id)

                this.runtime.activity.record({
                  tool: "delete_folder",
                  outcome: "changed",
                  summary: `Permanently deleted folder '${deletedName}'`,
                  revision: this.runtime.context.revision("app-context"),
                })

                return this.runtime.result("app-context", {
                  success: true,
                  deletedFolder: deletedName,
                })
              },
            })
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "create_collection",
          title: "Create collection",
          description:
            "Create a new top-level REST collection. Use this when the collection list is empty or when the user asks to create a collection before saving requests.",
          inputSchema: createCollectionInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = createCollectionParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.runtime.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.runtime.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }

            const envName = this.runtime.context.capture().environment.name
            const workspaceType = this.runtime.context.capture().workspace.type

            return runWebMCPExecution({
              approval: this.runtime.approval,
              request: {
                action: "CREATE collection",
                method: "POST",
                target: parsed.data.name,
                environment: envName,
                workspace: workspaceType,
                allowSession: true,
                grantKey: approvalIdentity({
                  operation: "create_collection",
                  environmentScope: getSelectedEnvironmentType(),
                  workspaceID: this.runtime.workspace.currentWorkspace.value,
                  environmentID: getCurrentEnvironment().id,
                  revision: parsed.data.expectedRevision,
                  target: parsed.data.name,
                }),
              },
              signal: executionSignal,
              capture: () => ({
                revision: this.runtime.context.revision("app-context"),
              }),
              revalidate: (snapshot) =>
                this.runtime.context.matches("app-context", snapshot.revision),
              denied: (cancelled) => {
                this.runtime.activity.record({
                  tool: "create_collection",
                  outcome: cancelled ? "cancelled" : "denied",
                  summary: `Denied creating collection '${parsed.data.name}'`,
                  revision: this.runtime.context.revision("app-context"),
                })
                return this.runtime.failure(
                  cancelled ? "CANCELLED" : "APPROVAL_DENIED",
                  cancelled
                    ? "The creation was cancelled."
                    : "The user rejected creating the collection.",
                  "app-context"
                )
              },
              stale: () =>
                this.runtime.failure(
                  "STATE_CHANGED",
                  "The application context changed while approval was open.",
                  "app-context",
                  true
                ),
              error: (error) =>
                this.runtime.failure(
                  "EXECUTION_FAILED",
                  error instanceof Error
                    ? error.message
                    : "Collection creation failed",
                  "app-context"
                ),
              execute: () => {
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

                const activityId = this.runtime.activity.record(
                  {
                    tool: "create_collection",
                    outcome: "changed",
                    summary: `Created collection '${parsed.data.name}' at path ${newIndex}`,
                    revision: this.runtime.context.revision("app-context"),
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

                return this.runtime.result("app-context", {
                  success: true,
                  collectionPath: String(newIndex),
                  name: parsed.data.name,
                })
              },
            })
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "create_folder",
          title: "Create collection folder",
          description:
            "Create a new subfolder inside an existing collection or folder. The new folder's path will be collectionPath/N where N is the appended index.",
          inputSchema: createFolderInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = createFolderParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.runtime.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.runtime.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
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
              return this.runtime.failure(
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
              return this.runtime.failure(
                "INVALID_INPUT",
                `Collection/folder at path ${parsed.data.collectionPath} not found.`,
                "app-context"
              )
            }

            const envName = this.runtime.context.capture().environment.name
            const workspaceType = this.runtime.context.capture().workspace.type

            return runWebMCPExecution({
              approval: this.runtime.approval,
              request: {
                action: "CREATE folder",
                method: "POST",
                target: `${parsed.data.name} inside ${parent.name}`,
                environment: envName,
                workspace: workspaceType,
                allowSession: true,
                grantKey: approvalIdentity({
                  operation: "create_folder",
                  environmentScope: getSelectedEnvironmentType(),
                  workspaceID: this.runtime.workspace.currentWorkspace.value,
                  environmentID: getCurrentEnvironment().id,
                  revision: parsed.data.expectedRevision,
                  target: parsed.data.name,
                  details: { parent: parsed.data.collectionPath },
                }),
              },
              signal: executionSignal,
              capture: () => ({
                parent,
                revision: this.runtime.context.revision("app-context"),
              }),
              revalidate: (snapshot) =>
                this.runtime.context.matches(
                  "app-context",
                  snapshot.revision
                ) &&
                navigateToFolderWithIndexPath(
                  restCollectionStore.value.state,
                  pathSegments
                ) === snapshot.parent,
              denied: (cancelled) => {
                this.runtime.activity.record({
                  tool: "create_folder",
                  outcome: cancelled ? "cancelled" : "denied",
                  summary: `Denied creating folder '${parsed.data.name}' in '${parent.name}'`,
                  revision: this.runtime.context.revision("app-context"),
                })
                return this.runtime.failure(
                  cancelled ? "CANCELLED" : "APPROVAL_DENIED",
                  cancelled
                    ? "The creation was cancelled."
                    : "The user rejected creating the folder.",
                  "app-context"
                )
              },
              stale: () =>
                this.runtime.failure(
                  "STATE_CHANGED",
                  "The folder parent or application context changed while approval was open.",
                  "app-context",
                  true
                ),
              error: (error) =>
                this.runtime.failure(
                  "INVALID_INPUT",
                  error instanceof Error
                    ? error.message
                    : "Folder creation failed",
                  "app-context"
                ),
              execute: () => {
                addRESTFolder(parsed.data.name, parsed.data.collectionPath)

                const updatedParent = navigateToFolderWithIndexPath(
                  restCollectionStore.value.state,
                  pathSegments
                )
                const newFolderIndex = updatedParent
                  ? updatedParent.folders.length - 1
                  : 0
                const newFolderPath = `${parsed.data.collectionPath}/${newFolderIndex}`

                const activityId = this.runtime.activity.record(
                  {
                    tool: "create_folder",
                    outcome: "changed",
                    summary: `Created folder '${parsed.data.name}' at path ${newFolderPath}`,
                    revision: this.runtime.context.revision("app-context"),
                  },
                  () => {
                    removeRESTFolder(newFolderPath)
                    return true
                  }
                )
                void activityId

                return this.runtime.result("app-context", {
                  success: true,
                  folderPath: newFolderPath,
                  name: parsed.data.name,
                })
              },
            })
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "delete_environment",
          title: "Delete environment",
          description:
            "Permanently delete a custom environment definition. Requires exact environment confirmation name.",
          inputSchema: deleteEnvironmentInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = deleteEnvironmentParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.runtime.context.matches(
                "app-context",
                parsed.data.expectedRevision
              ) &&
              !this.runtime.context.matches(
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again.",
                "app-context",
                true
              )
            }

            const envs = environmentsStore.value.environments
            const targetEnv = envs[parsed.data.environmentIndex]
            if (!targetEnv) {
              return this.runtime.failure(
                "INVALID_INPUT",
                `Environment at index ${parsed.data.environmentIndex} not found.`,
                "app-context"
              )
            }

            if (targetEnv.name !== parsed.data.confirmationName) {
              return this.runtime.failure(
                "INVALID_INPUT",
                `Confirmation name '${parsed.data.confirmationName}' does not match environment name '${targetEnv.name}'.`,
                "app-context"
              )
            }

            const currentEnvName =
              this.runtime.context.capture().environment.name
            const workspaceType = this.runtime.context.capture().workspace.type

            return runWebMCPExecution({
              approval: this.runtime.approval,
              request: {
                action: "DELETE environment",
                method: "DELETE",
                target: targetEnv.name,
                environment: currentEnvName,
                workspace: workspaceType,
                grantKey: approvalIdentity({
                  operation: "delete_environment",
                  environmentScope: getSelectedEnvironmentType(),
                  workspaceID: this.runtime.workspace.currentWorkspace.value,
                  environmentID: targetEnv.id,
                  revision: this.runtime.context.revision("app-context"),
                  target: targetEnv.name,
                  allowSession: false,
                }),
                allowSession: false,
              },
              signal: executionSignal,
              capture: () => ({
                targetEnv,
                revision: this.runtime.context.revision("app-context"),
              }),
              revalidate: (snapshot) =>
                this.runtime.context.matches(
                  "app-context",
                  snapshot.revision
                ) &&
                environmentsStore.value.environments[
                  parsed.data.environmentIndex
                ] === snapshot.targetEnv &&
                snapshot.targetEnv.name === parsed.data.confirmationName,
              denied: (cancelled) => {
                this.runtime.activity.record({
                  tool: "delete_environment",
                  outcome: cancelled ? "cancelled" : "denied",
                  summary: `Denied deleting environment '${targetEnv.name}'`,
                  revision: this.runtime.context.revision("app-context"),
                })
                return this.runtime.failure(
                  cancelled ? "CANCELLED" : "APPROVAL_DENIED",
                  cancelled
                    ? "The deletion was cancelled."
                    : "The user rejected deleting the environment.",
                  "app-context"
                )
              },
              stale: () =>
                this.runtime.failure(
                  "STATE_CHANGED",
                  "The environment or application context changed while approval was open.",
                  "app-context",
                  true
                ),
              error: (error) =>
                this.runtime.failure(
                  "INVALID_INPUT",
                  error instanceof Error
                    ? error.message
                    : "Environment deletion failed",
                  "app-context"
                ),
              execute: (snapshot) => {
                const deletedName = snapshot.targetEnv.name
                deleteEnvironment(
                  parsed.data.environmentIndex,
                  snapshot.targetEnv.id
                )
                if (snapshot.targetEnv.id) {
                  this.runtime.currentValues.deleteEnvironment(
                    snapshot.targetEnv.id
                  )
                  this.runtime.secrets.deleteSecretEnvironment(
                    snapshot.targetEnv.id
                  )
                }

                this.runtime.activity.record({
                  tool: "delete_environment",
                  outcome: "changed",
                  summary: `Permanently deleted environment '${deletedName}'`,
                  revision: this.runtime.context.revision("app-context"),
                })

                return this.runtime.result("app-context", {
                  success: true,
                  deletedEnvironment: deletedName,
                })
              },
            })
          },
        },
        signal
      ),
    ])
  }
}
