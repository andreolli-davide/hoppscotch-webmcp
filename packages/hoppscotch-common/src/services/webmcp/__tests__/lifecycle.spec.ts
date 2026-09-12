import "~/services/persistence"
import { describe, expect, it, vi } from "vitest"
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

describe("WebMCP lifecycle", () => {
  it("tracks mutations after initial startup and restart without duplicate watchers", async () => {
    const available = vi
      .spyOn(WebMCPAdapter.prototype, "isAvailable")
      .mockReturnValue(true)
    const register = vi
      .spyOn(WebMCPAdapter.prototype, "register")
      .mockResolvedValue(true)
    const container = new Container()
    const service = container.bind(WebMCPService)
    const context = container.bind(ActiveAppContextService)
    const tabs = container.bind(RESTTabService)
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    try {
      for (let run = 0; run < 2; run++) {
        await service.start(router)
        context.start()
        const before = context.revision("rest-document")
        tabs.currentActiveTab.value!.document.request.name = `changed-${run}`
        const after = context.revision("rest-document")
        expect(Number(after.split(":")[1])).toBe(
          Number(before.split(":")[1]) + 1
        )
        expect(context.matches("rest-document", before)).toBe(false)
      }
      service.stop()
      const stopped = context.revision("rest-document")
      tabs.currentActiveTab.value!.document.request.name = "stopped"
      expect(context.revision("rest-document")).toBe(stopped)
    } finally {
      service.stop()
      available.mockRestore()
      register.mockRestore()
    }
  })
})
