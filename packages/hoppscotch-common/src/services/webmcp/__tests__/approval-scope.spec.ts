import "~/services/persistence"
import { expect, it, vi } from "vitest"
import { Container } from "dioc"
import { BehaviorSubject } from "rxjs"

import { setPlatformDef } from "~/platform"
import { RESTTabService } from "~/services/tab/rest"

setPlatformDef({
  auth: {
    getCurrentUserStream: () => new BehaviorSubject(null),
    getCurrentUser: () => null,
    getProbableUserStream: () => new BehaviorSubject(null),
    getProbableUser: () => null,
    waitProbableLoginToConfirm: async () => {},
  } as any,
  backend: {} as any,
  kernelIO: {} as any,
  instance: {} as any,
  kernelInterceptors: {} as any,
  platformFeatureFlags: { exportAsGIST: false, hasTelemetry: false },
})

import { createRouter, createMemoryHistory } from "vue-router"
import { ActiveAppContextService } from "../context"
import { WebMCPService } from "../service"
import { WebMCPAdapter } from "../adapter"

import { AgentActionApprovalService } from "../human-control"
import { approvalIdentity } from "../approval-scope"

it("binds approval identities to stable workspace, environment, and action details", () => {
  const base = {
    operation: "realtime",
    workspaceID: { type: "team" as const, teamID: "team-a" },
    environmentID: "env-a",
    environmentScope: "MY_ENV",
    revision: "rest-document:1",
    target: "mqtt://example.test",
    action: "publish",
    details: { topic: "events", message: "hello", qos: 0 },
  }
  expect(approvalIdentity(base)).not.toBe(
    approvalIdentity({
      ...base,
      workspaceID: { type: "team", teamID: "team-b" },
    })
  )
  expect(approvalIdentity(base)).not.toBe(
    approvalIdentity({ ...base, environmentID: "env-b" })
  )
  expect(approvalIdentity(base)).not.toBe(
    approvalIdentity({ ...base, details: { ...base.details, qos: 1 } })
  )
  expect(approvalIdentity(base)).not.toBe(
    approvalIdentity({
      ...base,
      details: { ...base.details, eventName: "changed" },
    })
  )
})

it("does not reuse REST session approval after method, query or draft changes", async () => {
  const available = vi
    .spyOn(WebMCPAdapter.prototype, "isAvailable")
    .mockReturnValue(true)
  const tools = new Map<string, any>()
  const register = vi
    .spyOn(WebMCPAdapter.prototype, "register")
    .mockImplementation(async (tool) => {
      tools.set(tool.name, tool)
      return true
    })
  const container = new Container()
  const service = container.bind(WebMCPService)
  const context = container.bind(ActiveAppContextService)
  const approval = container.bind(AgentActionApprovalService)
  const tabs = container.bind(RESTTabService)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: {} }],
  })
  await router.push("/")
  try {
    await service.start(router)
    const request = tabs.currentActiveTab.value!.document.request
    request.endpoint = "https://example.test/items?mode=read"
    request.method = "GET"
    // Keep the test focused on authorization, without issuing network requests.
    const decision = vi.spyOn(approval, "request").mockResolvedValue(false)
    const invoke = () =>
      tools
        .get("execute_rest_request")
        .execute(
          { expectedRevision: context.revision("rest-document") },
          { signal: new AbortController().signal }
        )
    await invoke()
    const initial = decision.mock.calls[0][0].grantKey
    request.method = "DELETE"
    await invoke()
    expect(decision.mock.calls[1][0].grantKey).not.toBe(initial)
    request.method = "GET"
    request.endpoint = "https://example.test/items?mode=delete"
    await invoke()
    expect(decision.mock.calls[2][0].grantKey).not.toBe(initial)
    request.endpoint = "https://example.test/items?mode=read"
    request.preRequestScript = "console.log('changed')"
    await invoke()
    expect(decision.mock.calls[3][0].grantKey).not.toBe(initial)
  } finally {
    service.stop()
    available.mockRestore()
    register.mockRestore()
  }
})
