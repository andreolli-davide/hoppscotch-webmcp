import "~/services/persistence"
import { expect, it, vi } from "vitest"
import { Container } from "dioc"
import { BehaviorSubject } from "rxjs"

import { setPlatformDef } from "~/platform"

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

import { makeCollection } from "@hoppscotch/data"
import { setRESTCollections, restCollectionStore } from "~/newstore/collections"
import { replaceEnvironments, environmentsStore } from "~/newstore/environments"
import { AgentActionApprovalService } from "../human-control"

it.each(["delete_collection", "delete_folder", "delete_environment"])(
  "%s rejects a target replaced during approval",
  async (name) => {
    vi.stubEnv("VITE_ENABLE_WEBMCP_DURABLE_OPS", "true")
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
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    const collection = (name: string) =>
      makeCollection({
        name,
        folders: [],
        requests: [],
        auth: { authType: "inherit", authActive: false },
        headers: [],
        variables: [],
      })
    try {
      await service.start(router)
      const root = collection("Target")
      root.folders = [collection("Target"), collection("Other")]
      setRESTCollections([root, collection("Other")])
      replaceEnvironments([
        { id: "target", name: "Target", v: 2, variables: [] },
        { id: "other", name: "Other", v: 2, variables: [] },
      ])
      const input = {
        expectedRevision: context.revision("app-context"),
        confirmationName: "Target",
        ...(name === "delete_collection"
          ? { collectionPath: "0" }
          : name === "delete_folder"
            ? { folderPath: "0/0" }
            : { environmentIndex: 0 }),
      }
      const pending = tools
        .get(name)
        .execute(input, { signal: new AbortController().signal })
      expect(approval.pending.value?.allowSession).toBe(false)
      if (name === "delete_collection")
        setRESTCollections([...restCollectionStore.value.state].reverse())
      else if (name === "delete_folder") {
        const replacement = collection("Target")
        replacement.folders = [collection("Other"), collection("Target")]
        setRESTCollections([replacement])
      } else
        replaceEnvironments([...environmentsStore.value.environments].reverse())
      approval.resolve("once")
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe("STATE_CHANGED")
      if (name === "delete_collection")
        expect(restCollectionStore.value.state).toHaveLength(2)
      else if (name === "delete_folder")
        expect(restCollectionStore.value.state[0].folders).toHaveLength(2)
      else expect(environmentsStore.value.environments).toHaveLength(2)
    } finally {
      service.stop()
      available.mockRestore()
      register.mockRestore()
      vi.unstubAllEnvs()
    }
  }
)
