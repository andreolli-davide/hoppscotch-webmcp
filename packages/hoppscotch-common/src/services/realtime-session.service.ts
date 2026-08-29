import { Service } from "dioc"
import { firstValueFrom } from "rxjs"

import { MQTTConnectionConfig } from "~/helpers/realtime/MQTTConnection"
import { HoppRealtimeLog } from "~/helpers/types/HoppRealtimeLog"
import {
  MQTTClientID$,
  MQTTConn$,
  MQTTEndpoint$,
  MQTTLog$,
  setMQTTClientID,
  setMQTTEndpoint,
} from "~/newstore/MQTTSession"
import {
  SIOEndpoint$,
  SIOLog$,
  SIOPath$,
  SIOSocket$,
  SIOVersion$,
  setSIOEndpoint,
  setSIOPath,
  setSIOVersion,
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

const mqttDefaults: MQTTConnectionConfig = {
  keepAlive: "60",
  cleanSession: true,
  lwMessage: "",
  lwQos: 0,
  lwRetain: false,
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
      const [endpoint, path, version, socket, log] = await Promise.all([
        firstValueFrom(SIOEndpoint$),
        firstValueFrom(SIOPath$),
        firstValueFrom(SIOVersion$),
        firstValueFrom(SIOSocket$),
        firstValueFrom(SIOLog$),
      ])
      return {
        mode,
        endpoint,
        state: socket.connectionState$.value,
        configuration: { path, version },
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
    const [endpoint, clientID, socket, log] = await Promise.all([
      firstValueFrom(MQTTEndpoint$),
      firstValueFrom(MQTTClientID$),
      firstValueFrom(MQTTConn$),
      firstValueFrom(MQTTLog$),
    ])
    return {
      mode,
      endpoint,
      state: socket.connectionState$.value,
      configuration: {
        clientID,
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
    } else if (mode === "sse") {
      if (typeof patch.endpoint === "string") setSSEEndpoint(patch.endpoint)
      if (typeof patch.eventType === "string") setSSEEventType(patch.eventType)
    } else {
      if (typeof patch.endpoint === "string") setMQTTEndpoint(patch.endpoint)
      if (typeof patch.clientID === "string") setMQTTClientID(patch.clientID)
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
    if (mode === "websocket") {
      const socket = await firstValueFrom(WSSocket$)
      const completion = this.waitForConnection(
        socket.connectionState$,
        "CONNECTING",
        "CONNECTED",
        signal
      )
      socket.connect(
        state.endpoint,
        (
          state.configuration.protocols as Array<{
            value: string
            active: boolean
          }>
        )
          .filter((item) => item.active)
          .map((item) => item.value)
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
      socket.connect({
        url: state.endpoint,
        path: String(state.configuration.path || "/socket.io"),
        clientVersion: state.configuration.version as any,
        auth: undefined,
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
      socket.start(
        state.endpoint,
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
      socket.connect(
        state.endpoint,
        String(state.configuration.clientID || "hoppscotch"),
        mqttDefaults
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
