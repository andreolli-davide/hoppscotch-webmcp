import {
  getCurrentEnvironment,
  getSelectedEnvironmentType,
} from "~/newstore/environments"
import { RealtimeMode } from "~/services/realtime-session.service"

import { approvalIdentity } from "../approval-scope"
import { diagnosticForError } from "../diagnostics"
import { runWebMCPExecution } from "../execution-lifecycle"
import { safeTarget } from "./shared"
import {
  editRealtimeSessionInputSchema,
  editRealtimeSessionParser,
  emptyInputSchema,
  executeRESTRequestParser,
  mqttTopicInputSchema,
  mqttTopicParser,
  realtimeLogInputSchema,
  realtimeLogParser,
  realtimeMessageInputSchema,
  realtimeMessageParser,
  expectedRevisionSchema,
} from "../schemas"
import type { WebMCPRuntime } from "../runtime"

export class RealtimeCapability {
  public constructor(private readonly runtime: WebMCPRuntime) {}

  private async realtimeObservation(mode: RealtimeMode) {
    const visible = this.runtime.visibleRealtime(mode)
    if (visible !== true) return visible
    const snapshot = await this.runtime.realtime.snapshot(mode)
    const redactor = this.runtime.redactor()
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
    return this.runtime.result("realtime-session", {
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

  public async register(mode: RealtimeMode, signal: AbortSignal) {
    const common = [
      this.runtime.adapter.register(
        {
          name: "inspect_realtime_session",
          title: "Inspect realtime session",
          description:
            "Inspect the visible realtime session configuration, connection state, and bounded redacted log tail.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) =>
            this.runtime.validBoundary(input) && Object.keys(input).length === 0
              ? this.realtimeObservation(mode)
              : this.runtime.failure(
                  "INVALID_INPUT",
                  "This tool accepts an empty object only."
                ),
        },
        signal
      ),
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
        this.runtime.adapter.register(
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
          this.runtime.adapter.register(
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
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = editRealtimeSessionParser(mode).safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const visible = this.runtime.visibleRealtime(mode)
    if (visible !== true) return visible
    if (
      !this.runtime.context.matches(
        "realtime-session",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
        "STATE_CHANGED",
        "The realtime session changed; inspect it again.",
        "realtime-session",
        true
      )
    }
    const fields = Object.keys(parsed.data.patch)
    await this.runtime.realtime.edit(mode, parsed.data.patch)
    this.runtime.activity.record({
      tool: "edit_realtime_session",
      outcome: "changed",
      summary: `Changed ${mode} ${fields.join(", ")}`.slice(0, 256),
      revision: this.runtime.context.revision("realtime-session"),
    })
    return this.runtime.result("realtime-session", {
      updated: true,
      changedFields: fields,
    })
  }

  private async readRealtimeLog(
    mode: RealtimeMode,
    input: Record<string, unknown>
  ) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = realtimeLogParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const visible = this.runtime.visibleRealtime(mode)
    if (visible !== true) return visible
    if (
      !this.runtime.context.matches(
        "realtime-session",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
        "STATE_CHANGED",
        "The realtime log changed; inspect it again.",
        "realtime-session",
        true
      )
    }
    const snapshot = await this.runtime.realtime.snapshot(mode)
    const redactor = this.runtime.redactor()
    const entries = snapshot.log
      .slice(parsed.data.offset, parsed.data.offset + parsed.data.limit)
      .map((line) => ({
        source: redactor.scrub(line.source, 32),
        prefix: line.prefix ? redactor.scrub(line.prefix, 48) : undefined,
        payload: redactor.scrub(line.payload, 256),
        timestamp: line.ts,
      }))
    return this.runtime.result("realtime-session", {
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
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
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
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const visible = this.runtime.visibleRealtime(mode)
    if (visible !== true) return visible
    if (
      !this.runtime.context.matches(
        "realtime-session",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
        "STATE_CHANGED",
        "The realtime session changed; inspect it again.",
        "realtime-session",
        true
      )
    }
    const consequential = action !== "disconnect"
    const appContext = this.runtime.context.capture()
    const appContextRevision = this.runtime.context.revision("app-context")
    const dependencyRevision = this.runtime.context.revision("rest-document")
    const realtimeRevision = this.runtime.context.revision("realtime-session")
    const snapshot = await this.runtime.realtime.snapshot(mode)
    const typedMessage =
      action === "send" ? realtimeMessageParser.parse(input) : null
    const typedTopic =
      action === "publish" || action === "subscribe" || action === "unsubscribe"
        ? mqttTopicParser.parse(input)
        : null
    const executeAction = async () => {
      try {
        const format = "format" in parsed.data ? parsed.data.format : "text"
        const message =
          "message" in parsed.data ? parsed.data.message : undefined
        const actionDiagnostics: Array<Record<string, unknown>> = []
        if (format === "json" && typeof message === "string") {
          try {
            JSON.parse(message)
          } catch (error) {
            actionDiagnostics.push({
              ...diagnosticForError(error, this.runtime.redactor(), {
                code: "MALFORMED_JSON_MESSAGE",
                phase: "payload",
                location: "message",
              }),
              severity: "warning",
            })
          }
        }
        if (action === "connect") {
          await this.runtime.realtime.connect(mode, signal)
        } else if (action === "disconnect")
          await this.runtime.realtime.disconnect(mode)
        else if (action === "send") {
          const message = realtimeMessageParser.parse(input)
          await this.runtime.realtime.send(
            mode as "websocket" | "socketio",
            message.message,
            message.eventName
          )
        } else {
          const topic = mqttTopicParser.parse(input)
          if (action === "publish")
            await this.runtime.realtime.publish(
              topic.topic,
              topic.message ?? ""
            )
          else if (action === "subscribe")
            await this.runtime.realtime.subscribe(topic.topic, topic.qos)
          else await this.runtime.realtime.unsubscribe(topic.topic)
        }
        this.runtime.activity.record({
          tool: `${action}_${mode}`,
          outcome: consequential ? "executed" : "changed",
          summary: `${action} ${mode}`.slice(0, 256),
          revision: this.runtime.context.revision("realtime-session"),
        })
        const observation = await this.realtimeObservation(mode)
        return observation.ok
          ? { ...observation, actionDiagnostics }
          : observation
      } catch (error) {
        return this.runtime.failure(
          "EXECUTION_FAILED",
          error instanceof Error ? error.message : "Realtime action failed.",
          "realtime-session"
        )
      }
    }
    if (!consequential) return executeAction()
    return runWebMCPExecution({
      approval: this.runtime.approval,
      request: {
        action: `${action[0].toUpperCase()}${action.slice(1)} ${mode}`,
        method: action.toUpperCase(),
        target: this.runtime
          .redactor()
          .scrub(safeTarget(snapshot.endpoint), 256),
        environment: appContext.environment.name,
        workspace: appContext.workspace.type,
        grantKey: approvalIdentity({
          operation: "realtime",
          environmentScope: getSelectedEnvironmentType(),
          workspaceID: this.runtime.workspace.currentWorkspace.value,
          environmentID: getCurrentEnvironment().id,
          scope: mode,
          revision: parsed.data.expectedRevision,
          dependencyRevision,
          target: snapshot.endpoint,
          action,
          details: {
            format: typedMessage?.format ?? typedTopic?.format ?? "text",
            topic: typedTopic?.topic,
            message: typedMessage?.message ?? typedTopic?.message,
            eventName: typedMessage?.eventName,
            qos: typedTopic?.qos,
          },
        }),
      },
      signal,
      capture: () => ({
        snapshot,
        revision: realtimeRevision,
        appContextRevision,
        dependencyRevision,
        environment: appContext.environment.name,
        workspace: appContext.workspace.type,
      }),
      revalidate: (captured) =>
        this.runtime.context.matches("realtime-session", captured.revision) &&
        this.runtime.context.matches(
          "app-context",
          captured.appContextRevision
        ) &&
        this.runtime.context.matches(
          "rest-document",
          captured.dependencyRevision
        ) &&
        this.runtime.visibleRealtime(mode) === true &&
        this.runtime.context.capture().environment.name ===
          captured.environment &&
        this.runtime.context.capture().workspace.type === captured.workspace,
      denied: (cancelled) =>
        this.runtime.failure(
          cancelled ? "CANCELLED" : "APPROVAL_DENIED",
          cancelled
            ? "The action was cancelled."
            : "The user denied the action.",
          "realtime-session"
        ),
      stale: () =>
        this.runtime.failure(
          "STATE_CHANGED",
          "The realtime session changed while approval was open.",
          "realtime-session",
          true
        ),
      error: (error) =>
        this.runtime.failure(
          "EXECUTION_FAILED",
          error instanceof Error ? error.message : "Realtime action failed.",
          "realtime-session"
        ),
      execute: () => executeAction(),
    })
  }
}
