import { Service } from "dioc"
import { v4 as uuidV4 } from "uuid"
import { shallowRef, watch } from "vue"
import { Router } from "vue-router"

import { HoppRequestDocument } from "~/helpers/rest/document"
import {
  environmentsStore,
  getCurrentEnvironment,
  getSelectedEnvironmentType,
} from "~/newstore/environments"
import {
  restCollections$,
  graphqlCollections$,
} from "~/newstore/collections"
import { restHistory$, graphqlHistory$ } from "~/newstore/history"
import { CurrentValueService } from "~/services/current-environment-value.service"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { RESTTabService } from "~/services/tab/rest"
import { GQLTabService } from "~/services/tab/graphql"
import { HoppTab } from "~/services/tab"
import { WorkspaceService } from "~/services/workspace.service"
import { connection, gqlMessageEvent } from "~/helpers/graphql/connection"
import { WSRequest$, WSLog$, WSSocket$ } from "~/newstore/WebSocketSession"
import { SIORequest$, SIOLog$, SIOSocket$ } from "~/newstore/SocketIOSession"
import { SSERequest$, SSELog$, SSESocket$ } from "~/newstore/SSESession"
import { MQTTRequest$, MQTTLog$, MQTTConn$ } from "~/newstore/MQTTSession"

import { ActiveAppContextDTO, WebMCPRevisionScope } from "./types"

export type VisibleRESTContext = {
  tab: HoppTab<HoppRequestDocument>
  token: string
}

export type VisibleGQLContext = {
  tab: HoppTab<any>
  token: string
}

export class ActiveAppContextService extends Service {
  public static readonly ID = "ACTIVE_APP_CONTEXT_SERVICE"

  private readonly restTabs = this.bind(RESTTabService)
  private readonly gqlTabs = this.bind(GQLTabService)
  private readonly workspace = this.bind(WorkspaceService)
  private readonly interceptor = this.bind(KernelInterceptorService)
  private readonly secrets = this.bind(SecretEnvironmentService)
  private readonly currentValues = this.bind(CurrentValueService)

  private readonly router = shallowRef<Router | null>(null)
  private stopRouteWatch: (() => void) | null = null
  private readonly documentTokens = new WeakMap<object, string>()
  private revisions: Record<WebMCPRevisionScope, number> = {
    "app-context": 1,
    "rest-document": 1,
    "rest-response": 1,
    "graphql-document": 1,
    "graphql-response": 1,
    "realtime-session": 1,
  }

  override onServiceInit() {
    watch(
      () => [
        this.restTabs.currentTabID.value,
        this.restTabs.currentActiveTab.value?.document?.type,
        this.restTabs.currentActiveTab.value?.document?.isDirty,
        this.restTabs.currentActiveTab.value?.document?.type === "request"
          ? this.restTabs.currentActiveTab.value?.document?.request
          : null,
        this.restTabs.currentActiveTab.value?.document?.type === "request"
          ? this.restTabs.currentActiveTab.value?.document?.inheritedProperties
          : null,
        this.restTabs.currentActiveTab.value?.document?.type === "request"
          ? this.restTabs.currentActiveTab.value?.document?.saveContext
          : null,
      ],
      () => {
        this.bump("app-context")
        this.bump("rest-document")
      },
      { deep: true, flush: "sync" }
    )

    watch(
      () => [
        this.gqlTabs.currentTabID.value,
        this.gqlTabs.currentActiveTab.value?.document?.request,
        this.gqlTabs.currentActiveTab.value?.document?.isDirty,
        this.gqlTabs.currentActiveTab.value?.document?.saveContext,
        this.gqlTabs.currentActiveTab.value?.document?.inheritedProperties,
      ],
      () => {
        this.bump("app-context")
        this.bump("graphql-document")
      },
      { deep: true, flush: "sync" }
    )
    watch(
      () => [gqlMessageEvent.value, connection.state, connection.schema],
      () => this.bump("graphql-response"),
      { deep: true, flush: "sync" }
    )

    watch(
      () =>
        this.restTabs.currentActiveTab.value?.document?.type === "request"
          ? [
              this.restTabs.currentActiveTab.value?.document?.response,
              this.restTabs.currentActiveTab.value?.document?.testResults,
            ]
          : null,
      () => this.bump("rest-response"),
      { deep: true, flush: "sync" }
    )

    watch(
      this.workspace.currentWorkspace,
      () => {
        this.bump("app-context")
        this.bump("rest-document")
      },
      { deep: true, flush: "sync" }
    )
    watch(
      () => this.interceptor.getCurrentId(),
      () => this.bump("rest-document"),
      { flush: "sync" }
    )
    watch(
      () => this.secrets.secretEnvironments,
      () => this.bump("rest-document"),
      { deep: true, flush: "sync" }
    )
    watch(
      () => this.currentValues.environments,
      () => this.bump("rest-document"),
      { deep: true, flush: "sync" }
    )

    environmentsStore.subject$.subscribe(() => {
      this.bump("app-context")
      this.bump("rest-document")
    })
    restCollections$.subscribe(() => {
      this.bump("app-context")
      this.bump("rest-document")
    })
    graphqlCollections$.subscribe(() => {
      this.bump("app-context")
      this.bump("graphql-document")
    })
    restHistory$.subscribe(() => {
      this.bump("app-context")
      this.bump("rest-document")
    })
    graphqlHistory$.subscribe(() => {
      this.bump("app-context")
      this.bump("graphql-document")
    })
    const bumpRealtimeSession = () => this.bump("realtime-session")
    WSRequest$.subscribe(bumpRealtimeSession)
    WSLog$.subscribe(bumpRealtimeSession)
    WSSocket$.subscribe(bumpRealtimeSession)
    SIORequest$.subscribe(bumpRealtimeSession)
    SIOLog$.subscribe(bumpRealtimeSession)
    SIOSocket$.subscribe(bumpRealtimeSession)
    SSERequest$.subscribe(bumpRealtimeSession)
    SSELog$.subscribe(bumpRealtimeSession)
    SSESocket$.subscribe(bumpRealtimeSession)
    MQTTRequest$.subscribe(bumpRealtimeSession)
    MQTTLog$.subscribe(bumpRealtimeSession)
    MQTTConn$.subscribe(bumpRealtimeSession)
  }

  public attachRouter(router: Router) {
    this.router.value = router
    this.stopRouteWatch?.()
    this.stopRouteWatch = watch(
      router.currentRoute,
      () => {
        this.bump("app-context")
        this.bump("rest-document")
      },
      { flush: "sync" }
    )
  }

  public revision(scope: WebMCPRevisionScope) {
    return `${scope}:${this.revisions[scope]}`
  }

  public matches(scope: WebMCPRevisionScope, expected: string) {
    return this.revision(scope) === expected
  }

  public isRESTAvailable() {
    return Boolean(this.captureVisibleREST())
  }

  public isGQLAvailable() {
    return Boolean(this.captureVisibleGQL())
  }

  public realtimeMode(): "websocket" | "socketio" | "sse" | "mqtt" | null {
    const path = this.router.value?.currentRoute.value.path ?? ""
    if (!path.startsWith("/realtime/")) return null
    const mode = path.split("/")[2]
    return mode === "websocket" ||
      mode === "socketio" ||
      mode === "sse" ||
      mode === "mqtt"
      ? mode
      : null
  }

  public captureVisibleREST(): VisibleRESTContext | null {
    if (this.router.value?.currentRoute.value.path !== "/") return null
    const tab = this.restTabs.getActiveTab()
    if (!tab || tab.document.type !== "request") return null

    let token = this.documentTokens.get(tab.document)
    if (!token) {
      token = uuidV4()
      this.documentTokens.set(tab.document, token)
    }
    return { tab: tab as HoppTab<HoppRequestDocument>, token }
  }

  public captureVisibleGQL(): VisibleGQLContext | null {
    if (this.router.value?.currentRoute.value.path !== "/graphql") return null
    const tab = this.gqlTabs.getActiveTab()
    if (!tab) return null
    let token = this.documentTokens.get(tab.document)
    if (!token) {
      token = uuidV4()
      this.documentTokens.set(tab.document, token)
    }
    return { tab, token }
  }

  public capture(): ActiveAppContextDTO {
    const route = this.router.value?.currentRoute.value
    const path = route?.path ?? ""
    const surface =
      path === "/"
        ? "rest"
        : path === "/graphql"
          ? "graphql"
          : path.startsWith("/realtime")
            ? "realtime"
            : "other"
    const mode =
      surface === "realtime"
        ? path.split("/")[2] || "websocket"
        : surface === "rest" || surface === "graphql"
          ? "request"
          : String(route?.name ?? "other")

    const workspace = this.workspace.currentWorkspace.value
    const selectedEnvironment = getCurrentEnvironment()
    const selectedType = getSelectedEnvironmentType()
    const rest = this.captureVisibleREST()
    const gql = this.captureVisibleGQL()
    const realtimeMode = this.realtimeMode()

    return {
      surface,
      mode,
      workspace:
        workspace.type === "personal"
          ? { type: "personal" }
          : {
              type: "team",
              name: workspace.teamName,
              role: workspace.role ?? null,
            },
      environment: {
        name: selectedEnvironment.name,
        scope:
          selectedType === "NO_ENV_SELECTED"
            ? "none"
            : selectedType === "TEAM_ENV"
              ? "team"
              : "personal",
      },
      activeDocument: rest
        ? {
            token: rest.token,
            kind: "request",
            dirty: rest.tab.document.isDirty,
          }
        : gql
          ? {
              token: gql.token,
              kind: "graphql",
              dirty: gql.tab.document.isDirty,
            }
          : realtimeMode
            ? {
                token: `realtime:${realtimeMode}`,
                kind: "realtime",
                dirty: false,
              }
            : undefined,
      dirtyDocumentCount:
        this.restTabs.getDirtyTabsCount() + this.gqlTabs.getDirtyTabsCount(),
      capabilityPacks: (() => {
        const packs = rest
          ? ["app-context", "environment", "rest"]
          : gql
            ? ["app-context", "graphql"]
            : realtimeMode
              ? ["app-context", `realtime-${realtimeMode}`]
              : ["app-context"]
        if (import.meta.env.VITE_ENABLE_WEBMCP_DURABLE_OPS === "true") {
          packs.push("durable-ops")
        }
        return packs
      })(),
    }
  }

  private bump(scope: WebMCPRevisionScope) {
    this.revisions[scope] += 1
  }
}
