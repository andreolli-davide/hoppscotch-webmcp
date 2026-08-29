export const WEBMCP_PROTOCOL_VERSION = "hoppscotch.webmcp.v1" as const

export type WebMCPRevisionScope =
  | "app-context"
  | "rest-document"
  | "rest-response"
  | "graphql-document"
  | "graphql-response"
  | "realtime-session"

export type WebMCPErrorCode =
  | "WEBMCP_DISABLED"
  | "NO_ACTIVE_REST_REQUEST"
  | "NO_ACTIVE_GRAPHQL_REQUEST"
  | "NO_ACTIVE_REALTIME_SESSION"
  | "STATE_CHANGED"
  | "INVALID_INPUT"
  | "ENVIRONMENT_NOT_FOUND"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "REQUEST_ALREADY_RUNNING"
  | "APPROVAL_DENIED"
  | "CANCELLED"
  | "SCRIPT_FAILED"
  | "EXECUTION_FAILED"

export type ActiveAppContextDTO = {
  surface: "rest" | "graphql" | "realtime" | "other"
  mode: string
  workspace: {
    type: "personal" | "team"
    name?: string
    role?: string | null
  }
  environment: {
    name: string
    scope: "none" | "personal" | "team"
  }
  activeDocument?: {
    token: string
    kind: "request" | "graphql" | "realtime"
    dirty: boolean
  }
  dirtyDocumentCount: number
  capabilityPacks: string[]
}

type ResultBase = {
  protocolVersion: typeof WEBMCP_PROTOCOL_VERSION
  appContext: ActiveAppContextDTO
  revisionScope: WebMCPRevisionScope
  revision: string
}

export type WebMCPToolSuccess<T extends object> = ResultBase &
  T & {
    ok: true
  }

export type WebMCPToolFailure = ResultBase & {
  ok: false
  error: {
    code: WebMCPErrorCode
    message: string
    retryable: boolean
  }
}

export type WebMCPToolResult<T extends object> =
  | WebMCPToolSuccess<T>
  | WebMCPToolFailure

export type RESTRequestPatch = {
  method?:
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS"
    | "CONNECT"
    | "TRACE"
    | "CUSTOM"
  endpoint?: string
  params?: Array<{ key: string; value: string; active: boolean }>
  headers?: Array<{ key: string; value: string; active: boolean }>
  body?:
    | { contentType: null; body: null }
    | {
        contentType:
          | "application/json"
          | "application/ld+json"
          | "application/hal+json"
          | "application/vnd.api+json"
          | "application/xml"
          | "text/xml"
          | "application/x-www-form-urlencoded"
          | "text/html"
          | "text/plain"
        body: string
      }
}

export type RESTPayloadSource = "request" | "response"

export type WebMCPActivityEntry = {
  id: string
  timestamp: number
  tool: string
  outcome: "changed" | "executed" | "denied" | "failed" | "cancelled"
  summary: string
  revision: string
  canUndo: boolean
}
