import { describe, expect, it } from "vitest"
import { Container } from "dioc"
import { getDefaultGQLRequest } from "@hoppscotch/data"

import { GQLRequestExecutionService } from "~/services/graphql-execution.service"
import { HoppGQLDocument } from "~/helpers/graphql/document"
import { HoppTab } from "~/services/tab"
import { connection } from "~/helpers/graphql/connection"

const createMockGQLTab = (
  query = "query GetUser { user { id name } }"
): HoppTab<HoppGQLDocument> => ({
  id: "test-tab-1",
  type: "tab",
  document: {
    type: "graphql",
    request: {
      ...getDefaultGQLRequest(),
      name: "Test Query",
      url: "https://echo.hoppscotch.io/graphql",
      query,
    },
    response: null,
    isDirty: false,
    optionTabPreference: "query",
  },
})

describe("GraphQL AbortSignal Cancellation", () => {
  it("rejects immediately if signal is already aborted when connecting", async () => {
    const container = new Container()
    const service = container.bind(GQLRequestExecutionService)
    const tab = createMockGQLTab()

    const controller = new AbortController()
    controller.abort()

    await expect(service.connect(tab, controller.signal)).rejects.toThrow(
      "The connection was cancelled."
    )
    expect(connection.state).not.toBe("CONNECTED")
  })

  it("rejects immediately if signal is already aborted when executing query", async () => {
    const container = new Container()
    const service = container.bind(GQLRequestExecutionService)
    const tab = createMockGQLTab()

    // Mock connected state
    connection.state = "CONNECTED"

    const controller = new AbortController()
    controller.abort()

    await expect(
      service.executeConnected(tab, null, controller.signal)
    ).rejects.toThrow("The GraphQL operation was cancelled.")

    connection.state = "DISCONNECTED"
  })

  it("rejects immediately if signal is already aborted when starting subscription", async () => {
    const container = new Container()
    const service = container.bind(GQLRequestExecutionService)
    const tab = createMockGQLTab(
      "subscription OnMessage { messageReceived { id text } }"
    )

    // Mock connected state
    connection.state = "CONNECTED"

    const controller = new AbortController()
    controller.abort()

    await expect(
      service.startSubscriptionConnected(tab, controller.signal)
    ).rejects.toThrow("The GraphQL subscription was cancelled.")

    connection.state = "DISCONNECTED"
  })
})
