import { afterEach, describe, expect, it, vi } from "vitest"

import { WebMCPAdapter } from "../adapter"

const setModelContext = (value: unknown) =>
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value,
  })

describe("WebMCPAdapter", () => {
  afterEach(() => setModelContext(undefined))

  it("is a quiet no-op when disabled or unsupported", () => {
    const disabled = new WebMCPAdapter(false)
    expect(disabled.isAvailable()).toBe(false)
    expect(disabled.diagnostic.value).toBe("disabled")

    const unsupported = new WebMCPAdapter(true)
    expect(unsupported.isAvailable()).toBe(false)
    expect(unsupported.diagnostic.value).toBe("unsupported")
  })

  it("registers with pack-scoped cancellation", async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    setModelContext({ registerTool })
    const adapter = new WebMCPAdapter(true)
    const controller = new AbortController()
    const tool = {
      name: "inspect_app_context",
      description: "Inspect context",
      execute: vi.fn(),
    }

    await expect(adapter.register(tool, controller.signal)).resolves.toBe(true)
    expect(registerTool).toHaveBeenCalledWith(tool, {
      signal: controller.signal,
    })
    expect(adapter.diagnostic.value).toBe("ready")
  })
})
