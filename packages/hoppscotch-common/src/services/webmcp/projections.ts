import { HoppRESTRequest } from "@hoppscotch/data"

import { HoppRequestDocument } from "~/helpers/rest/document"
import {
  HoppRESTFailureResponse,
  HoppRESTResponse,
  HoppRESTSuccessResponse,
} from "~/helpers/types/HoppRESTResponse"
import { HoppTestData, HoppTestResult } from "~/helpers/types/HoppTestResult"
import {
  AggregateEnvironment,
  getAggregateEnvsWithCurrentValue,
  getCurrentEnvironment,
} from "~/newstore/environments"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { KernelInterceptorService } from "~/services/kernel-interceptor.service"
import { getEffectiveVariablesForRequest } from "~/helpers/utils/environments"

const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i
const SENSITIVE_KEY = /(token|secret|password|api[-_]?key|signature|cookie)/i
const TEXT_MIME = /^(text\/|application\/(json|[^;]+\+json|xml|[^;]+\+xml))/i

export class SecretRedactor {
  private readonly values: string[]

  constructor(secretService: SecretEnvironmentService) {
    const values = new Set<string>()
    for (const variables of secretService.secretEnvironments.values()) {
      for (const variable of variables) {
        if (variable.value) values.add(variable.value)
        if (variable.initialValue) values.add(variable.initialValue)
      }
    }
    this.values = [...values].sort((a, b) => b.length - a.length)
  }

  public scrub(value: string, maxChars = 8192) {
    let result = value
    for (const secret of this.values)
      result = result.split(secret).join("[REDACTED]")
    return result.slice(0, maxChars)
  }
}

const digest = async (bytes: Uint8Array) => {
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
  const hash = await crypto.subtle.digest("SHA-256", source)
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

const encode = (text: string) => new TextEncoder().encode(text)

const safeEndpoint = (endpoint: string, redactor: SecretRedactor) => {
  const scrubbed = redactor.scrub(endpoint, 8192)
  try {
    const parsed = new URL(scrubbed)
    if (parsed.username) parsed.username = "[REDACTED]"
    if (parsed.password) parsed.password = "[REDACTED]"
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_KEY.test(key)) parsed.searchParams.set(key, "[REDACTED]")
    }
    return parsed.toString()
  } catch {
    return scrubbed
  }
}

const referencedVariables = (
  request: HoppRESTRequest,
  inherited: HoppRequestDocument["inheritedProperties"],
  redactor: SecretRedactor
) => {
  const serialized = JSON.stringify(request)
  const names = new Set(
    [...serialized.matchAll(/<<([^<>]+)>>/g)].map((match) => match[1])
  )
  const effective = getEffectiveVariablesForRequest(
    request.requestVariables,
    inherited?.variables,
    getAggregateEnvsWithCurrentValue(),
    false
  )

  return [...names].slice(0, 6).map((name) => {
    const variable = effective.find((candidate) => candidate.key === name)
    return {
      name: redactor.scrub(name, 64),
      source: redactor.scrub(variable?.sourceEnv ?? "unresolved", 64),
      secret: variable?.secret ?? false,
      available: Boolean(variable?.currentValue || variable?.initialValue),
    }
  })
}

const projectBody = async (
  request: HoppRESTRequest,
  redactor: SecretRedactor
) => {
  const body = request.body
  if (body.contentType === null) return { contentType: null, length: 0 }
  if (body.contentType === "application/octet-stream") {
    const file = body.body
    return {
      contentType: body.contentType,
      kind: "binary",
      name: file?.name ? redactor.scrub(file.name, 256) : undefined,
      size: file?.size ?? 0,
      digest: file
        ? await digest(new Uint8Array(await file.arrayBuffer()))
        : undefined,
    }
  }
  if (body.contentType === "multipart/form-data") {
    return {
      contentType: body.contentType,
      kind: "multipart",
      parts: await Promise.all(
        body.body.slice(0, 6).map(async (part, index) => {
          if (!part.isFile) {
            return {
              index,
              key: redactor.scrub(part.key, 64),
              active: part.active,
              kind: "text",
              length: part.value.length,
              preview: redactor.scrub(part.value, 96),
            }
          }
          const files = part.value as Array<Blob | null>
          return {
            index,
            key: redactor.scrub(part.key, 64),
            active: part.active,
            kind: "file",
            files: files.slice(0, 10).map((file) =>
              file
                ? {
                    name:
                      file instanceof File
                        ? redactor.scrub(file.name, 256)
                        : undefined,
                    type: redactor.scrub(file.type, 128),
                    size: file.size,
                  }
                : { size: 0 }
            ),
          }
        })
      ),
      truncated: body.body.length > 6,
    }
  }

  const bytes = encode(body.body)
  return {
    contentType: body.contentType,
    kind: "text",
    length: body.body.length,
    preview: redactor.scrub(body.body, 768),
    truncated: body.body.length > 768,
    digest: await digest(bytes),
  }
}

const projectResponse = async (
  response: HoppRESTResponse | null | undefined,
  redactor: SecretRedactor
) => {
  if (!response) return { state: "empty" }
  if (response.type === "loading") return { state: "loading" }
  if (response.type === "success" || response.type === "failure") {
    const httpResponse = response as
      | HoppRESTSuccessResponse
      | HoppRESTFailureResponse
    const mime = httpResponse.headers.find(
      ({ key }) => key.toLowerCase() === "content-type"
    )?.value
    const bytes = new Uint8Array(httpResponse.body)
    const textual = mime ? TEXT_MIME.test(mime) : true
    const text = textual ? new TextDecoder().decode(bytes.slice(0, 3072)) : ""
    return {
      state: response.type,
      status: httpResponse.statusCode,
      statusText: redactor.scrub(httpResponse.statusText, 128),
      durationMs: httpResponse.meta.responseDuration,
      sizeBytes: httpResponse.meta.responseSize,
      mimeType: mime ? redactor.scrub(mime, 128) : undefined,
      headers: httpResponse.headers.slice(0, 6).map(({ key, value }) => ({
        key: redactor.scrub(key, 64),
        value: SENSITIVE_HEADER.test(key)
          ? "[REDACTED]"
          : redactor.scrub(value, 64),
      })),
      headersTruncated: httpResponse.headers.length > 6,
      body: textual
        ? {
            preview: redactor.scrub(text, 768),
            byteLength: bytes.byteLength,
            truncated: bytes.byteLength > 3072 || text.length > 768,
            digest: await digest(bytes),
          }
        : { length: bytes.byteLength, digest: await digest(bytes) },
    }
  }

  const error = "error" in response ? response.error : "Request failed"
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "The request failed in the selected interceptor"
  return { state: response.type, error: redactor.scrub(message, 512) }
}

const flattenTests = (tests: HoppTestData[]): HoppTestData[] =>
  tests.flatMap((test) => [test, ...flattenTests(test.tests)])

const projectTests = (
  tests: HoppTestResult | null | undefined,
  redactor: SecretRedactor
) => {
  if (!tests) return { state: "empty" }
  const allResults = [
    ...tests.expectResults,
    ...flattenTests(tests.tests).flatMap((test) => test.expectResults),
  ]
  return {
    state: tests.scriptError ? "script-error" : "complete",
    passed: allResults.filter(({ status }) => status === "pass").length,
    failed: allResults.filter(({ status }) => status !== "pass").length,
    failures: allResults
      .filter(({ status }) => status !== "pass")
      .slice(0, 5)
      .map(({ message }) => redactor.scrub(message, 128)),
  }
}

const diagnostics = (
  request: HoppRESTRequest,
  response: HoppRESTResponse | null | undefined,
  variables: ReturnType<typeof referencedVariables>,
  interceptor: KernelInterceptorService
) => {
  const results: Array<{
    code: string
    severity: "warning" | "error"
    location: string
    message: string
    documentation?: string
  }> = []
  const capabilities = interceptor.current.value?.capabilities
  if (
    /(localhost|127\.0\.0\.1)/.test(request.endpoint) &&
    capabilities &&
    !capabilities.advanced.has("localaccess")
  ) {
    results.push({
      code: "LOCAL_ACCESS_UNSUPPORTED",
      severity: "warning",
      location: "url",
      message: "The selected interceptor cannot access local addresses.",
    })
  }
  if (
    (request.auth.authType === "digest" || request.auth.authType === "hawk") &&
    capabilities &&
    !capabilities.auth.has(request.auth.authType)
  ) {
    results.push({
      code: `${request.auth.authType.toUpperCase()}_AUTH_UNSUPPORTED`,
      severity: "warning",
      location: "auth",
      message: `The selected interceptor does not support ${request.auth.authType} authentication.`,
      documentation:
        "https://docs.hoppscotch.io/documentation/features/inspections",
    })
  }
  if (
    request.headers.some(({ key }) => key.toLowerCase().includes("cookie")) &&
    capabilities &&
    !capabilities.advanced.has("cookies")
  ) {
    results.push({
      code: "COOKIE_HEADER_UNSUPPORTED",
      severity: "warning",
      location: "header",
      message: "The selected interceptor does not support cookie headers.",
    })
  }
  if (
    request.body.contentType === "application/octet-stream" &&
    capabilities &&
    !capabilities.content.has("binary")
  ) {
    results.push({
      code: "BINARY_BODY_UNSUPPORTED",
      severity: "warning",
      location: "body",
      message:
        "The selected interceptor does not support binary request bodies.",
    })
  }
  const scripts = `${request.preRequestScript}\n${request.testScript}`
  if (
    /(pm\.sendRequest|hopp\.fetch|(?<!hopp\.)fetch)\s*\(/i.test(scripts) &&
    ["extension", "proxy"].includes(interceptor.getCurrentId() ?? "")
  ) {
    results.push({
      code: "SCRIPTING_INTERCEPTOR_UNSUPPORTED",
      severity: "warning",
      location: "scripts",
      message:
        "The selected interceptor may not support HTTP calls made by request scripts.",
    })
  }
  for (const variable of variables) {
    if (!variable.available) {
      results.push({
        code: "ENVIRONMENT_VALUE_UNAVAILABLE",
        severity: "warning",
        location: "request",
        message: `The referenced variable <<${variable.name}>> has no available value.`,
      })
    }
  }
  if (
    response?.type === "success" &&
    [401, 404].includes(response.statusCode)
  ) {
    results.push({
      code: `HTTP_${response.statusCode}`,
      severity: "warning",
      location: "response",
      message:
        response.statusCode === 401
          ? "The server rejected the request credentials."
          : "The requested endpoint was not found.",
      documentation:
        "https://docs.hoppscotch.io/documentation/features/inspections",
    })
  }
  if (response?.type === "network_fail" && !navigator.onLine) {
    results.push({
      code: "BROWSER_OFFLINE",
      severity: "error",
      location: "response",
      message: "The browser is offline.",
    })
  }
  return results.slice(0, 4)
}

export const projectRESTExchange = async (
  document: HoppRequestDocument,
  redactor: SecretRedactor,
  interceptor: KernelInterceptorService
) => {
  const request = document.request
  const variables = referencedVariables(
    request,
    document.inheritedProperties,
    redactor
  )
  return {
    draft: {
      dirty: document.isDirty,
      provenance: document.saveContext?.originLocation ?? "unsaved",
    },
    request: {
      method: redactor.scrub(request.method, 32),
      endpoint: safeEndpoint(request.endpoint, redactor),
      params: request.params.slice(0, 6).map(({ key, value, active }) => ({
        key: redactor.scrub(key, 64),
        value: SENSITIVE_KEY.test(key)
          ? "[REDACTED]"
          : redactor.scrub(value, 64),
        active,
      })),
      paramsTruncated: request.params.length > 6,
      headers: request.headers.slice(0, 6).map(({ key, value, active }) => ({
        key: redactor.scrub(key, 64),
        value: SENSITIVE_HEADER.test(key)
          ? "[REDACTED]"
          : redactor.scrub(value, 64),
        active,
      })),
      headersTruncated: request.headers.length > 6,
      auth: { type: request.auth.authType, active: request.auth.authActive },
      body: await projectBody(request, redactor),
    },
    environment: {
      name: redactor.scrub(getCurrentEnvironment().name, 128),
      referencedVariables: variables,
    },
    execution: { interceptor: interceptor.getCurrentId() },
    response: await projectResponse(document.response, redactor),
    tests: projectTests(document.testResults, redactor),
    diagnostics: diagnostics(
      request,
      document.response,
      variables,
      interceptor
    ),
  }
}

export const readRESTPayload = async (
  document: HoppRequestDocument,
  source: "request" | "response",
  offset: number,
  maxChars: number,
  partIndex: number | undefined,
  redactor: SecretRedactor
) => {
  let text: string | null = null
  let mimeType: string | null = null
  let byteLength = 0

  if (source === "request") {
    const body = document.request.body
    mimeType = body.contentType
    if (body.contentType === "multipart/form-data") {
      if (partIndex === undefined)
        throw new Error("partIndex is required for multipart bodies")
      const part = body.body[partIndex]
      if (!part) throw new Error("Multipart part does not exist")
      if (part.isFile) {
        const files = part.value as Array<Blob | null>
        return {
          source,
          partIndex,
          mimeType: redactor.scrub(
            part.contentType ?? "application/octet-stream",
            128
          ),
          kind: "file",
          files: files.map((file) =>
            file
              ? {
                  name:
                    file instanceof File
                      ? redactor.scrub(file.name, 256)
                      : undefined,
                  type: redactor.scrub(file.type, 128),
                  size: file.size,
                }
              : { size: 0 }
          ),
        }
      }
      text = part.value
      mimeType = part.contentType ?? "text/plain"
    } else if (body.contentType === "application/octet-stream") {
      const file = body.body
      return {
        source,
        mimeType: body.contentType,
        kind: "binary",
        name: file?.name ? redactor.scrub(file.name, 256) : undefined,
        size: file?.size ?? 0,
        digest: file
          ? await digest(new Uint8Array(await file.arrayBuffer()))
          : undefined,
      }
    } else if (body.contentType && typeof body.body === "string") {
      text = body.body
    }
  } else {
    const response = document.response
    if (
      !response ||
      (response.type !== "success" && response.type !== "failure")
    ) {
      throw new Error("The current response has no readable payload")
    }
    const httpResponse = response as
      | HoppRESTSuccessResponse
      | HoppRESTFailureResponse
    const bytes = new Uint8Array(httpResponse.body)
    byteLength = bytes.byteLength
    mimeType =
      httpResponse.headers.find(
        ({ key }) => key.toLowerCase() === "content-type"
      )?.value ?? "text/plain"
    if (!TEXT_MIME.test(mimeType as string)) {
      return {
        source,
        mimeType: redactor.scrub(mimeType as string, 128),
        kind: "binary",
        size: byteLength,
        digest: await digest(bytes),
      }
    }
    const responseWindow = bytes.slice(offset, offset + maxChars * 4)
    const responseText = new TextDecoder().decode(responseWindow)
    return {
      source,
      mimeType: redactor.scrub(mimeType as string, 128),
      kind: "text",
      offset,
      offsetUnit: "byte",
      text: redactor.scrub(responseText, maxChars),
      windowByteLength: responseWindow.byteLength,
      nextOffset: offset + responseWindow.byteLength,
      byteLength,
      truncated: offset + responseWindow.byteLength < byteLength,
      digest: await digest(bytes),
    }
  }

  if (text === null)
    throw new Error("The current request has no readable payload")
  const bytes = encode(text)
  const window = redactor.scrub(text.slice(offset, offset + maxChars), maxChars)
  return {
    source,
    partIndex,
    mimeType: mimeType ? redactor.scrub(mimeType, 128) : null,
    kind: "text",
    offset,
    offsetUnit: "character",
    text: window,
    nextOffset: offset + Math.min(maxChars, Math.max(0, text.length - offset)),
    length: text.length,
    byteLength: byteLength || bytes.byteLength,
    truncated: offset + maxChars < text.length,
    digest: await digest(bytes),
  }
}

export const effectiveEnvironmentVariables = (
  request: HoppRESTRequest,
  document: HoppRequestDocument
): AggregateEnvironment[] =>
  getEffectiveVariablesForRequest(
    request.requestVariables,
    document.inheritedProperties?.variables,
    getAggregateEnvsWithCurrentValue(),
    false
  )
