import { describe, expect, it } from "vitest"

import { readByteWindow, readTextWindow } from "../payload-windows"

describe("payload windows", () => {
  it("clamps UTF-16 text windows and reports continuation accurately", () => {
    expect(readTextWindow("a😀bc", 1, 2)).toEqual({
      text: "😀",
      offset: 1,
      totalChars: 5,
      nextOffset: 3,
      truncated: true,
    })
    expect(readTextWindow("abc", 99, 2).truncated).toBe(false)
  })

  it("starts byte windows at UTF-8 boundaries and reconstructs by nextOffset", () => {
    const bytes = new TextEncoder().encode("a😀bc")
    const first = readByteWindow(bytes, 0, 2)
    const second = readByteWindow(bytes, first.nextOffset, 2)
    expect(first.text).toBe("a😀")
    expect(second.text).toBe("bc")
    expect(second.nextOffset).toBe(bytes.length)
    expect(second.truncated).toBe(false)
  })

  it("rejects malformed UTF-8 without advancing beyond raw bytes", () => {
    expect(() => readByteWindow(new Uint8Array([0xff]), 0, 1)).toThrow()
    const bytes = new TextEncoder().encode("\ufeff😀x")
    const window = readByteWindow(bytes, 0, 1)
    expect(window.text).toBe("\ufeff")
    expect(window.nextOffset).toBeLessThanOrEqual(bytes.length)
  })
})
