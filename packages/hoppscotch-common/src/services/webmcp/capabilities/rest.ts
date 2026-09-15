import { HoppRESTRequest } from "@hoppscotch/data"
import { cloneDeep } from "lodash-es"
import { Ref } from "vue"
import { RESTRequestAlreadyRunningError } from "~/services/rest-request-execution.service"
import { restHistoryStore } from "~/newstore/history"
import { getDefaultRESTRequest } from "~/helpers/rest/default"
import {
  getCurrentEnvironment,
  getSelectedEnvironmentType,
} from "~/newstore/environments"
import { HoppRequestDocument } from "~/helpers/rest/document"
import { HoppTab } from "~/services/tab"
import { approvalIdentity } from "../approval-scope"
import { applyJSONPointerOperations, diagnosticForError } from "../diagnostics"
import { runWebMCPExecution } from "../execution-lifecycle"
import { readSafeTextWindow } from "../payload-windows"
import { readRESTPayload } from "../projections"
import { projectRESTExchange } from "../projections"
import { configureRESTAuth, replaceRESTDraftFields } from "../rest-drafts"
import { VisibleRESTContext } from "../context"
import { safeTarget } from "./shared"
import { EnvironmentCapability } from "./environment"
import type { WebMCPRuntime } from "../runtime"
import {
  configureRESTAuthParser,
  editRESTRequestParser,
  editRESTScriptsParser,
  editRESTVariablesParser,
  emptyInputSchema,
  executeRESTRequestParser,
  editRESTBodyParser,
  readRESTScriptParser,
  configureRESTAuthInputSchema,
  editRESTRequestInputSchema,
  editRESTScriptsInputSchema,
  editRESTVariablesInputSchema,
  expectedRevisionSchema,
  editRESTBodyInputSchema,
  readRESTScriptInputSchema,
  readRESTPayloadInputSchema,
  readRESTPayloadParser,
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
import { RESTRequestPatch } from "../types"

export class RESTCapability {
  public constructor(private readonly runtime: WebMCPRuntime) {}

  public async observation() {
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    return this.runtime.result("rest-document", {
      responseRevision: this.runtime.context.revision("rest-response"),
      exchange: await projectRESTExchange(
        rest.tab.document,
        this.runtime.redactor(),
        this.runtime.interceptor
      ),
    })
  }

  private async editRESTRequest(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input)) {
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    }
    const parsed = editRESTRequestParser.safeParse(input)
    if (!parsed.success) {
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches(
        "rest-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
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
      return this.runtime.failure(
        "INVALID_INPUT",
        "The patch does not produce a valid REST request.",
        "rest-document"
      )
    }

    rest.tab.document.request = validated.value
    rest.tab.document.isDirty = true
    const changedFields = Object.keys(patch)
    const resultingRevision = this.runtime.context.revision("rest-document")
    const token = rest.token
    this.runtime.activity.record(
      {
        tool: "edit_rest_request",
        outcome: "changed",
        summary: `Changed REST ${changedFields.join(", ")}`.slice(0, 256),
        revision: resultingRevision,
      },
      () => {
        const current = this.runtime.context.captureVisibleREST()
        if (
          !current ||
          current.token !== token ||
          !this.runtime.context.matches("rest-document", resultingRevision)
        )
          return false
        current.tab.document.request = originalRequest
        current.tab.document.isDirty = originalDirty
        return true
      }
    )

    return this.runtime.result("rest-document", {
      updated: true,
      changedFields,
      draft: {
        dirty: rest.tab.document.isDirty,
        provenance: rest.tab.document.saveContext?.originLocation ?? "unsaved",
      },
    })
  }

  private async configureRESTAuth(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = configureRESTAuthParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches(
        "rest-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
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
      return this.runtime.failure(
        "INVALID_INPUT",
        error instanceof Error ? error.message : "Invalid authorization",
        "rest-document"
      )
    }
  }

  private async editRESTVariables(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = editRESTVariablesParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches(
        "rest-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
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
      return this.runtime.failure(
        "INVALID_INPUT",
        error instanceof Error ? error.message : "Invalid request variables",
        "rest-document"
      )
    }
  }

  private async editRESTScripts(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = editRESTScriptsParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches(
        "rest-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
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
      return this.runtime.failure(
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
          ...diagnosticForError(error, this.runtime.redactor(), {
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

  private async inspectRESTScripting() {
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    const sources = this.scriptSources(rest)
    return this.runtime.result("rest-document", {
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
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = readRESTScriptParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches(
        "rest-document",
        parsed.data.expectedRevision
      )
    )
      return this.runtime.failure(
        "STATE_CHANGED",
        "The REST draft changed; inspect it again.",
        "rest-document",
        true
      )
    const source = this.scriptSources(rest).find(
      ({ handle }) => handle === parsed.data.sourceHandle
    )
    if (!source)
      return this.runtime.failure(
        "INVALID_INPUT",
        "The script source handle is no longer available.",
        "rest-document"
      )
    return runWebMCPExecution({
      approval: this.runtime.approval,
      request: {
        action: "Allow script source read",
        method: "READ",
        target: source.handle,
        environment: this.runtime.context.capture().environment.name,
        workspace: this.runtime.context.capture().workspace.type,
        grantKey: approvalIdentity({
          operation: "read_rest_script",
          environmentScope: getSelectedEnvironmentType(),
          workspaceID: this.runtime.workspace.currentWorkspace.value,
          revision: parsed.data.expectedRevision,
          target: source.handle,
          details: {
            offset: parsed.data.offset,
            maxChars: parsed.data.maxChars,
          },
          allowSession: false,
        }),
        description:
          "An agent wants to read a bounded window of request script source. Script content can contain sensitive data.",
        allowSession: false,
      },
      signal,
      capture: () => ({
        source,
        revision: this.runtime.context.revision("rest-document"),
      }),
      revalidate: (snapshot) =>
        this.runtime.context.matches("rest-document", snapshot.revision) &&
        this.runtime.context.matches(
          "rest-document",
          parsed.data.expectedRevision
        ) &&
        this.scriptSources(rest).some(
          (candidate) => candidate.handle === snapshot.source.handle
        ),
      denied: (cancelled) => {
        this.runtime.activity.record({
          tool: "read_rest_script",
          outcome: cancelled ? "cancelled" : "denied",
          summary: `Script disclosure ${source.handle}`,
          revision: this.runtime.context.revision("rest-document"),
        })
        return this.runtime.failure(
          cancelled ? "CANCELLED" : "APPROVAL_DENIED",
          cancelled
            ? "The script disclosure was cancelled."
            : "The user denied script disclosure.",
          "rest-document"
        )
      },
      stale: () =>
        this.runtime.failure(
          "STATE_CHANGED",
          "The REST draft changed while approval was open.",
          "rest-document",
          true
        ),
      error: (error) =>
        this.runtime.failure(
          "EXECUTION_FAILED",
          error instanceof Error ? error.message : "Script disclosure failed.",
          "rest-document"
        ),
      execute: (snapshot) => {
        const window = readSafeTextWindow(
          snapshot.source.source,
          this.runtime.redactor(),
          parsed.data.offset,
          parsed.data.maxChars,
          "redacted-utf16"
        )
        this.runtime.activity.record({
          tool: "read_rest_script",
          outcome: "executed",
          summary: `Disclosed script window ${snapshot.source.handle}`,
          revision: this.runtime.context.revision("rest-document"),
        })
        return this.runtime.result("rest-document", {
          sourceHandle: snapshot.source.handle,
          offset: window.offset,
          text: window.text,
          totalChars: window.totalChars,
          nextOffset: window.nextOffset,
          truncated: window.truncated,
        })
      },
    })
  }

  private async editRESTBody(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = editRESTBodyParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches(
        "rest-document",
        parsed.data.expectedRevision
      )
    )
      return this.runtime.failure(
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
      return this.runtime.failure(
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
    const resultingRevision = this.runtime.context.revision("rest-document")
    const token = rest.token
    this.runtime.activity.record(
      {
        tool,
        outcome: "changed",
        summary: summary.slice(0, 256),
        revision: resultingRevision,
      },
      () => {
        const current = this.runtime.context.captureVisibleREST()
        if (
          !current ||
          current.token !== token ||
          !this.runtime.context.matches("rest-document", resultingRevision)
        )
          return false
        current.tab.document.request = originalRequest
        current.tab.document.isDirty = originalDirty
        return true
      }
    )
    return this.runtime.result("rest-document", {
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
    if (!this.runtime.validBoundary(input)) {
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    }
    const parsed = executeRESTRequestParser.safeParse(input)
    if (!parsed.success) {
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches(
        "rest-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
        "STATE_CHANGED",
        "The REST draft changed; inspect it again.",
        "rest-document",
        true
      )
    }

    const endpoint = rest.tab.document.request.endpoint
    const redactor = this.runtime.redactor()
    const target = redactor.scrub(safeTarget(endpoint), 512)
    const safeMethod = redactor.scrub(rest.tab.document.request.method, 32)
    const environment = this.runtime.context.capture().environment.name
    const workspace = this.runtime.context.capture().workspace.type
    // Authorization identity must not use the redacted display target. Bind
    // grants to the inspected draft and stable context, including method/query.
    const grantKey = approvalIdentity({
      operation: "execute_rest",
      environmentScope: getSelectedEnvironmentType(),
      workspaceID: this.runtime.workspace.currentWorkspace.value,
      environmentID: getCurrentEnvironment().id,
      revision: parsed.data.expectedRevision,
      target: endpoint,
      action: rest.tab.document.request.method,
      details: { query: endpoint },
    })
    return runWebMCPExecution({
      approval: this.runtime.approval,
      request: {
        action: "Execute REST request",
        method: safeMethod,
        target,
        environment,
        workspace,
        grantKey,
      },
      signal: signal,
      capture: () => ({
        token: rest.token,
        tabID: rest.tab.id,
        revision: parsed.data.expectedRevision,
      }),
      revalidate: (snapshot) => {
        const current = this.runtime.context.captureVisibleREST()
        return Boolean(
          current &&
          current.token === snapshot.token &&
          this.runtime.context.matches("rest-document", snapshot.revision)
        )
      },
      denied: (cancelled) => {
        this.runtime.activity.record({
          tool: "execute_rest_request",
          outcome: cancelled ? "cancelled" : "denied",
          summary: `${safeMethod} ${target}`.slice(0, 256),
          revision: this.runtime.context.revision("rest-document"),
        })
        return this.runtime.failure(
          cancelled ? "CANCELLED" : "APPROVAL_DENIED",
          cancelled
            ? "The execution was cancelled."
            : "The user denied execution.",
          "rest-document"
        )
      },
      stale: () =>
        this.runtime.failure(
          "STATE_CHANGED",
          "The REST draft changed while approval was open.",
          "rest-document",
          true
        ),
      execute: async () => {
        const tabRef = this.runtime.restTabs.getTabRef(rest.tab.id) as Ref<
          HoppTab<HoppRequestDocument>
        >
        const outcome = await this.runtime.execution.send(tabRef, {
          initiator: "webmcp",
          signal: signal,
        })
        const activityBase = {
          tool: "execute_rest_request",
          summary: `${safeMethod} ${target}`.slice(0, 256),
          revision: this.runtime.context.revision("rest-document"),
        }
        if (outcome.type === "cancelled") {
          this.runtime.activity.record({
            ...activityBase,
            outcome: "cancelled",
          })
          return this.runtime.failure(
            "CANCELLED",
            "The REST execution was cancelled.",
            "rest-document"
          )
        }
        if (outcome.type === "script_failed") {
          this.runtime.activity.record({ ...activityBase, outcome: "failed" })
          return this.runtime.failure(
            "SCRIPT_FAILED",
            "A request script failed.",
            "rest-document"
          )
        }
        if (outcome.type === "failed") {
          this.runtime.activity.record({ ...activityBase, outcome: "failed" })
          return this.runtime.failure(
            "EXECUTION_FAILED",
            outcome.error.message,
            "rest-document"
          )
        }
        this.runtime.activity.record({ ...activityBase, outcome: "executed" })
        const exchange = await projectRESTExchange(
          rest.tab.document,
          this.runtime.redactor(),
          this.runtime.interceptor
        )
        return this.runtime.result("rest-document", {
          responseRevision: this.runtime.context.revision("rest-response"),
          isStillCurrent:
            this.runtime.context.captureVisibleREST()?.token === rest.token,
          exchange,
        })
      },
      error: (error) => {
        if (error instanceof RESTRequestAlreadyRunningError) {
          return this.runtime.failure(
            "REQUEST_ALREADY_RUNNING",
            error.message,
            "rest-document",
            true
          )
        }
        return this.runtime.failure(
          "EXECUTION_FAILED",
          error instanceof Error ? error.message : "REST execution failed.",
          "rest-document"
        )
      },
    })
  }

  public async register(signal: AbortSignal) {
    await Promise.all([
      new EnvironmentCapability(this.runtime).register(signal),
      this.runtime.adapter.register(
        {
          name: "inspect_rest_exchange",
          title: "Inspect current REST exchange",
          description:
            "Inspect the visible REST request and latest response as a bounded, redacted summary with draft state, environment dependencies, interceptor, diagnostics, and test outcomes.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (
              !this.runtime.validBoundary(input) ||
              Object.keys(input).length !== 0
            ) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            }
            return this.observation()
          },
        },
        signal
      ),
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
        {
          name: "inspect_rest_scripting",
          title: "Inspect REST scripting",
          description:
            "Inspect visible request and inherited JavaScript script-chain metadata and static diagnostics without disclosing source text. Use get_skill({ name: 'scripting-sandbox' }) for sandbox API reference.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.runtime.validBoundary(input) && Object.keys(input).length === 0
              ? this.inspectRESTScripting()
              : this.runtime.failure(
                  "INVALID_INPUT",
                  "This tool accepts an empty object only."
                ),
        },
        signal
      ),
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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
      this.runtime.adapter.register(
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

      this.runtime.adapter.register(
        {
          name: "read_rest_payload",
          title: "Read REST payload window",
          description:
            "Read a bounded, revision-bound window from the visible REST request or response as redacted text or binary and file metadata.",
          inputSchema: readRESTPayloadInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (!this.runtime.validBoundary(input)) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = readRESTPayloadParser.safeParse(input)
            if (!parsed.success) {
              return this.runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const rest = this.runtime.visibleREST()
            if ("ok" in rest) return rest
            const scope =
              parsed.data.source === "request"
                ? "rest-document"
                : "rest-response"
            if (
              !this.runtime.context.matches(scope, parsed.data.expectedRevision)
            ) {
              return this.runtime.failure(
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
                this.runtime.redactor()
              )
              return this.runtime.result(scope, { payload })
            } catch (error) {
              return this.runtime.failure(
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
      this.runtime.adapter.register(
        {
          name: "list_tabs",
          title: "List open tabs",
          description:
            "List all open editor tabs for the current mode with their IDs, titles, dirty states, and active selection.",
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
            const tabs = this.runtime.restTabs.getTabs().map((tab) => ({
              id: tab.id,
              title: redactor.scrub(
                tab.document.type === "request"
                  ? tab.document.request.name
                  : tab.document.type,
                64
              ),
              type: tab.document.type,
              isDirty: tab.document.isDirty,
              isActive: tab.id === this.runtime.restTabs.currentTabID.value,
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
            return this.runtime.result("rest-document", { tabs })
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "switch_tab",
          title: "Switch active tab",
          description: "Switch to a specific open tab by tab ID.",
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
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "rest-document",
                true
              )
            }
            const tab = this.runtime.restTabs
              .getTabs()
              .find((t) => t.id === parsed.data.tabID)
            if (!tab) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The requested tab was not found.",
                "rest-document"
              )
            }
            this.runtime.restTabs.setActiveTab(parsed.data.tabID)
            this.runtime.activity.record({
              tool: "switch_tab",
              outcome: "changed",
              summary: `Switched active tab to ${parsed.data.tabID}`,
              revision: this.runtime.context.revision("rest-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "create_tab",
          title: "Create new tab",
          description:
            "Open a new blank request tab in the editor and set it as active.",
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
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "rest-document",
                true
              )
            }
            const req = getDefaultRESTRequest()
            if (parsed.data.name) req.name = parsed.data.name
            const newTab = this.runtime.restTabs.createNewTab(
              {
                type: "request",
                request: req,
                isDirty: false,
                optionTabPreference: "params",
              },
              true
            )
            this.runtime.activity.record({
              tool: "create_tab",
              outcome: "changed",
              summary: `Created new tab ${newTab.id}`,
              revision: this.runtime.context.revision("rest-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "close_tab",
          title: "Close tab",
          description:
            "Close an open tab by ID. If the tab has unsaved changes, force must be set to true.",
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
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The tab state changed; inspect it again.",
                "rest-document",
                true
              )
            }
            const tab = this.runtime.restTabs
              .getTabs()
              .find((t) => t.id === parsed.data.tabID)
            if (!tab) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "The requested tab was not found.",
                "rest-document"
              )
            }
            if (this.runtime.restTabs.getTabs().length <= 1) {
              return this.runtime.failure(
                "INVALID_INPUT",
                "Cannot close the only open tab.",
                "rest-document"
              )
            }
            if (tab.document.isDirty && !parsed.data.force) {
              return this.runtime.failure(
                "DIRTY_TAB_UNSAVED_CHANGES",
                "The tab has unsaved changes. Save it to a collection or pass force: true to discard changes.",
                "rest-document"
              )
            }
            this.runtime.restTabs.closeTab(parsed.data.tabID)
            this.runtime.activity.record({
              tool: "close_tab",
              outcome: "changed",
              summary: `Closed tab ${parsed.data.tabID}`,
              revision: this.runtime.context.revision("rest-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
      this.runtime.adapter.register(
        {
          name: "list_history",
          title: "List execution history",
          description:
            "List recent request history entries for the current mode.",
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
            const historyState = restHistoryStore.value.state
            const slice = historyState.slice(
              parsed.data.offset,
              parsed.data.offset + parsed.data.limit
            )
            const redactor = this.runtime.redactor()
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
            return this.runtime.result("rest-document", {
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
          name: "load_history_entry",
          title: "Load history entry into tab",
          description:
            "Load a request from execution history into an active or new tab.",
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
                "rest-document",
                parsed.data.expectedRevision
              )
            ) {
              return this.runtime.failure(
                "STATE_CHANGED",
                "The editor state changed; inspect it again.",
                "rest-document",
                true
              )
            }
            const historyEntry = restHistoryStore.value.state[parsed.data.index]
            if (!historyEntry) {
              return this.runtime.failure(
                "INVALID_INPUT",
                `History entry at index ${parsed.data.index} not found.`,
                "rest-document"
              )
            }
            const reqToLoad = cloneDeep(historyEntry.request)
            if (parsed.data.targetTab === "new") {
              this.runtime.restTabs.createNewTab(
                {
                  type: "request",
                  request: reqToLoad,
                  isDirty: false,
                  optionTabPreference: "params",
                },
                true
              )
            } else {
              const rest = this.runtime.visibleREST()
              if ("ok" in rest) return rest
              if (rest.tab.document.isDirty) {
                return this.runtime.failure(
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
            this.runtime.activity.record({
              tool: "load_history_entry",
              outcome: "changed",
              summary: `Loaded history entry ${parsed.data.index}`,
              revision: this.runtime.context.revision("rest-document"),
            })
            return this.observation()
          },
        },
        signal
      ),
    ])
  }
}
