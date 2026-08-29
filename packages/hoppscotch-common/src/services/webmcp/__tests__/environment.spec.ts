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

  it("creates personal environment with plain and secret variables", () => {
    const container = new TestContainer()
    const service = container.bind(WebMCPEnvironmentService)
    const secretService = container.bind(SecretEnvironmentService)

    const created = service.createPersonal("Staging", [
      { key: "BASE_URL", value: "https://staging.api.com", secret: false },
      { key: "API_KEY", value: "staging-secret-key", secret: true },
    ])

    expect(created.name).toBe("Staging")
    expect(created.variableCount).toBe(2)
    expect(created.secretVariableCount).toBe(1)
    expect(created.handle).toBeTruthy()

    // Verify environmentsStore was updated
    const envInStore = environmentsStore.value.environments.find(
      (e) => e.id === created.id
    )
    expect(envInStore).toBeTruthy()
    expect(envInStore?.name).toBe("Staging")
    // Non-secret variable has initialValue on wire
    expect(envInStore?.variables[0].key).toBe("BASE_URL")
    expect(envInStore?.variables[0].initialValue).toBe(
      "https://staging.api.com"
    )
    // Secret variable has blank initialValue on wire
    expect(envInStore?.variables[1].key).toBe("API_KEY")
    expect(envInStore?.variables[1].initialValue).toBe("")
    expect(envInStore?.variables[1].secret).toBe(true)

    // Secret is stored in SecretEnvironmentService
    const storedSecret = secretService.getSecretEnvironmentVariableValue(
      created.id,
      1
    )
    expect(storedSecret?.value).toBe("staging-secret-key")
  })

  it("mutates variables with add, update, and remove operations and supports undo", async () => {
    const container = new TestContainer()
    const service = container.bind(WebMCPEnvironmentService)
    const secretService = container.bind(SecretEnvironmentService)

    const listed = await service.list()
    const localChoice = listed.environments.find(({ name }) => name === "Local")
    expect(localChoice).toBeTruthy()

    // Mutate variables: add NEW_VAR, update API_TOKEN, remove IGNORED_SECRET
    const mutateResult = await service.mutateVariables(localChoice!.handle, [
      { op: "add", key: "NEW_VAR", value: "https://new.test", secret: false },
      {
        op: "update",
        key: "API_TOKEN",
        value: "updated-token-value",
        secret: true,
      },
      { op: "remove", key: "IGNORED_SECRET" },
    ])

    expect(mutateResult.ok).toBe(true)
    if (!mutateResult.ok) return

    expect(mutateResult.updatedKeys).toEqual([
      "NEW_VAR",
      "API_TOKEN",
      "IGNORED_SECRET",
    ])
    expect(mutateResult.variableCount).toBe(2)
    expect(mutateResult.secretVariableCount).toBe(1)

    // Check store state after mutation
    const currentEnv = environmentsStore.value.environments[0]
    expect(currentEnv.variables.map((v) => v.key)).toEqual([
      "API_TOKEN",
      "NEW_VAR",
    ])
    expect(
      secretService.getSecretEnvironmentVariableValue(environment.id, 0)?.value
    ).toBe("updated-token-value")

    // Test Undo
    const undoSuccess = mutateResult.undo()
    expect(undoSuccess).toBe(true)

    // Store state restored
    const restoredEnv = environmentsStore.value.environments[0]
    expect(restoredEnv.variables.map((v) => v.key)).toEqual([
      "IGNORED_SECRET",
      "API_TOKEN",
    ])
  })

  it("blocks secret downgrade from secret: true to secret: false", async () => {
    const container = new TestContainer()
    const service = container.bind(WebMCPEnvironmentService)

    const listed = await service.list()
    const localChoice = listed.environments.find(({ name }) => name === "Local")

    const res = await service.mutateVariables(localChoice!.handle, [
      { op: "update", key: "API_TOKEN", value: "new-val", secret: false },
    ])

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain("Cannot convert secret variable")
    }
  })
})
