import { Service } from "dioc"
import { computed, watch } from "vue"
import { Router } from "vue-router"
import { RealtimeMode } from "~/services/realtime-session.service"
import { WebMCPRuntime } from "./runtime"
import { AppCapability } from "./capabilities/app"
import { GraphQLCapability } from "./capabilities/graphql"
import { RESTCapability } from "./capabilities/rest"
import { CollectionCapability } from "./capabilities/collections"
import { EnvironmentCapability } from "./capabilities/environment"
import { RealtimeCapability } from "./capabilities/realtime"

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
    const startupController = this.appController
    const isCurrentStartup = () =>
      this.appController === startupController &&
      !startupController.signal.aborted

    await this.registerAppPack(startupController.signal)
    if (!isCurrentStartup()) return
    if (import.meta.env.VITE_ENABLE_WEBMCP_DURABLE_OPS === "true") {
      this.durableOpsController = new AbortController()
      await Promise.all([
        new CollectionCapability(this.runtime).registerDurable(
          this.durableOpsController.signal
        ),
        new EnvironmentCapability(this.runtime).registerDurable(
          this.durableOpsController.signal
        ),
      ])
      if (!isCurrentStartup()) return
    }
    await this.syncCapabilityPacks()
    if (!isCurrentStartup()) return
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
      const restCapability = new RESTCapability(this.runtime)
      const collectionCapability = new CollectionCapability(this.runtime)
      await Promise.all([
        restCapability.register(this.restController.signal),
        collectionCapability.registerREST(this.restController.signal, () =>
          restCapability.observation()
        ),
      ])
    } else if (!available && this.restController) {
      this.restController.abort()
      this.restController = null
    }
  }

  private async syncGraphQLPack() {
    const available = this.runtime.context.isGQLAvailable()
    if (available && !this.gqlController) {
      this.gqlController = new AbortController()
      const graphqlCapability = new GraphQLCapability(this.runtime)
      const collectionCapability = new CollectionCapability(this.runtime)
      await Promise.all([
        graphqlCapability.register(this.gqlController.signal),
        collectionCapability.registerGraphQL(this.gqlController.signal, () =>
          graphqlCapability.observation()
        ),
      ])
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
}
