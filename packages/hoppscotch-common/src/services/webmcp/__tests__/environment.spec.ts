import { TestContainer } from "dioc/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/services/workspace.service", async () => {
  const { Service } = await import("dioc")
  const { readonly, ref } = await import("vue")
  return {
    WorkspaceService: class extends Service {
      public static readonly ID = "WORKSPACE_SERVICE"
      public currentWorkspace = readonly(ref({ type: "personal" as const }))
    },
  }
})

vi.mock("~/helpers/teams/TeamEnvironmentAdapter", async () => {
  const { BehaviorSubject } = await import("rxjs")
  return {
    default: class {
      public teamEnvironmentList$ = new BehaviorSubject([])
      public changeTeamID() {
        return Promise.resolve()
      }
    },
  }
})

import {
  environmentsStore,
  getSelectedEnvironmentIndex,
  replaceEnvironments,
  setSelectedEnvironmentIndex,
} from "~/newstore/environments"
import { SecretEnvironmentService } from "~/services/secret-environment.service"

import { WebMCPEnvironmentService } from "../environment"

const environment = {
  v: 2 as const,
  id: "env-local",
  name: "Local",
  variables: [
    {
      key: "IGNORED_SECRET",
      initialValue: "",
      currentValue: "",
      secret: true,
    },
    {
      key: "API_TOKEN",
      initialValue: "",
      currentValue: "",
      secret: true,
    },
  ],
}

describe("WebMCP environment context", () => {
  const originalEnvironments = [...environmentsStore.value.environments]
  const originalSelection = getSelectedEnvironmentIndex()

  beforeEach(() => {
    replaceEnvironments([environment])
    setSelectedEnvironmentIndex({ type: "NO_ENV_SELECTED" })
  })

  afterEach(() => {
    replaceEnvironments(originalEnvironments)
    setSelectedEnvironmentIndex(originalSelection)
  })

  it("lists opaque choices and selects only a returned handle", async () => {
    const service = new TestContainer().bind(WebMCPEnvironmentService)
    const listed = await service.list()
    const local = listed.environments.find(({ name }) => name === "Local")

    expect(local?.handle).toBeTruthy()
    expect(local?.handle).not.toContain(environment.id)
    expect(service.select("not-a-handle")).toBe(false)
    expect(service.select(local!.handle)).toBe(true)
    expect(getSelectedEnvironmentIndex()).toEqual({ type: "MY_ENV", index: 0 })
  })

  it("omits values and preserves source indexes when filtering references", () => {
    const container = new TestContainer()
    container
      .bind(SecretEnvironmentService)
      .addSecretEnvironment(environment.id, [
        {
          key: "API_TOKEN",
          value: "managed-secret",
          initialValue: "",
          varIndex: 1,
        },
      ])
    const service = container.bind(WebMCPEnvironmentService)
    setSelectedEnvironmentIndex({ type: "MY_ENV", index: 0 })

    const inspected = service.inspectSelected(new Set(["API_TOKEN"]))
    expect(inspected.variables).toEqual([
      {
        name: "API_TOKEN",
        secret: true,
        currentValueAvailable: true,
        initialValueAvailable: false,
      },
    ])
    expect(JSON.stringify(inspected)).not.toContain("managed-secret")
  })
})
