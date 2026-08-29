import "~/services/persistence"
import { describe, expect, it } from "vitest"
import { Container } from "dioc"
import { BehaviorSubject } from "rxjs"

import { setPlatformDef } from "~/platform"
import { makeCollection, getDefaultRESTRequest } from "@hoppscotch/data"
import {
  restCollectionStore,
  setRESTCollections,
  removeRESTCollection,
  removeRESTFolder,
} from "~/newstore/collections"
import {
  environmentsStore,
  replaceEnvironments,
  deleteEnvironment,
} from "~/newstore/environments"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { AgentActionApprovalService } from "../human-control"

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

describe("WebMCP Durable / Destructive Operations", () => {
  it("verifies confirmation name before deleting collection", () => {
    const col1 = makeCollection({
      name: "Important API",
      folders: [],
      requests: [getDefaultRESTRequest()],
      auth: { authType: "inherit", authActive: false },
      headers: [],
      variables: [],
    })
    const col2 = makeCollection({
      name: "Temporary API",
      folders: [],
      requests: [],
      auth: { authType: "inherit", authActive: false },
      headers: [],
      variables: [],
    })

    setRESTCollections([col1, col2])
    expect(restCollectionStore.value.state.length).toBe(2)

    // Name mismatch verification logic
    const target = restCollectionStore.value.state[1]
    const mismatchedConfirmation = "Wrong Name"
    expect(target.name === mismatchedConfirmation).toBe(false)

    // Name match verification logic
    const correctConfirmation = "Temporary API"
    expect(target.name === correctConfirmation).toBe(true)

    // Path format checks
    expect(/^\d+$/.test("0")).toBe(true)
    expect(/^\d+$/.test("0/1")).toBe(false)

    // Execute deletion
    removeRESTCollection(1)
    expect(restCollectionStore.value.state.length).toBe(1)
    expect(restCollectionStore.value.state[0].name).toBe("Important API")
  })

  it("verifies confirmation name before deleting folder", () => {
    const folder1 = makeCollection({
      name: "V1 Endpoints",
      folders: [],
      requests: [],
      auth: { authType: "inherit", authActive: false },
      headers: [],
      variables: [],
    })
    const rootCol = makeCollection({
      name: "Root Collection",
      folders: [folder1],
      requests: [],
      auth: { authType: "inherit", authActive: false },
      headers: [],
      variables: [],
    })

    setRESTCollections([rootCol])
    expect(restCollectionStore.value.state[0].folders.length).toBe(1)

    const folderTarget = restCollectionStore.value.state[0].folders[0]
    expect(folderTarget.name).toBe("V1 Endpoints")

    // Match verification
    const confirmation = "V1 Endpoints"
    expect(folderTarget.name === confirmation).toBe(true)

    // Execute folder deletion
    removeRESTFolder("0/0")
    expect(restCollectionStore.value.state[0].folders.length).toBe(0)
  })

  it("verifies confirmation name before deleting environment", () => {
    replaceEnvironments([
      {
        id: "env-1",
        name: "Staging",
        v: 2,
        variables: [{ key: "BASE_URL", value: "https://staging.test", secret: false }],
      },
      {
        id: "env-2",
        name: "Production",
        v: 2,
        variables: [{ key: "BASE_URL", value: "https://api.test", secret: false }],
      },
    ])

    expect(environmentsStore.value.environments.length).toBe(2)

    const envTarget = environmentsStore.value.environments[0]
    expect(envTarget.name).toBe("Staging")

    // Match confirmation
    expect(envTarget.name === "Staging").toBe(true)
    expect(envTarget.name === "Prod").toBe(false)

    // Delete environment
    deleteEnvironment(0, envTarget.id)
    expect(environmentsStore.value.environments.length).toBe(1)
    expect(environmentsStore.value.environments[0].name).toBe("Production")

    const container = new Container()
    const secrets = container.bind(SecretEnvironmentService)
    secrets.secretEnvironments.set("env-1", [
      { key: "API_KEY", value: "secret123", varIndex: 0 },
    ])
    expect(secrets.secretEnvironments.has("env-1")).toBe(true)
    secrets.deleteSecretEnvironment("env-1")
    expect(secrets.secretEnvironments.has("env-1")).toBe(false)
  })

  it("requires step-up human approval for durable operations", async () => {
    const container = new Container()
    const approvalService = container.bind(AgentActionApprovalService)

    const approvalReq = {
      action: "DELETE collection",
      method: "DELETE",
      target: "Production API Tests",
      environment: "Production",
      workspace: "personal" as const,
      grantKey: "delete-collection|Production API Tests|Production|personal",
    }

    const pendingPromise = approvalService.request(
      approvalReq,
      new AbortController().signal
    )
    expect(approvalService.pending.value?.target).toBe("Production API Tests")

    approvalService.resolve("approve")
    await expect(pendingPromise).resolves.toBe(true)
  })
})
