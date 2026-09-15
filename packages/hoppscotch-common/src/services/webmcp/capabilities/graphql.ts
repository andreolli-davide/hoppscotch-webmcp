import { HoppGQLRequest, getDefaultGQLRequest } from "@hoppscotch/data"
import { cloneDeep } from "lodash-es"
import { graphqlHistoryStore } from "~/newstore/history"
import { HoppGQLDocument } from "~/helpers/graphql/document"
import { connection, gqlMessageEvent } from "~/helpers/graphql/connection"
import {
  getCurrentEnvironment,
  getSelectedEnvironmentType,
} from "~/newstore/environments"
import { approvalIdentity } from "../approval-scope"
import { runWebMCPExecution } from "../execution-lifecycle"
import { applyJSONPointerOperations, diagnosticForError } from "../diagnostics"
import { readSafeTextWindow } from "../payload-windows"
import { safeTarget } from "./shared"
import {
  configureRESTAuthInputSchema,
  configureRESTAuthParser,
  editGraphQLOperationInputSchema,
  editGraphQLOperationParser,
  editGraphQLVariablesInputSchema,
  editGraphQLVariablesParser,
  emptyInputSchema,
  executeRESTRequestParser,
  expectedRevisionSchema,
  graphqlPayloadInputSchema,
  graphqlPayloadParser,
  graphqlSchemaSearchInputSchema,
  graphqlSchemaSearchParser,
  switchTabInputSchema,
  switchTabParser,
  createTabInputSchema,
  createTabParser,
  closeTabInputSchema,
  closeTabParser,
  listHistoryInputSchema,
  listHistoryParser,
  loadHistoryEntryInputSchema,
  loadHistoryEntryParser,
} from "../schemas"
import { configureGQLAuth } from "../rest-drafts"
import type { WebMCPRuntime } from "../runtime"

export class GraphQLCapability {
  public constructor(private readonly runtime: WebMCPRuntime) {}

  private gqlExchange(document: HoppGQLDocument) {
    const redactor = this.runtime.redactor()
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
          connection.subscriptionState.get(
            this.runtime.gqlTabs.currentTabID.value
          ) ?? "UNSUBSCRIBED",
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

  public async observation() {
    const gql = this.runtime.visibleGQL()
    if ("ok" in gql) return gql
    return this.runtime.result("graphql-document", {
      responseRevision: this.runtime.context.revision("graphql-response"),
      operation: this.gqlExchange(gql.tab.document),
    })
  }

  public async register(signal: AbortSignal) {
    await Promise.all([
      this.runtime.adapter.register(
        {
          name: "inspect_graphql_operation",
          title: "Inspect current GraphQL operation",
          description:
            "Inspect the visible GraphQL operation, connection, latest response, and draft state with bounded redacted content.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) =>
            this.runtime.validBoundary(input) && Object.keys(input).length === 0
              ? this.observation()
              : this.runtime.failure(
                  "INVALID_INPUT",
                  "This tool accepts an empty object only."
                ),
        },
        signal
      ),
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
        {
          name: "list_gql_tabs",
          title: "List open GraphQL tabs",
          description:
            "List all open GraphQL editor tabs with their IDs, titles, dirty states, and active selection.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (
              !this.runtime.validBoundary(input) ||
              Object.keys(input).length !== 0
            ) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            }
            const redactor = this.runtime.redactor()
            const tabs = this.runtime.gqlTabs.getTabs().map((tab) => ({
              id: tab.id,
              title: redactor.scrub(
                tab.document.request.name || "Untitled",
                64
              ),
              isDirty: tab.document.isDirty,
              isActive: tab.id === this.runtime.gqlTabs.currentTabID.value,
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
            return this.runtime.result("graphql-document", { tabs })
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "switch_gql_tab",
          title: "Switch active GraphQL tab",
          description: "Switch to a specific open GraphQL tab by tab ID.",
          inputSchema: switchTabInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = switchTabParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.runtime.context.matches(
                "graphql-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "graphql-document",
                true
              )
            }
            const tab = this.runtime.gqlTabs
              .getTabs()
              .find((t) => t.id === parsed.data.tabID)
            if (!tab) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The requested tab was not found.",
                "graphql-document"
              )
            }
            this.runtime.gqlTabs.setActiveTab(parsed.data.tabID)
            this.runtime.activity.record({
              tool: "switch_gql_tab",
              outcome: "changed",
              summary: `Switched active GraphQL tab to ${parsed.data.tabID}`,
              revision: this.runtime.context.revision("graphql-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "create_gql_tab",
          title: "Create new GraphQL tab",
          description:
            "Open a new blank GraphQL request tab in the editor and set it as active.",
          inputSchema: createTabInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = createTabParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.runtime.context.matches(
                "graphql-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "graphql-document",
                true
              )
            }
            const req = getDefaultGQLRequest()
            if (parsed.data.name) req.name = parsed.data.name
            const newTab = this.runtime.gqlTabs.createNewTab(
              {
                type: "graphql",
                request: req,
                isDirty: false,
                response: null,
                optionTabPreference: "query",
              } as any,
              true
            )
            this.runtime.activity.record({
              tool: "create_gql_tab",
              outcome: "changed",
              summary: `Created new GraphQL tab ${newTab.id}`,
              revision: this.runtime.context.revision("graphql-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "close_gql_tab",
          title: "Close GraphQL tab",
          description:
            "Close an open GraphQL tab by ID. If the tab has unsaved changes, force must be set to true.",
          inputSchema: closeTabInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = closeTabParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.runtime.context.matches(
                "graphql-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "graphql-document",
                true
              )
            }
            const tab = this.runtime.gqlTabs
              .getTabs()
              .find((t) => t.id === parsed.data.tabID)
            if (!tab) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The requested tab was not found.",
                "graphql-document"
              )
            }
            if (this.runtime.gqlTabs.getTabs().length <= 1) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "Cannot close the only open tab.",
                "graphql-document"
              )
            }
            if (tab.document.isDirty && !parsed.data.force) {
              return this.runtime.failure(
                "DIRTY_TAB_UNSAVED_CHANGES",
                "The tab has unsaved changes. Save it to a collection or pass force: true to discard changes.",
                "graphql-document"
              )
            }
            this.runtime.gqlTabs.closeTab(parsed.data.tabID)
            this.runtime.activity.record({
              tool: "close_gql_tab",
              outcome: "changed",
              summary: `Closed GraphQL tab ${parsed.data.tabID}`,
              revision: this.runtime.context.revision("graphql-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "list_gql_history",
          title: "List GraphQL execution history",
          description: "List recent GraphQL request history entries.",
          inputSchema: listHistoryInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = listHistoryParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const historyState = graphqlHistoryStore.value.state
            const slice = historyState.slice(
              parsed.data.offset,
              parsed.data.offset + parsed.data.limit
            )
            const redactor = this.runtime.redactor()
            const entries = slice.map((entry, i) => ({
              index: parsed.data.offset + i,
              name: redactor.scrub(entry.request.name || "Untitled", 64),
              url: redactor.scrub(entry.request.url, 128),
              star: entry.star,
              updatedOn: entry.updatedOn ? entry.updatedOn.toISOString() : null,
            }))
            return this.runtime.result("graphql-document", {
              total: historyState.length,
              offset: parsed.data.offset,
              limit: parsed.data.limit,
              entries,
            })
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "load_gql_history_entry",
          title: "Load GraphQL history entry into tab",
          description:
            "Load a GraphQL request from execution history into an active or new tab.",
          inputSchema: loadHistoryEntryInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = loadHistoryEntryParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            if (
              !this.runtime.context.matches(
                "graphql-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The editor state changed; inspect it again.",
                "graphql-document",
                true
              )
            }
            const historyEntry =
              graphqlHistoryStore.value.state[parsed.data.index]
            if (!historyEntry) {
              return this.runtime.failure(
                "INVALID_INPUT",
                `GraphQL history entry at index ${parsed.data.index} not found.`,
                "graphql-document"
              )
            }
            const reqToLoad = cloneDeep(historyEntry.request)
            if (parsed.data.targetTab === "new") {
              this.runtime.gqlTabs.createNewTab(
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
              const gql = this.runtime.visibleGQL()
              if ("ok" in gql) return gql
              if (gql.tab.document.isDirty) {
                return this.runtime.failure(
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
            this.runtime.activity.record({
              tool: "load_gql_history_entry",
              outcome: "changed",
              summary: `Loaded GraphQL history entry ${parsed.data.index}`,
              revision: this.runtime.context.revision("graphql-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
    ])
  }

  private async readGraphQLPayload(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = graphqlPayloadParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.runtime.visibleGQL()
    if ("ok" in gql) return gql
    const scope =
      parsed.data.source === "response"
        ? "graphql-response"
        : "graphql-document"
    if (!this.runtime.context.matches(scope, parsed.data.expectedRevision)) {
      return this.runtime.failure(
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
    const window = readSafeTextWindow(
      value,
      this.runtime.redactor(),
      parsed.data.offset,
      parsed.data.maxChars,
      "redacted-utf16"
    )
    return this.runtime.result(scope, {
      payload: {
        source: parsed.data.source,
        offset: window.offset,
        text: window.text,
        totalChars: window.totalChars,
        nextOffset: window.nextOffset,
        truncated: window.truncated,
      },
    })
  }

  private async searchGraphQLSchema(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = graphqlSchemaSearchParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.runtime.visibleGQL()
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
    return this.runtime.result("graphql-document", {
      schemaLoaded: Boolean(connection.schema),
      matches,
    })
  }

  private async editGraphQLOperation(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = editGraphQLOperationParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.runtime.visibleGQL()
    if ("ok" in gql) return gql
    if (
      !this.runtime.context.matches(
        "graphql-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
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
      return this.runtime.failure(
        "INVALID_INPUT",
        "The patch does not produce a valid GraphQL request.",
        "graphql-document"
      )
    gql.tab.document.request = validated.value
    gql.tab.document.isDirty = true
    const revision = this.runtime.context.revision("graphql-document")
    this.runtime.activity.record({
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
    return this.runtime.result("graphql-document", {
      updated: true,
      changedFields,
      draft: {
        dirty: gql.tab.document.isDirty,
        provenance: gql.tab.document.saveContext?.originLocation ?? "unsaved",
      },
    })
  }

  private async editGraphQLVariables(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = editGraphQLVariablesParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.runtime.visibleGQL()
    if ("ok" in gql) return gql
    if (
      !this.runtime.context.matches(
        "graphql-document",
        parsed.data.expectedRevision
      )
    )
      return this.runtime.failure(
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
        return this.runtime.failure(
          "INVALID_INPUT",
          "The variables edit does not produce a valid GraphQL request.",
          "graphql-document"
        )
      gql.tab.document.request = validated.value
      gql.tab.document.isDirty = true
      const revision = this.runtime.context.revision("graphql-document")
      const token = gql.token
      this.runtime.activity.record(
        {
          tool: "edit_graphql_variables",
          outcome: "changed",
          summary: "Edited structured GraphQL variables",
          revision,
        },
        () => {
          const current = this.runtime.context.captureVisibleGQL()
          if (
            !current ||
            current.token !== token ||
            !this.runtime.context.matches("graphql-document", revision)
          )
            return false
          current.tab.document.request = original
          current.tab.document.isDirty = originalDirty
          return true
        }
      )
      return this.runtime.result("graphql-document", {
        updated: true,
        changedFields: ["variables"],
        draft: {
          dirty: gql.tab.document.isDirty,
          provenance: gql.tab.document.saveContext?.originLocation ?? "unsaved",
        },
      })
    } catch (error) {
      return this.runtime.failure(
        "INVALID_INPUT",
        error instanceof Error
          ? error.message
          : "Invalid GraphQL variables edit.",
        "graphql-document"
      )
    }
  }

  private async configureGraphQLAuth(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input)) {
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    }
    const parsed = configureRESTAuthParser.safeParse(input)
    if (!parsed.success) {
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const gql = this.runtime.visibleGQL()
    if ("ok" in gql) return gql
    if (
      !this.runtime.context.matches(
        "graphql-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
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
      this.runtime.activity.record({
        tool: "configure_graphql_auth",
        outcome: "changed",
        summary: `Configured GraphQL ${configuration.authType} authorization`,
        revision: this.runtime.context.revision("graphql-document"),
      })
      return this.runtime.result("graphql-document", {
        updated: true,
        changedFields: ["auth"],
        draft: {
          dirty: gql.tab.document.isDirty,
          provenance: gql.tab.document.saveContext?.originLocation ?? "unsaved",
        },
      })
    } catch (error) {
      return this.runtime.failure(
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
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = executeRESTRequestParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const gql = this.runtime.visibleGQL()
    if ("ok" in gql) return gql
    if (
      !this.runtime.context.matches(
        "graphql-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
        "STATE_CHANGED",
        "The GraphQL draft changed; inspect it again.",
        "graphql-document",
        true
      )
    }
    const consequential =
      action === "connect" || action === "execute" || action === "subscribe"
    const appContext = this.runtime.context.capture()
    const appContextRevision = this.runtime.context.revision("app-context")
    const dependencyRevision = this.runtime.context.revision("rest-document")
    const executeAction = async () => {
      try {
        if (action === "connect")
          await this.runtime.gqlExecution.connect(gql.tab, signal)
        else if (action === "disconnect") this.runtime.gqlExecution.disconnect()
        else if (action === "execute")
          await this.runtime.gqlExecution.executeConnected(
            gql.tab,
            null,
            signal
          )
        else if (action === "subscribe")
          this.runtime.gqlExecution.startSubscriptionConnected(gql.tab, signal)
        else this.runtime.gqlExecution.stopSubscription()
        this.runtime.activity.record({
          tool: `${action}_graphql`,
          outcome: action === "execute" ? "executed" : "changed",
          summary: `GraphQL ${action}`,
          revision: this.runtime.context.revision("graphql-document"),
        })
        return this.observation()
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof Error &&
            error.message.toLowerCase().includes("cancelled"))
        ) {
          return this.runtime.failure(
            "CANCELLED",
            "The GraphQL action was cancelled.",
            "graphql-document"
          )
        }
        return this.runtime.failure(
          "EXECUTION_FAILED",
          error instanceof Error ? error.message : "GraphQL action failed.",
          "graphql-document"
        )
      }
    }
    if (!consequential) return executeAction()
    return runWebMCPExecution({
      approval: this.runtime.approval,
      request: {
        action: `${action === "execute" ? "Execute" : action === "subscribe" ? "Start" : "Connect"} GraphQL`,
        method: "POST",
        target: this.runtime
          .redactor()
          .scrub(safeTarget(gql.tab.document.request.url), 256),
        environment: appContext.environment.name,
        workspace: appContext.workspace.type,
        grantKey: approvalIdentity({
          operation: "graphql",
          environmentScope: getSelectedEnvironmentType(),
          workspaceID: this.runtime.workspace.currentWorkspace.value,
          environmentID: getCurrentEnvironment().id,
          scope: action,
          revision: parsed.data.expectedRevision,
          dependencyRevision,
          target: gql.tab.document.request.url,
          action,
        }),
      },
      signal,
      capture: () => ({
        token: gql.token,
        revision: this.runtime.context.revision("graphql-document"),
        appContextRevision,
        dependencyRevision,
        environment: appContext.environment.name,
        workspace: appContext.workspace.type,
      }),
      revalidate: (snapshot) =>
        this.runtime.context.matches("graphql-document", snapshot.revision) &&
        this.runtime.context.matches(
          "app-context",
          snapshot.appContextRevision
        ) &&
        this.runtime.context.matches(
          "rest-document",
          snapshot.dependencyRevision
        ) &&
        this.runtime.context.captureVisibleGQL()?.token === snapshot.token &&
        this.runtime.context.capture().environment.name ===
          snapshot.environment &&
        this.runtime.context.capture().workspace.type === snapshot.workspace,
      denied: (cancelled) =>
        this.runtime.failure(
          cancelled ? "CANCELLED" : "APPROVAL_DENIED",
          cancelled
            ? "The action was cancelled."
            : "The user denied the action.",
          "graphql-document"
        ),
      stale: () =>
        this.runtime.failure(
          "STATE_CHANGED",
          "The GraphQL draft changed while approval was open.",
          "graphql-document",
          true
        ),
      error: (error) =>
        this.runtime.failure(
          "EXECUTION_FAILED",
          error instanceof Error ? error.message : "GraphQL action failed.",
          "graphql-document"
        ),
      execute: () => executeAction(),
    })
  }
}
