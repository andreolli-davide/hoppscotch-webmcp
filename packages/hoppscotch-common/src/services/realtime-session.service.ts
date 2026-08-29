import { Service } from "dioc"
import { firstValueFrom } from "rxjs"
import { parseTemplateString } from "@hoppscotch/data"
import { getAggregateEnvsWithCurrentValue } from "~/newstore/environments"

import { MQTTConnectionConfig } from "~/helpers/realtime/MQTTConnection"
import { HoppRealtimeLog } from "~/helpers/types/HoppRealtimeLog"
import {
  MQTTClientID$,
  MQTTConn$,
  MQTTEndpoint$,
  MQTTLog$,
  MQTTConfig$,
  setMQTTClientID,
  setMQTTEndpoint,
  updateMQTTConfig,
} from "~/newstore/MQTTSession"
import {
  SIOAuth$,
  SIOEndpoint$,
  SIOLog$,
  SIOPath$,
  SIOSocket$,
  SIOVersion$,
  setSIOAuthType,
  setSIOBearerToken,
  setSIOAuthActive,
  setSIOEndpoint,
  setSIOPath,
  setSIOVersion,
  HoppSIOAuth,
} from "~/newstore/SocketIOSession"
import {
  SSEEndpoint$,
  SSEEventType$,
  SSELog$,
  SSESocket$,
  setSSEEndpoint,
  setSSEEventType,
} from "~/newstore/SSESession"
import {
  WSEndpoint$,
  WSLog$,
  WSProtocols$,
  WSSocket$,
  setWSEndpoint,
  setWSProtocols,
} from "~/newstore/WebSocketSession"

export type RealtimeMode = "websocket" | "socketio" | "sse" | "mqtt"

export type RealtimeSnapshot = {
  mode: RealtimeMode
  endpoint: string
  state: string
  configuration: Record<string, unknown>
  log: HoppRealtimeLog
}

/**
 * Owns the protocol action boundary used by WebMCP. Connection instances are
 * the same ones held by the visible realtime pages, so state and logs remain
 * human-visible instead of being duplicated in agent-only state.
 */
export class RealtimeSessionService extends Service {
  public static readonly ID = "REALTIME_SESSION_SERVICE"

  public async snapshot(mode: RealtimeMode): Promise<RealtimeSnapshot> {
    if (mode === "websocket") {
      const [endpoint, protocols, socket, log] = await Promise.all([
        firstValueFrom(WSEndpoint$),
        firstValueFrom(WSProtocols$),
        firstValueFrom(WSSocket$),
        firstValueFrom(WSLog$),
      ])
      return {
        mode,
        endpoint,
        state: socket.connectionState$.value,
        configuration: { protocols },
        log,
      }
    }
    if (mode === "socketio") {
      const [endpoint, path, version, auth, socket, log] = await Promise.all([
        firstValueFrom(SIOEndpoint$),
        firstValueFrom(SIOPath$),
        firstValueFrom(SIOVersion$),
        firstValueFrom(SIOAuth$),
        firstValueFrom(SIOSocket$),
        firstValueFrom(SIOLog$),
      ])
      return {
        mode,
        endpoint,
        state: socket.connectionState$.value,
        configuration: { path, version, auth },
        log,
      }
    }
    if (mode === "sse") {
      const [endpoint, eventType, socket, log] = await Promise.all([
        firstValueFrom(SSEEndpoint$),
        firstValueFrom(SSEEventType$),
        firstValueFrom(SSESocket$),
        firstValueFrom(SSELog$),
      ])
      return {
        mode,
        endpoint,
        state: socket.connectionState$.value,
        configuration: { eventType },
        log,
      }
    }
    const [endpoint, clientID, config, socket, log] = await Promise.all([
      firstValueFrom(MQTTEndpoint$),
      firstValueFrom(MQTTClientID$),
      firstValueFrom(MQTTConfig$),
      firstValueFrom(MQTTConn$),
      firstValueFrom(MQTTLog$),
    ])
    return {
      mode,
      endpoint,
      state: socket.connectionState$.value,
      configuration: {
        clientID,
        ...config,
        subscriptions: socket.subscribedTopics$.value.map(({ name, qos }) => ({
          name,
          qos,
        })),
      },
      log,
    }
  }

  public async edit(mode: RealtimeMode, patch: Record<string, unknown>) {
    if (mode === "websocket") {
      if (typeof patch.endpoint === "string") setWSEndpoint(patch.endpoint)
      if (Array.isArray(patch.protocols)) setWSProtocols(patch.protocols as any)
    } else if (mode === "socketio") {
      if (typeof patch.endpoint === "string") setSIOEndpoint(patch.endpoint)
      if (typeof patch.path === "string") setSIOPath(patch.path)
      if (
        patch.version === "v2" ||
        patch.version === "v3" ||
        patch.version === "v4"
      )
        setSIOVersion(patch.version)
      if (patch.auth && typeof patch.auth === "object") {
        const authPatch = patch.auth as Record<string, unknown>
        if (authPatch.authType === "None" || authPatch.authType === "Bearer") {
          setSIOAuthType(authPatch.authType)
        }
        if (typeof authPatch.bearerToken === "string") {
          setSIOBearerToken(authPatch.bearerToken)
        }
        if (typeof authPatch.authActive === "boolean") {
          setSIOAuthActive(authPatch.authActive)
        }
      }
    } else if (mode === "sse") {
      if (typeof patch.endpoint === "string") setSSEEndpoint(patch.endpoint)
      if (typeof patch.eventType === "string") setSSEEventType(patch.eventType)
    } else {
      if (typeof patch.endpoint === "string") setMQTTEndpoint(patch.endpoint)
      if (typeof patch.clientID === "string") setMQTTClientID(patch.clientID)
      const configPatch: Partial<MQTTConnectionConfig> = {}
      if (typeof patch.username === "string")
        configPatch.username = patch.username
      if (typeof patch.password === "string")
        configPatch.password = patch.password
      if (typeof patch.keepAlive === "string")
        configPatch.keepAlive = patch.keepAlive
      if (typeof patch.cleanSession === "boolean")
        configPatch.cleanSession = patch.cleanSession
      if (typeof patch.lwTopic === "string") configPatch.lwTopic = patch.lwTopic
      if (typeof patch.lwMessage === "string")
        configPatch.lwMessage = patch.lwMessage
      if (
        patch.lwQos === 0 ||
        patch.lwQos === 1 ||
        patch.lwQos === 2
      )
        configPatch.lwQos = patch.lwQos
      if (typeof patch.lwRetain === "boolean")
        configPatch.lwRetain = patch.lwRetain
      if (Object.keys(configPatch).length > 0) updateMQTTConfig(configPatch)
    }
    return this.snapshot(mode)
  }

  private waitForConnection(
    state$: {
      value: string
      subscribe: (next: (state: string) => void) => { unsubscribe: () => void }
    },
    starting: string,
    connected: string,
    signal: AbortSignal
  ) {
    return new Promise<void>((resolve, reject) => {
      let started = state$.value === starting
      let complete = false
      const settle = (error?: Error) => {
        if (complete) return
        complete = true
        clearTimeout(timer)
        subscription.unsubscribe()
        signal.removeEventListener("abort", onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onAbort = () => settle(new Error("The connection was cancelled."))
      const subscription = state$.subscribe((state) => {
        if (state === starting) started = true
        if (state === connected) settle()
        else if (started && state !== starting) {
          settle(new Error("The connection did not reach a connected state."))
        }
      })
      const timer = setTimeout(
        () => settle(new Error("The connection timed out.")),
        15_000
      )
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  public async connect(mode: RealtimeMode, signal: AbortSignal) {
    if (signal.aborted) throw new Error("The connection was cancelled.")
    const state = await this.snapshot(mode)
    const disconnected = mode === "sse" ? "STOPPED" : "DISCONNECTED"
    if (state.state !== disconnected) {
      throw new Error(
        "The realtime session is already connecting or connected."
      )
    }
    const envVars = getAggregateEnvsWithCurrentValue()
    if (mode === "websocket") {
      const socket = await firstValueFrom(WSSocket$)
      const completion = this.waitForConnection(
        socket.connectionState$,
        "CONNECTING",
        "CONNECTED",
        signal
      )
      const resolvedUrl = parseTemplateString(state.endpoint, envVars)
      socket.connect(
        resolvedUrl,
        (
          state.configuration.protocols as Array<{
            value: string
            active: boolean
          }>
        )
          .filter((item) => item.active)
          .map((item) => parseTemplateString(item.value, envVars))
      )
      try {
        await completion
      } catch (error) {
        socket.disconnect()
        throw error
      }
    } else if (mode === "socketio") {
      const socket = await firstValueFrom(SIOSocket$)
      const completion = this.waitForConnection(
        socket.connectionState$,
        "CONNECTING",
        "CONNECTED",
        signal
      )
      const resolvedUrl = parseTemplateString(state.endpoint, envVars)
      const resolvedPath = parseTemplateString(
        String(state.configuration.path || "/socket.io"),
        envVars
      )
      const auth = state.configuration.auth as HoppSIOAuth | undefined
      const resolvedToken = auth?.bearerToken
        ? parseTemplateString(auth.bearerToken, envVars, false, false)
        : ""
      socket.connect({
        url: resolvedUrl,
        path: resolvedPath,
        clientVersion: state.configuration.version as any,
        auth:
          auth?.authActive && auth.authType === "Bearer"
            ? {
                type: "Bearer",
                token: resolvedToken,
              }
            : undefined,
      })
      try {
        await completion
      } catch (error) {
        socket.disconnect()
        throw error
      }
    } else if (mode === "sse") {
      const socket = await firstValueFrom(SSESocket$)
      const completion = this.waitForConnection(
        socket.connectionState$,
        "STARTING",
        "STARTED",
        signal
      )
      const resolvedUrl = parseTemplateString(state.endpoint, envVars)
      socket.start(
        resolvedUrl,
        String(state.configuration.eventType || "data")
      )
      try {
        await completion
      } catch (error) {
        socket.stop()
        throw error
      }
    } else {
      const socket = await firstValueFrom(MQTTConn$)
      const completion = this.waitForConnection(
        socket.connectionState$,
        "CONNECTING",
        "CONNECTED",
        signal
      )
      const resolvedUrl = parseTemplateString(state.endpoint, envVars)
      const resolvedClientID = parseTemplateString(
        String(state.configuration.clientID || "hoppscotch"),
        envVars
      )
      const rawConfig = state.configuration as Record<string, unknown>
      const resolvedConfig: MQTTConnectionConfig = {
        username: rawConfig.username
          ? parseTemplateString(String(rawConfig.username), envVars, false, false)
          : undefined,
        password: rawConfig.password
          ? parseTemplateString(String(rawConfig.password), envVars, false, false)
          : undefined,
        keepAlive: String(rawConfig.keepAlive ?? "60"),
        cleanSession: rawConfig.cleanSession !== false,
        lwTopic: rawConfig.lwTopic
          ? parseTemplateString(String(rawConfig.lwTopic), envVars)
          : undefined,
        lwMessage: rawConfig.lwMessage
          ? parseTemplateString(String(rawConfig.lwMessage), envVars, false, false)
          : "",
        lwQos: (rawConfig.lwQos as 0 | 1 | 2) ?? 0,
        lwRetain: Boolean(rawConfig.lwRetain),
      }
      socket.connect(
        resolvedUrl,
        resolvedClientID,
        resolvedConfig
      )
      try {
        await completion
      } catch (error) {
        socket.disconnect()
        throw error
      }
    }
  }

  public async disconnect(mode: RealtimeMode) {
    if (mode === "websocket") (await firstValueFrom(WSSocket$)).disconnect()
    else if (mode === "socketio")
      (await firstValueFrom(SIOSocket$)).disconnect()
    else if (mode === "sse") (await firstValueFrom(SSESocket$)).stop()
    else (await firstValueFrom(MQTTConn$)).disconnect()
  }

  public async send(
    mode: "websocket" | "socketio",
    message: string,
    eventName = ""
  ) {
    if (mode === "websocket")
      (await firstValueFrom(WSSocket$)).sendMessage({ message, eventName })
    else (await firstValueFrom(SIOSocket$)).sendMessage({ message, eventName })
  }

  public async publish(topic: string, message: string) {
    ;(await firstValueFrom(MQTTConn$)).publish(topic, message)
  }

  public async subscribe(topic: string, qos: 0 | 1 | 2) {
    ;(await firstValueFrom(MQTTConn$)).subscribe({
      name: topic,
      qos,
      color: "var(--accent-color)",
    })
  }

  public async unsubscribe(topic: string) {
    ;(await firstValueFrom(MQTTConn$)).unsubscribe(topic)
  }
}
