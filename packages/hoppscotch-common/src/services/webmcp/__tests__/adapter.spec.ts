import { afterEach, describe, expect, it, vi } from "vitest"

import { WebMCPAdapter, type WebMCPToolDefinition } from "../adapter"

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
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: tool.name,
        description: tool.description,
        execute: expect.any(Function),
      }),
      { signal: controller.signal }
    )
    expect(registerTool.mock.calls[0][0]).not.toBe(tool)
    expect(adapter.diagnostic.value).toBe("ready")
  })

  it("normalizes omitted and empty execution options", async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    const execute = vi.fn().mockResolvedValue("ok")
    setModelContext({ registerTool })
    const adapter = new WebMCPAdapter(true)
    const packController = new AbortController()
    const tool = {
      name: "inspect_app_context",
      description: "Inspect context",
      execute,
    }

    await adapter.register(tool, packController.signal)
    const registeredTool = registerTool.mock.calls[0][0]

    await expect(registeredTool.execute({})).resolves.toBe("ok")
    await expect(registeredTool.execute({}, {})).resolves.toBe("ok")
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(execute.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal)
  })

  it("does not invoke an already aborted pack or caller", async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    const execute = vi.fn()
    setModelContext({ registerTool })
    const adapter = new WebMCPAdapter(true)
    const packController = new AbortController()
    packController.abort("pack stopped")
    const tool = {
      name: "inspect_app_context",
      description: "Inspect context",
      execute,
    }

    await adapter.register(tool, packController.signal)
    const registeredTool = registerTool.mock.calls[0][0]
    await expect(registeredTool.execute({})).rejects.toBe("pack stopped")
    expect(execute).not.toHaveBeenCalled()

    const activePackController = new AbortController()
    const callerController = new AbortController()
    await adapter.register(tool, activePackController.signal)
    const secondRegisteredTool = registerTool.mock.calls[1][0]
    callerController.abort("caller stopped")
    await expect(
      secondRegisteredTool.execute({}, { signal: callerController.signal })
    ).rejects.toBe("caller stopped")
    expect(execute).not.toHaveBeenCalled()
  })

  it("composes caller and pack cancellation for in-flight work", async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    let receivedSignal: AbortSignal | undefined
    let resolveExecution: (() => void) | undefined
    const execute = vi.fn((_input, options: { signal: AbortSignal }) => {
      receivedSignal = options.signal
      return new Promise<void>((resolve) => {
        resolveExecution = resolve
      })
    })
    setModelContext({ registerTool })
    const adapter = new WebMCPAdapter(true)
    const packController = new AbortController()
    const callerController = new AbortController()
    const tool = {
      name: "inspect_app_context",
      description: "Inspect context",
      execute,
    }

    await adapter.register(tool, packController.signal)
    const registeredTool = registerTool.mock.calls[0][0]
    const execution = registeredTool.execute(
      {},
      { signal: callerController.signal }
    )
    expect(receivedSignal?.aborted).toBe(false)
    callerController.abort("caller stopped")
    expect(receivedSignal?.aborted).toBe(true)
    expect(receivedSignal?.reason).toBe("caller stopped")
    packController.abort("pack stopped")
    resolveExecution!()
    await expect(execution).resolves.toBeUndefined()
  })

  it.each(["caller", "pack"] as const)(
    "keeps the composed signal observable after settlement when %s aborts",
    async (source) => {
      const registerTool = vi.fn().mockResolvedValue(undefined)
      let receivedSignal: AbortSignal | undefined
      const execute = vi.fn((_input, options: { signal: AbortSignal }) => {
        receivedSignal = options.signal
        return "ok"
      })
      setModelContext({ registerTool })
      const adapter = new WebMCPAdapter(true)
      const packController = new AbortController()
      const callerController = new AbortController()
      await adapter.register(
        {
          name: "inspect_app_context",
          description: "Inspect context",
          execute,
        },
        packController.signal
      )
      const registeredTool = registerTool.mock.calls[0][0]
      await expect(
        registeredTool.execute({}, { signal: callerController.signal })
      ).resolves.toBe("ok")
      expect(receivedSignal?.aborted).toBe(false)
      const controller = source === "caller" ? callerController : packController
      controller.abort(`${source} stopped`)
      expect(receivedSignal?.aborted).toBe(true)
      expect(receivedSignal?.reason).toBe(`${source} stopped`)
    }
  )

  it("propagates synchronous throws and async rejections without registration failure", async () => {
    const registerTool = vi.fn().mockResolvedValue(undefined)
    const syncError = new Error("sync failure")
    const asyncError = new Error("async failure")
    const execute = vi
      .fn((_input, _options: { signal: AbortSignal }) => {
        throw syncError
      })
      .mockRejectedValueOnce(asyncError)
    setModelContext({ registerTool })
    const adapter = new WebMCPAdapter(true)
    const controller = new AbortController()
    const tool: WebMCPToolDefinition = {
      name: "inspect_app_context",
      description: "Inspect context",
      execute,
    }
    await expect(adapter.register(tool, controller.signal)).resolves.toBe(true)
    const registeredTool = registerTool.mock.calls[0][0]
    await expect(registeredTool.execute({})).rejects.toBe(asyncError)
    await expect(registeredTool.execute({})).rejects.toBe(syncError)
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
