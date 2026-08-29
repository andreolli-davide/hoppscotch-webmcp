import { HoppGQLAuth } from "@hoppscotch/data"
import { Service } from "dioc"
import { OperationDefinitionNode, parse } from "graphql"

import {
  connect,
  connection,
  disconnect,
  runGQLOperation,
  socketDisconnect,
} from "~/helpers/graphql/connection"
import { HoppGQLDocument } from "~/helpers/graphql/document"
import { HoppTab } from "~/services/tab"

/**
 * The semantic GraphQL action boundary shared by WebMCP and the request UI.
 * It deliberately delegates to the established connection helper so auth,
 * interceptors, history, response state, and subscriptions retain their
 * existing behavior while callers no longer need to reach into a component.
 */
export class GQLRequestExecutionService extends Service {
  public static readonly ID = "GQL_REQUEST_EXECUTION_SERVICE"

  private operation(document: HoppGQLDocument): OperationDefinitionNode {
    const definition = parse(document.request.query).definitions.find(
      (item): item is OperationDefinitionNode =>
        item.kind === "OperationDefinition"
    )
    if (!definition) throw new Error("The GraphQL document has no operation.")
    return definition
  }

  private baseOptions(tab: HoppTab<HoppGQLDocument>) {
    const { document } = tab
    return {
      name: document.request.name,
      url: document.request.url,
      request: document.request,
      inheritedHeaders:
        document.inheritedProperties?.headers.map(
          (header) => header.inheritedHeader
        ) ?? [],
      inheritedAuth: document.inheritedProperties?.auth.inheritedAuth as
        | HoppGQLAuth
        | undefined,
    }
  }

  private options(
    tab: HoppTab<HoppGQLDocument>,
    selected?: OperationDefinitionNode | null
  ) {
    const { document } = tab
    const definition = selected ?? this.operation(document)
    return {
      ...this.baseOptions(tab),
      query: document.request.query,
      variables: document.request.variables,
      operationName: definition.name?.value,
      operationType: definition.operation,
    }
  }

  public async connect(tab: HoppTab<HoppGQLDocument>, signal?: AbortSignal) {
    const options = this.baseOptions(tab)
    await connect(
      {
        url: options.url,
        request: options.request,
        inheritedHeaders: options.inheritedHeaders,
        inheritedAuth: options.inheritedAuth,
      },
      false,
      signal
    )
    this.ensureConnected()
  }

  public disconnect() {
    if (connection.state === "CONNECTED") disconnect()
  }

  private ensureConnected() {
    if (connection.state !== "CONNECTED") {
      throw new Error(
        "Connect the GraphQL schema before executing an operation."
      )
    }
  }

  /** UI convenience path: preserve the existing connect-then-run behavior. */
  public async execute(
    tab: HoppTab<HoppGQLDocument>,
    selected?: OperationDefinitionNode | null,
    signal?: AbortSignal
  ) {
    if (connection.state !== "CONNECTED") await this.connect(tab, signal)
    return this.executeConnected(tab, selected, signal)
  }

  /** WebMCP path: execution has one effect and never opens a connection. */
  public async executeConnected(
    tab: HoppTab<HoppGQLDocument>,
    selected?: OperationDefinitionNode | null,
    signal?: AbortSignal
  ) {
    this.ensureConnected()
    const options = this.options(tab, selected)
    if (options.operationType === "subscription") {
      throw new Error(
        "Use the subscription lifecycle actions for subscriptions."
      )
    }
    return runGQLOperation(options, signal)
  }

  public startSubscription(
    tab: HoppTab<HoppGQLDocument>,
    signal?: AbortSignal
  ) {
    if (connection.state !== "CONNECTED")
      return this.connect(tab, signal).then(() =>
        this.startSubscriptionConnected(tab, signal)
      )
    return this.startSubscriptionConnected(tab, signal)
  }

  /** WebMCP path: subscriptions are started only on an established connection. */
  public startSubscriptionConnected(
    tab: HoppTab<HoppGQLDocument>,
    signal?: AbortSignal
  ) {
    this.ensureConnected()
    const options = this.options(tab)
    if (options.operationType !== "subscription") {
      throw new Error("The current GraphQL operation is not a subscription.")
    }
    return runGQLOperation(options, signal)
  }

  public stopSubscription() {
    socketDisconnect()
  }
}
