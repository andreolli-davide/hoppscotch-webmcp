import { TestContainer } from "dioc/testing"
import { describe, expect, it, vi } from "vitest"

import { AgentActionApprovalService } from "../human-control"
import { runWebMCPExecution } from "../execution-lifecycle"

const request = {
  action: "Execute",
  method: "POST",
  target: "https://example.test",
  environment: "Local",
  workspace: "personal",
  grantKey: "test",
}

const run = (
  approval: AgentActionApprovalService,
  signal: AbortSignal,
  execute: (snapshot: { revision: number }) => string | Promise<string>,
  revalidate = () => true
) =>
  runWebMCPExecution({
    approval,
    request,
    signal,
    capture: () => ({ revision: 1 }),
    revalidate,
    execute,
    denied: (cancelled) => (cancelled ? "cancelled" : "denied"),
    stale: () => "stale",
    error: () => "error",
  })

describe("WebMCP execution lifecycle", () => {
  it("revalidates before running the callback", async () => {
    const approval = new TestContainer().bind(AgentActionApprovalService)
    const execute = vi.fn(() => "executed")
    const pending = run(
      approval,
      new AbortController().signal,
      execute,
      () => false
    )
    approval.resolve("once")
    await expect(pending).resolves.toBe("stale")
    expect(execute).not.toHaveBeenCalled()
  })

  it("handles denial and cancellation without executing", async () => {
    const approval = new TestContainer().bind(AgentActionApprovalService)
    const execute = vi.fn(() => "executed")
    const denied = run(approval, new AbortController().signal, execute)
    approval.resolve("deny")
    await expect(denied).resolves.toBe("denied")

    const controller = new AbortController()
    const cancelled = run(approval, controller.signal, execute)
    controller.abort()
    await expect(cancelled).resolves.toBe("cancelled")
    expect(execute).not.toHaveBeenCalled()
  })

  it("converts callback errors through the structured error handler", async () => {
    const approval = new TestContainer().bind(AgentActionApprovalService)
    const pending = run(approval, new AbortController().signal, () =>
      Promise.reject(new Error("secret implementation detail"))
    )
    approval.resolve("once")
    await expect(pending).resolves.toBe("error")
  })

  it("handles capture errors through the structured error handler", async () => {
    const approval = new TestContainer().bind(AgentActionApprovalService)
    const error = new Error("capture failed")
    const result = await runWebMCPExecution({
      approval,
      request,
      signal: new AbortController().signal,
      capture: () => {
        throw error
      },
      revalidate: () => true,
      execute: () => "executed",
      denied: () => "denied",
      stale: () => "stale",
      error: (captured) => (captured === error ? "error" : "wrong"),
    })
    expect(result).toBe("error")
  })

  it("returns cancellation when approval completes after abort", async () => {
    const controller = new AbortController()
    const approval = {
      request: vi.fn(async () => {
        controller.abort("stopped")
        return true
      }),
    } as unknown as AgentActionApprovalService
    const execute = vi.fn(() => "executed")

    await expect(run(approval, controller.signal, execute)).resolves.toBe(
      "cancelled"
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it("skips approval for a null request while retaining lifecycle checks", async () => {
    const approval = new TestContainer().bind(AgentActionApprovalService)
    const execute = vi.fn(() => "executed")
    const result = await runWebMCPExecution({
      approval,
      request: null,
      signal: new AbortController().signal,
      capture: () => ({ revision: 1 }),
      revalidate: () => true,
      execute,
      denied: () => "denied",
      stale: () => "stale",
      error: () => "error",
    })
    expect(result).toBe("executed")
    expect(execute).toHaveBeenCalledOnce()
  })
})
