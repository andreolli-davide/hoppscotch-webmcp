import { afterEach, describe, expect, it, vi } from "vitest"

import { WebMCPAdapter } from "../adapter"

const setModelContext = (value: unknown) =>
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value,
  })

const setSecureContext = (value: boolean | undefined) => {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value,
  })
}

describe("WebMCPAdapter", () => {
  afterEach(() => {
    setModelContext(undefined)
    setSecureContext(true)
  })

  it("is a quiet no-op and reports disabled status when disabled", () => {
    const disabled = new WebMCPAdapter(false)
    expect(disabled.isAvailable()).toBe(false)
    expect(disabled.diagnostic.value).toBe("disabled")

    const report = disabled.getPreflightReport()
    expect(report.status).toBe("disabled")
    expect(report.enabled).toBe(false)
    expect(report.reason).toContain("WebMCP is disabled")
  })

  it("reports insecure-context when origin is not secure", () => {
    setSecureContext(false)
    setModelContext({ registerTool: vi.fn() })
    const adapter = new WebMCPAdapter(true)

    expect(adapter.isAvailable()).toBe(false)
    expect(adapter.diagnostic.value).toBe("unsupported")

    const report = adapter.getPreflightReport()
    expect(report.status).toBe("insecure-context")
    expect(report.secureContext).toBe(false)
    expect(report.reason).toContain("secure origin")
  })

  it("reports unsupported status when document.modelContext is absent or invalid", () => {
    const unsupported = new WebMCPAdapter(true)
    expect(unsupported.isAvailable()).toBe(false)
    expect(unsupported.diagnostic.value).toBe("unsupported")

    const report = unsupported.getPreflightReport()
    expect(report.status).toBe("unsupported")
    expect(report.modelContextAvailable).toBe(false)
    expect(report.registerToolAvailable).toBe(false)

    // Test when modelContext exists but registerTool is not a function
    setModelContext({})
    const invalidAdapter = new WebMCPAdapter(true)
    expect(invalidAdapter.isAvailable()).toBe(false)
    const invalidReport = invalidAdapter.getPreflightReport()
    expect(invalidReport.status).toBe("unsupported")
    expect(invalidReport.modelContextAvailable).toBe(true)
    expect(invalidReport.registerToolAvailable).toBe(false)
  })

  it("reports ready status when enabled in a supported secure context", () => {
    setModelContext({ registerTool: vi.fn() })
    const adapter = new WebMCPAdapter(true)

    const report = adapter.getPreflightReport()
    expect(report.status).toBe("ready")
    expect(report.enabled).toBe(true)
    expect(report.secureContext).toBe(true)
    expect(report.modelContextAvailable).toBe(true)
    expect(report.registerToolAvailable).toBe(true)
    expect(adapter.isAvailable()).toBe(true)
    expect(adapter.diagnostic.value).toBe("ready")
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

  it("handles tool registration error gracefully", async () => {
    const registerTool = vi
      .fn()
      .mockRejectedValue(new Error("Registration failed"))
    setModelContext({ registerTool })
    const adapter = new WebMCPAdapter(true)
    const controller = new AbortController()
    const tool = {
      name: "inspect_app_context",
      description: "Inspect context",
      execute: vi.fn(),
    }

    await expect(adapter.register(tool, controller.signal)).resolves.toBe(false)
    expect(adapter.diagnostic.value).toBe("registration-error")

    const report = adapter.getPreflightReport()
    expect(report.status).toBe("registration-error")
  })
})
