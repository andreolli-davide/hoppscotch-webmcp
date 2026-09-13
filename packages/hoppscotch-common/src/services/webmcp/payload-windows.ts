import { SecretRedactor } from "./redaction"

export type TextWindow = {
  text: string
  offset: number
  totalChars: number
  nextOffset: number
  truncated: boolean
}

/** Select a bounded window after redaction in the same character coordinate space. */
export const readTextWindow = (
  text: string,
  offset: number,
  maxChars: number
): TextWindow => {
  const start = Math.min(Math.max(0, offset), text.length)
  const end = Math.min(start + maxChars, text.length)
  return {
    text: text.slice(start, end),
    offset: start,
    totalChars: text.length,
    nextOffset: end,
    truncated: end < text.length,
  }
}

export const readByteWindow = (
  bytes: Uint8Array,
  offset: number,
  maxChars: number
) => {
  let start = Math.min(Math.max(0, offset), bytes.length)
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  })
  // Validate the complete source before taking a bounded prefix. A valid
  // codepoint may straddle the prefix boundary, while malformed input must
  // still be rejected explicitly.
  decoder.decode(bytes)
  let end = Math.min(bytes.length, start + maxChars * 4)
  let decoded: string
  while (true) {
    try {
      decoded = decoder.decode(bytes.subarray(start, end))
      break
    } catch (error) {
      if (end <= start) throw error
      end--
    }
  }
  const window = Array.from(decoded).slice(0, maxChars).join("")
  const windowByteLength = new TextEncoder().encode(window).byteLength
  const nextOffset = Math.min(start + windowByteLength, bytes.length)
  return {
    text: window,
    offset: start,
    totalBytes: bytes.length,
    windowByteLength,
    nextOffset,
    truncated: nextOffset < bytes.length,
  }
}

export type SafeTextWindowMode = "masked-utf16" | "redacted-utf16"

export const readSafeTextWindow = (
  raw: string,
  redactor: SecretRedactor,
  offset: number,
  maxChars: number,
  mode: SafeTextWindowMode = "redacted-utf16"
) =>
  readTextWindow(
    mode === "masked-utf16"
      ? redactor.mask(raw)
      : redactor.scrub(raw, Infinity),
    offset,
    maxChars
  )

export const readSafeByteWindow = (
  raw: Uint8Array,
  redactor: SecretRedactor,
  offset: number,
  maxChars: number
) => {
  const decoded = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(raw)
  return readByteWindow(
    new TextEncoder().encode(redactor.mask(decoded, true)),
    offset,
    maxChars
  )
}
