import { SecretEnvironmentService } from "~/services/secret-environment.service"

/** Redacts known secret values while preserving source offsets when requested. */
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

  private spans(value: string) {
    const spans: Array<{ start: number; end: number }> = []
    for (const secret of this.values) {
      let start = value.indexOf(secret)
      while (start !== -1) {
        spans.push({ start, end: start + secret.length })
        start = value.indexOf(secret, start + 1)
      }
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end)
    const merged: Array<{ start: number; end: number }> = []
    for (const span of spans) {
      const previous = merged[merged.length - 1]
      if (previous && span.start <= previous.end)
        previous.end = Math.max(previous.end, span.end)
      else merged.push({ ...span })
    }
    return merged
  }

  public mask(value: string, byteOffsets = false) {
    const merged = this.spans(value)
    let result = ""
    let cursor = 0
    for (const span of merged) {
      result += value.slice(cursor, span.start)
      const secret = value.slice(span.start, span.end)
      result += "*".repeat(
        byteOffsets ? new TextEncoder().encode(secret).length : secret.length
      )
      cursor = span.end
    }
    return result + value.slice(cursor)
  }

  public scrub(value: string, maxChars = 8192) {
    const spans = this.spans(value)
    let result = ""
    let cursor = 0
    for (const span of spans) {
      result += value.slice(cursor, span.start) + "[REDACTED]"
      cursor = span.end
    }
    return (result + value.slice(cursor)).slice(0, maxChars)
  }
}
