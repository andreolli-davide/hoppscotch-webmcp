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
import { CurrentValueService } from "~/services/current-environment-value.service"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { RESTTabService } from "~/services/tab/rest"
import { HoppTab } from "~/services/tab"
import { WorkspaceService } from "~/services/workspace.service"

import { ActiveAppContextDTO, WebMCPRevisionScope } from "./types"

export type VisibleRESTContext = {
  tab: HoppTab<HoppRequestDocument>
  token: string
}

export class ActiveAppContextService extends Service {
  public static readonly ID = "ACTIVE_APP_CONTEXT_SERVICE"

  private readonly restTabs = this.bind(RESTTabService)
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
  }

  override onServiceInit() {
    watch(
      () => [
        this.restTabs.currentTabID.value,
        this.restTabs.currentActiveTab.value.document.type,
        this.restTabs.currentActiveTab.value.document.isDirty,
        this.restTabs.currentActiveTab.value.document.type === "request"
          ? this.restTabs.currentActiveTab.value.document.request
          : null,
        this.restTabs.currentActiveTab.value.document.type === "request"
          ? this.restTabs.currentActiveTab.value.document.inheritedProperties
          : null,
        this.restTabs.currentActiveTab.value.document.type === "request"
          ? this.restTabs.currentActiveTab.value.document.saveContext
          : null,
      ],
      () => {
        this.bump("app-context")
        this.bump("rest-document")
      },
      { deep: true, flush: "sync" }
    )

    watch(
      () =>
        this.restTabs.currentActiveTab.value.document.type === "request"
          ? [
              this.restTabs.currentActiveTab.value.document.response,
              this.restTabs.currentActiveTab.value.document.testResults,
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
        : undefined,
      dirtyDocumentCount: this.restTabs.getDirtyTabsCount(),
      capabilityPacks: rest
        ? ["app-context", "environment", "rest"]
        : ["app-context"],
    }
  }

  private bump(scope: WebMCPRevisionScope) {
    this.revisions[scope] += 1
  }
}
