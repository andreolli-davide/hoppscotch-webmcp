import { describe, expect, it } from "vitest"

import {
  configureRESTAuthParser,
  editRESTScriptsParser,
  editRESTVariablesParser,
  editRESTRequestParser,
  editGraphQLOperationParser,
  editRealtimeSessionInputSchema,
  editRealtimeSessionParser,
  graphqlPayloadParser,
  listEnvironmentsParser,
  mqttTopicParser,
  readRESTPayloadParser,
  realtimeMessageParser,
  requestPatchSchema,
  switchTabParser,
  createTabParser,
  closeTabParser,
  inspectCollectionParser,
  saveRequestToCollectionParser,
  listHistoryParser,
  loadHistoryEntryParser,
  switchWorkspaceParser,
  runCollectionParser,
  deleteCollectionParser,
  deleteFolderParser,
  deleteEnvironmentParser,
} from "../schemas"

describe("WebMCP REST input schemas", () => {
  it("accepts the allow-listed draft fields", () => {
    expect(
      editRESTRequestParser.safeParse({
        expectedRevision: "rest-document:4",
        patch: {
          name: "Get User Orders",
          method: "POST",
          endpoint: "https://example.test/orders",
          headers: [
            { key: "Content-Type", value: "application/json", active: true },
          ],
          body: { contentType: "application/json", body: '{"quantity":1}' },
        },
      }).success
    ).toBe(true)
  })

  it("rejects empty patches, extra properties and oversized values", () => {
    expect(requestPatchSchema.safeParse({}).success).toBe(false)
    expect(
      requestPatchSchema.safeParse({ auth: { authType: "none" } }).success
    ).toBe(false)
    expect(
      requestPatchSchema.safeParse({ endpoint: "x".repeat(8193) }).success
    ).toBe(false)
    expect(
      requestPatchSchema.safeParse({ name: "x".repeat(257) }).success
    ).toBe(false)
    expect(requestPatchSchema.safeParse({ name: "" }).success).toBe(false)
    expect(
      requestPatchSchema.safeParse({
        headers: [{ key: "x", value: "y", active: true, secret: true }],
      }).success
    ).toBe(false)
  })

  it("bounds payload windows and revisions", () => {
    expect(
      readRESTPayloadParser.safeParse({
        source: "response",
        expectedRevision: "rest-response:2",
        maxChars: 768,
      }).success
    ).toBe(true)
    expect(
      readRESTPayloadParser.safeParse({
        source: "response",
        expectedRevision: "rest-response:2",
        maxChars: 769,
      }).success
    ).toBe(false)
    expect(
      readRESTPayloadParser.safeParse({
        source: "response",
        expectedRevision: "",
      }).success
    ).toBe(false)
  })

  it("accepts environment references but rejects raw-looking auth templates", () => {
    expect(
      configureRESTAuthParser.safeParse({
        expectedRevision: "rest-document:4",
        authType: "bearer",
        active: true,
        references: { token: "API_TOKEN" },
      }).success
    ).toBe(true)
    expect(
      configureRESTAuthParser.safeParse({
        expectedRevision: "rest-document:4",
        authType: "bearer",
        active: true,
        references: { token: "<<API_TOKEN>>" },
      }).success
    ).toBe(false)
    expect(
      configureRESTAuthParser.safeParse({
        expectedRevision: "rest-document:4",
        authType: "bearer",
        active: true,
        token: "literal-secret",
      }).success
    ).toBe(false)
  })

  it("bounds request variables and scripts", () => {
    expect(
      editRESTVariablesParser.safeParse({
        expectedRevision: "rest-document:4",
        variables: [{ key: "ORDER_ID", value: "42", active: true }],
      }).success
    ).toBe(true)
    expect(
      editRESTVariablesParser.safeParse({
        expectedRevision: "rest-document:4",
        variables: [{ key: "", value: "42", active: true }],
      }).success
    ).toBe(false)
    expect(
      editRESTScriptsParser.safeParse({
        expectedRevision: "rest-document:4",
        target: "post_request",
        script: "x".repeat(32769),
      }).success
    ).toBe(false)
  })

  it("paginates environment choices with bounded offsets", () => {
    expect(listEnvironmentsParser.safeParse({}).data?.offset).toBe(0)
    expect(listEnvironmentsParser.safeParse({ offset: 4 }).success).toBe(true)
    expect(listEnvironmentsParser.safeParse({ offset: -1 }).success).toBe(false)
  })
})

describe("WebMCP GraphQL and realtime input schemas", () => {
  it("allows only bounded GraphQL draft fields", () => {
    expect(
      editGraphQLOperationParser.safeParse({
        expectedRevision: "graphql-document:2",
        patch: {
          name: "Viewer Query",
          query: "query Viewer { viewer { id } }",
          variables: "{}",
        },
      }).success
    ).toBe(true)
    expect(
      editGraphQLOperationParser.safeParse({
        expectedRevision: "graphql-document:2",
        patch: { name: "x".repeat(257) },
      }).success
    ).toBe(false)
    expect(
      editGraphQLOperationParser.safeParse({
        expectedRevision: "graphql-document:2",
        patch: { name: "" },
      }).success
    ).toBe(false)
    expect(
      editGraphQLOperationParser.safeParse({
        expectedRevision: "graphql-document:2",
        patch: { auth: { token: "secret" } },
      }).success
    ).toBe(false)
  })

  it("binds GraphQL payload windows to a bounded revision", () => {
    expect(
      graphqlPayloadParser.safeParse({
        source: "response",
        expectedRevision: "graphql-response:4",
        maxChars: 768,
      }).success
    ).toBe(true)
    expect(
      graphqlPayloadParser.safeParse({
        source: "response",
        expectedRevision: "graphql-response:4",
        maxChars: 769,
      }).success
    ).toBe(false)
  })

  it("rejects unsupported realtime draft fields and oversized messages", () => {
    expect(
      editRealtimeSessionParser("websocket").safeParse({
        expectedRevision: "realtime-session:1",
        patch: { endpoint: "wss://echo.example.test", protocols: [] },
      }).success
    ).toBe(true)
    expect(
      editRealtimeSessionParser("websocket").safeParse({
        expectedRevision: "realtime-session:1",
        patch: { password: "literal-secret" },
      }).success
    ).toBe(false)
    expect(
      editRealtimeSessionParser("sse").safeParse({
        expectedRevision: "realtime-session:1",
        patch: { protocols: [] },
      }).success
    ).toBe(false)
    expect(
      realtimeMessageParser.safeParse({
        expectedRevision: "realtime-session:1",
        message: "x".repeat(65537),
      }).success
    ).toBe(false)
  })

  it("advertises the same mode-specific realtime fields it validates", () => {
    const websocket = editRealtimeSessionInputSchema("websocket")
    const socketio = editRealtimeSessionInputSchema("socketio")
    const sse = editRealtimeSessionInputSchema("sse")

    expect(websocket.properties.patch.properties).toHaveProperty("protocols")
    expect(socketio.properties.patch.properties).toHaveProperty("path")
    expect(socketio.properties.patch.properties).not.toHaveProperty("protocols")
    expect(sse.properties.patch.properties).toHaveProperty("eventType")
  })

  it("requires a bounded MQTT topic and limits QoS", () => {
    expect(
      mqttTopicParser.safeParse({
        expectedRevision: "realtime-session:1",
        topic: "events/orders",
        qos: 1,
      }).success
    ).toBe(true)
    expect(
      mqttTopicParser.safeParse({
        expectedRevision: "realtime-session:1",
        topic: "events/orders",
        qos: 3,
      }).success
    ).toBe(false)
  })
})

describe("WebMCP Live Artifact input schemas", () => {
  it("validates tab operations", () => {
    expect(
      switchTabParser.safeParse({
        expectedRevision: "rest-document:1",
        tabID: "tab-123",
      }).success
    ).toBe(true)
    expect(
      switchTabParser.safeParse({
        expectedRevision: "rest-document:1",
      }).success
    ).toBe(false)

    expect(
      createTabParser.safeParse({
        expectedRevision: "rest-document:1",
        name: "New Request",
      }).success
    ).toBe(true)

    expect(
      closeTabParser.safeParse({
        expectedRevision: "rest-document:1",
        tabID: "tab-123",
        force: true,
      }).success
    ).toBe(true)
  })

  it("validates collection operations", () => {
    expect(
      inspectCollectionParser.safeParse({
        path: "0/1",
      }).success
    ).toBe(true)
    expect(inspectCollectionParser.safeParse({}).success).toBe(false)

    expect(
      saveRequestToCollectionParser.safeParse({
        expectedRevision: "rest-document:1",
        collectionPath: "0",
        name: "My Saved Request",
      }).success
    ).toBe(true)
  })

  it("validates history operations", () => {
    expect(
      listHistoryParser.safeParse({
        limit: 20,
        offset: 10,
      }).success
    ).toBe(true)
    expect(
      listHistoryParser.safeParse({
        limit: 100, // exceeds max 50
      }).success
    ).toBe(false)

    expect(
      loadHistoryEntryParser.safeParse({
        expectedRevision: "rest-document:1",
        index: 3,
        targetTab: "new",
      }).success
    ).toBe(true)
  })

  it("validates workspace switching", () => {
    expect(
      switchWorkspaceParser.safeParse({
        expectedRevision: "app-context:1",
        workspaceID: "personal",
      }).success
    ).toBe(true)
    expect(
      switchWorkspaceParser.safeParse({
        expectedRevision: "app-context:1",
        workspaceID: "team-456",
      }).success
    ).toBe(true)
    expect(switchWorkspaceParser.safeParse({}).success).toBe(false)
  })

  it("validates collection runner parameters", () => {
    expect(
      runCollectionParser.safeParse({
        expectedRevision: "rest-document:1",
        collectionPath: "0",
        delay: 500,
        stopOnError: true,
        persistResponses: false,
        keepVariableValues: true,
      }).success
    ).toBe(true)

    expect(
      runCollectionParser.safeParse({
        expectedRevision: "rest-document:1",
        delay: 15000, // exceeds max 10000
      }).success
    ).toBe(false)
  })

  it("validates durable ops schemas and requires confirmationName", () => {
    expect(
      deleteCollectionParser.safeParse({
        expectedRevision: "app-context:1",
        collectionPath: "0",
        confirmationName: "My Collection",
      }).success
    ).toBe(true)
    expect(
      deleteCollectionParser.safeParse({
        expectedRevision: "app-context:1",
        collectionPath: "0",
      }).success
    ).toBe(false)

    expect(
      deleteFolderParser.safeParse({
        expectedRevision: "app-context:1",
        folderPath: "0/1",
        confirmationName: "Folder A",
      }).success
    ).toBe(true)
    expect(
      deleteFolderParser.safeParse({
        expectedRevision: "app-context:1",
        folderPath: "0/1",
      }).success
    ).toBe(false)

    expect(
      deleteEnvironmentParser.safeParse({
        expectedRevision: "app-context:1",
        environmentIndex: 0,
        confirmationName: "Dev Env",
      }).success
    ).toBe(true)
    expect(
      deleteEnvironmentParser.safeParse({
        expectedRevision: "app-context:1",
        environmentIndex: 0,
      }).success
    ).toBe(false)
  })
})
