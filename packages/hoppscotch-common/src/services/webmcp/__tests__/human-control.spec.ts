import { TestContainer } from "dioc/testing"
import { describe, expect, it } from "vitest"

import {
  AgentActionApprovalService,
  AgentActivityService,
} from "../human-control"

const approvalRequest = {
  action: "Execute REST request",
  method: "POST",
  target: "https://example.test/orders",
  environment: "Local",
  workspace: "personal",
  grantKey: "execute|rest|https://example.test|Local|personal",
}

describe("WebMCP human control", () => {
  it("requires approval and reuses only an explicit session grant", async () => {
    const service = new TestContainer().bind(AgentActionApprovalService)
    const first = service.request(approvalRequest, new AbortController().signal)
    expect(service.pending.value?.target).toBe(approvalRequest.target)
    service.resolve("session")
    await expect(first).resolves.toBe(true)

    await expect(
      service.request(approvalRequest, new AbortController().signal)
    ).resolves.toBe(true)

    const differentScope = service.request(
      { ...approvalRequest, grantKey: `${approvalRequest.grantKey}|other` },
      new AbortController().signal
    )
    service.resolve("deny")
    await expect(differentScope).resolves.toBe(false)
  })

  it("denies an approval when the tool execution is aborted", async () => {
    const service = new TestContainer().bind(AgentActionApprovalService)
    const controller = new AbortController()
    const decision = service.request(approvalRequest, controller.signal)
    controller.abort()
    await expect(decision).resolves.toBe(false)
    expect(service.pending.value).toBeNull()
  })

  it("keeps bounded activity and makes undo one-shot", () => {
    const service = new TestContainer().bind(AgentActivityService)
    let value = "changed"
    const id = service.record(
      {
        tool: "edit_rest_request",
        outcome: "changed",
        summary: "Changed REST endpoint",
        revision: "rest-document:2",
      },
      () => {
        value = "original"
        return true
      }
    )

    expect(service.undo(id)).toBe(true)
    expect(value).toBe("original")
    expect(service.undo(id)).toBe(false)

    for (let index = 0; index < 110; index++) {
      service.record({
        tool: "inspect",
        outcome: "executed",
        summary: String(index),
        revision: String(index),
      })
    }
    expect(service.entries.value).toHaveLength(100)
  })
})
