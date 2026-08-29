import { describe, expect, it } from "vitest"
import { Container } from "dioc"

import { RealtimeSessionService } from "~/services/realtime-session.service"
import {
  setSIOEndpoint,
  setSIOAuthType,
  setSIOBearerToken,
  setSIOAuthActive,
} from "~/newstore/SocketIOSession"
import {
  setMQTTEndpoint,
  setMQTTClientID,
  setMQTTConfig,
  defaultMQTTConfig,
} from "~/newstore/MQTTSession"
import {
  editRealtimeSessionParser,
  editRealtimeSessionInputSchema,
} from "../schemas"

describe("WebMCP Realtime Session Parity", () => {
  it("snapshots and edits Socket.IO auth configuration", async () => {
    const container = new Container()
    const service = container.bind(RealtimeSessionService)

    setSIOEndpoint("wss://socketio.example.test")
    setSIOAuthType("Bearer")
    setSIOBearerToken("<<AUTH_TOKEN>>")
    setSIOAuthActive(true)

    const initial = await service.snapshot("socketio")
    expect(initial.endpoint).toBe("wss://socketio.example.test")
    expect(initial.configuration.auth).toEqual({
      authType: "Bearer",
      bearerToken: "<<AUTH_TOKEN>>",
      authActive: true,
    })

    // Edit via service edit
    await service.edit("socketio", {
      auth: {
        authType: "None",
        authActive: false,
      },
    })

    const updated = await service.snapshot("socketio")
    expect(updated.configuration.auth).toMatchObject({
      authType: "None",
      authActive: false,
    })
  })

  it("snapshots and edits MQTT connection settings", async () => {
    const container = new Container()
    const service = container.bind(RealtimeSessionService)

    setMQTTEndpoint("wss://mqtt.example.test:8081")
    setMQTTClientID("custom-client")
    setMQTTConfig({
      ...defaultMQTTConfig,
      username: "<<MQTT_USER>>",
      password: "<<MQTT_PASS>>",
      keepAlive: "120",
      cleanSession: false,
      lwTopic: "status/disconnected",
      lwMessage: "offline",
      lwQos: 1,
      lwRetain: true,
    })

    const initial = await service.snapshot("mqtt")
    expect(initial.endpoint).toBe("wss://mqtt.example.test:8081")
    expect(initial.configuration.clientID).toBe("custom-client")
    expect(initial.configuration.username).toBe("<<MQTT_USER>>")
    expect(initial.configuration.password).toBe("<<MQTT_PASS>>")
    expect(initial.configuration.keepAlive).toBe("120")
    expect(initial.configuration.cleanSession).toBe(false)
    expect(initial.configuration.lwTopic).toBe("status/disconnected")
    expect(initial.configuration.lwMessage).toBe("offline")
    expect(initial.configuration.lwQos).toBe(1)
    expect(initial.configuration.lwRetain).toBe(true)

    // Edit via service edit
    await service.edit("mqtt", {
      username: "<<NEW_USER>>",
      keepAlive: "30",
      cleanSession: true,
    })

    const updated = await service.snapshot("mqtt")
    expect(updated.configuration.username).toBe("<<NEW_USER>>")
    expect(updated.configuration.keepAlive).toBe("30")
    expect(updated.configuration.cleanSession).toBe(true)
  })

  it("validates Socket.IO auth and MQTT connection config schemas", () => {
    const sioValid = editRealtimeSessionParser("socketio").safeParse({
      expectedRevision: "realtime-session:1",
      patch: {
        auth: {
          authType: "Bearer",
          bearerToken: "<<AUTH_TOKEN>>",
          authActive: true,
        },
      },
    })
    expect(sioValid.success).toBe(true)

    const mqttValid = editRealtimeSessionParser("mqtt").safeParse({
      expectedRevision: "realtime-session:1",
      patch: {
        username: "<<USER>>",
        password: "<<PASS>>",
        keepAlive: "90",
        cleanSession: false,
        lwTopic: "will/topic",
        lwMessage: "bye",
        lwQos: 2,
        lwRetain: false,
      },
    })
    expect(mqttValid.success).toBe(true)

    // Schema properties check
    const sioSchema = editRealtimeSessionInputSchema("socketio")
    expect(sioSchema.properties.patch.properties).toHaveProperty("auth")

    const mqttSchema = editRealtimeSessionInputSchema("mqtt")
    expect(mqttSchema.properties.patch.properties).toHaveProperty("username")
    expect(mqttSchema.properties.patch.properties).toHaveProperty("password")
    expect(mqttSchema.properties.patch.properties).toHaveProperty("keepAlive")
    expect(mqttSchema.properties.patch.properties).toHaveProperty("cleanSession")
  })
})
