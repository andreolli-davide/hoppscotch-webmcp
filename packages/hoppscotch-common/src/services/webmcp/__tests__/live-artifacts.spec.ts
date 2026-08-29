import "~/services/persistence"
import { describe, expect, it } from "vitest"
import { Container } from "dioc"
import { nextTick } from "vue"
import { BehaviorSubject } from "rxjs"

import { setPlatformDef } from "~/platform"
import { RESTTabService } from "~/services/tab/rest"
import { GQLTabService } from "~/services/tab/graphql"
import { WorkspaceService } from "~/services/workspace.service"
import { getDefaultRESTRequest } from "~/helpers/rest/default"
import { getDefaultGQLRequest, makeCollection } from "@hoppscotch/data"
import {
  restCollectionStore,
  setRESTCollections,
  saveRESTRequestAs,
  editRESTRequest,
  graphqlCollectionStore,
  setGraphqlCollections,
  saveGraphqlRequestAs,
  editGraphqlRequest,
} from "~/newstore/collections"
import {
  restHistoryStore,
  setRESTHistoryEntries,
  makeRESTHistoryEntry,
  graphqlHistoryStore,
  setGraphqlHistoryEntries,
  makeGQLHistoryEntry,
} from "~/newstore/history"

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

describe("WebMCP Live Artifact Workflows", () => {
  describe("Tab Management & Dirty State Protection", () => {
    it("creates, switches, and lists tabs with accurate dirty states", () => {
      const container = new Container()
      const restTabs = container.bind(RESTTabService)

      const initialTabs = restTabs.getTabs()
      expect(initialTabs.length).toBe(1)
      expect(initialTabs[0].document.isDirty).toBe(false)

      const req2 = getDefaultRESTRequest()
      req2.name = "Second Request"
      const tab2 = restTabs.createNewTab(
        {
          type: "request",
          request: req2,
          isDirty: true,
          optionTabPreference: "params",
        },
        true
      )

      expect(restTabs.getTabs().length).toBe(2)
      expect(restTabs.currentTabID.value).toBe(tab2.id)
      expect(tab2.document.isDirty).toBe(true)

      // Switch back to initial tab
      restTabs.setActiveTab(initialTabs[0].id)
      expect(restTabs.currentTabID.value).toBe(initialTabs[0].id)
    })

    it("tracks and manages tab lifecycle and dirty flags", async () => {
      const container = new Container()
      const restTabs = container.bind(RESTTabService)

      const req = getDefaultRESTRequest()
      req.name = "Unsaved Work"
      const tab = restTabs.createNewTab(
        {
          type: "request",
          request: req,
          isDirty: true,
          optionTabPreference: "params",
        },
        true
      )

      // Tab is marked dirty
      expect(tab.document.isDirty).toBe(true)

      // Closing tab removes it from ordering and map
      restTabs.closeTab(tab.id)
      expect(restTabs.tabOrdering.value.includes(tab.id)).toBe(false)
      await nextTick()
      expect(restTabs.getTabs().some((t) => t.id === tab.id)).toBe(false)
    })
  })

  describe("Collection Inspection and Saving", () => {
    it("saves a REST request to a collection and updates it", () => {
      const collection = makeCollection({
        name: "Test API",
        folders: [],
        requests: [],
        auth: { authType: "inherit", authActive: false },
        headers: [],
        variables: [],
      })
      setRESTCollections([collection])

      const req = getDefaultRESTRequest()
      req.name = "Get Users"
      req.endpoint = "https://api.example.test/users"

      const insertionIndex = saveRESTRequestAs("0", req)
      expect(insertionIndex).toBe(0)
      expect(restCollectionStore.value.state[0].requests.length).toBe(1)
      expect(restCollectionStore.value.state[0].requests[0].name).toBe("Get Users")

      // Update existing request in collection
      const updatedReq = { ...req, name: "Get Users V2" }
      editRESTRequest("0", 0, updatedReq)
      expect(restCollectionStore.value.state[0].requests[0].name).toBe("Get Users V2")
    })

    it("saves a GraphQL request to a collection and updates it", () => {
      const collection = makeCollection({
        name: "Test GQL API",
        folders: [],
        requests: [],
        auth: { authType: "inherit", authActive: false },
        headers: [],
        variables: [],
      })
      setGraphqlCollections([collection])

      const req = getDefaultGQLRequest()
      req.name = "Get Schema Query"
      req.url = "https://api.example.test/graphql"

      const insertionIndex = saveGraphqlRequestAs("0", req)
      expect(insertionIndex).toBe(0)
      expect(graphqlCollectionStore.value.state[0].requests.length).toBe(1)
      expect(graphqlCollectionStore.value.state[0].requests[0].name).toBe("Get Schema Query")

      const updatedReq = { ...req, name: "Get Schema Query V2" }
      editGraphqlRequest("0", 0, updatedReq)
      expect(graphqlCollectionStore.value.state[0].requests[0].name).toBe("Get Schema Query V2")
    })
  })

  describe("History Recall", () => {
    it("stores and queries REST execution history", () => {
      const req = getDefaultRESTRequest()
      req.name = "History Test"
      req.endpoint = "https://api.example.test/history"

      const entry = makeRESTHistoryEntry({
        request: req,
        star: false,
        responseMeta: {
          statusCode: 200,
          duration: 45,
        },
        updatedOn: new Date(),
      })

      setRESTHistoryEntries([entry])
      expect(restHistoryStore.value.state.length).toBe(1)
      expect(restHistoryStore.value.state[0].request.endpoint).toBe("https://api.example.test/history")
      expect(restHistoryStore.value.state[0].responseMeta.statusCode).toBe(200)
    })

    it("stores and queries GraphQL execution history", () => {
      const req = getDefaultGQLRequest()
      req.name = "GQL History Test"
      req.url = "https://api.example.test/graphql"

      const entry = makeGQLHistoryEntry({
        request: req,
        star: true,
        response: '{"data":{"ok":true}}',
        updatedOn: new Date(),
      })

      setGraphqlHistoryEntries([entry])
      expect(graphqlHistoryStore.value.state.length).toBe(1)
      expect(graphqlHistoryStore.value.state[0].request.url).toBe("https://api.example.test/graphql")
      expect(graphqlHistoryStore.value.state[0].star).toBe(true)
    })
  })

  describe("Workspace Switching", () => {
    it("switches between personal and team workspace", () => {
      const container = new Container()
      const workspaceService = container.bind(WorkspaceService)

      expect(workspaceService.currentWorkspace.value.type).toBe("personal")

      workspaceService.changeWorkspace({
        type: "team",
        teamID: "team-test-123",
        teamName: "Engineering Team",
        role: "OWNER",
      })

      expect(workspaceService.currentWorkspace.value.type).toBe("team")
      if (workspaceService.currentWorkspace.value.type === "team") {
        expect(workspaceService.currentWorkspace.value.teamID).toBe("team-test-123")
        expect(workspaceService.currentWorkspace.value.teamName).toBe("Engineering Team")
      }

      workspaceService.changeWorkspace({ type: "personal" })
      expect(workspaceService.currentWorkspace.value.type).toBe("personal")
    })
  })
})
