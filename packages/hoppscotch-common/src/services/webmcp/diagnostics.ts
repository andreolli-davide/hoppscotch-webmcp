import { SecretRedactor } from "./projections"
import { WebMCPDiagnostic, WebMCPErrorCode } from "./types"

const MAX_MESSAGE_CHARS = 256

export const diagnosticForError = (
  error: unknown,
  redactor: SecretRedactor,
  options: {
    code?: string
    phase?: WebMCPDiagnostic["phase"]
    location?: string
    sourceHandle?: string
  } = {}
): WebMCPDiagnostic => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "An unexpected operation failed."
  return {
    code: options.code ?? "RUNTIME_FAILURE",
    severity: "error",
    phase: options.phase ?? "execution",
    message: redactor.scrub(message, MAX_MESSAGE_CHARS),
    location: options.location,
    sourceHandle: options.sourceHandle,
    untrustedContent: true,
  }
}

export const diagnosticForFailure = (
  code: WebMCPErrorCode,
  message: string,
  redactor: SecretRedactor
): WebMCPDiagnostic => ({
  code,
  severity:
    code === "STATE_CHANGED" || code === "CANCELLED" ? "warning" : "error",
  phase:
    code === "INVALID_INPUT" || code === "STATE_CHANGED"
      ? "validation"
      : code === "SCRIPT_FAILED"
        ? "script"
        : "execution",
  message: redactor.scrub(message, MAX_MESSAGE_CHARS),
  untrustedContent: true,
})

/** JSON Pointer operations deliberately work only on JSON data, never prototypes. */
export const applyJSONPointerOperations = (
  document: unknown,
  operations: Array<{
    op: "add" | "replace" | "remove"
    path: string
    value?: unknown
  }>
) => {
  const value = structuredClone(document)
  const decode = (segment: string) =>
    segment.replace(/~1/g, "/").replace(/~0/g, "~")
  for (const operation of operations) {
    if (!operation.path.startsWith("/"))
      throw new Error("JSON Pointer paths must start with '/'.")
    if (operation.path === "/")
      throw new Error("Replacing the document requires replace_document.")
    const segments = operation.path.slice(1).split("/").map(decode)
    if (
      segments.some(
        (segment) =>
          segment === "__proto__" ||
          segment === "constructor" ||
          segment === "prototype"
      )
    )
      throw new Error("Unsafe JSON Pointer path.")
    if (segments.length === 0)
      throw new Error("Replacing the document requires replace_document.")
    let target: Record<string, unknown> | unknown[] = value as Record<
      string,
      unknown
    >
    for (const segment of segments.slice(0, -1)) {
      if (target === null || typeof target !== "object" || !(segment in target))
        throw new Error("JSON Pointer path does not exist.")
      target = target[segment as keyof typeof target] as
        | Record<string, unknown>
        | unknown[]
    }
    const key = segments.at(-1)!
    if (Array.isArray(target)) {
      if (key !== "-" && !/^(0|[1-9]\d*)$/.test(key))
        throw new Error("Invalid JSON Pointer array index.")
      const index = key === "-" ? target.length : Number(key)
      if (!Number.isInteger(index) || index < 0 || index > target.length)
        throw new Error("Invalid JSON Pointer array index.")
      if (operation.op === "add") target.splice(index, 0, operation.value)
      else if (operation.op === "replace") {
        if (index >= target.length)
          throw new Error("JSON Pointer path does not exist.")
        target[index] = operation.value
      } else {
        if (index >= target.length)
          throw new Error("JSON Pointer path does not exist.")
        target.splice(index, 1)
      }
    } else {
      if (target === null || typeof target !== "object")
        throw new Error("JSON Pointer target is not an object.")
      if (operation.op === "remove") {
        if (!(key in target))
          throw new Error("JSON Pointer path does not exist.")
        delete target[key]
      } else {
        if (operation.op === "replace" && !(key in target))
          throw new Error("JSON Pointer path does not exist.")
        target[key] = operation.value
      }
    }
  }
  return value
}
