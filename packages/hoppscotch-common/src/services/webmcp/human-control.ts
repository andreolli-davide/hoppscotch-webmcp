import { Service } from "dioc"
import { computed, reactive, ref } from "vue"
import { v4 as uuidV4 } from "uuid"

import { WebMCPActivityEntry } from "./types"

export type AgentApprovalRequest = {
  action: string
  method: string
  target: string
  environment: string
  workspace: string
  grantKey: string
  /** Explain the exact disclosure or consequential operation to the user. */
  description?: string
  /** Sensitive reads must always require an explicit per-operation decision. */
  allowSession?: boolean
}

type ApprovalDecision = "once" | "session" | "deny"

type PendingApproval = AgentApprovalRequest & {
  resolve: (approved: boolean) => void
}

export class AgentActionApprovalService extends Service {
  public static readonly ID = "AGENT_ACTION_APPROVAL_SERVICE"

  private readonly state = ref<PendingApproval | null>(null)
  private readonly grants = new Set<string>()

  public readonly pending = computed(() => this.state.value)

  public request(request: AgentApprovalRequest, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve(false)
    if (request.allowSession !== false && this.grants.has(request.grantKey))
      return Promise.resolve(true)

    return new Promise<boolean>((resolve) => {
      // WebMCP executes one consequential operation at a time in the page.
      // Reject an older pending approval if a client violates that contract.
      this.state.value?.resolve(false)

      const abort = () => this.resolve("deny")
      signal.addEventListener("abort", abort, { once: true })

      this.state.value = {
        ...request,
        resolve: (approved) => {
          signal.removeEventListener("abort", abort)
          resolve(approved)
        },
      }
    })
  }

  public resolve(decision: ApprovalDecision) {
    const pending = this.state.value
    if (!pending) return

    if (decision === "session" && pending.allowSession !== false)
      this.grants.add(pending.grantKey)
    this.state.value = null
    pending.resolve(decision !== "deny")
  }

  public clear() {
    this.resolve("deny")
    this.grants.clear()
  }
}

export class AgentActivityService extends Service {
  public static readonly ID = "AGENT_ACTIVITY_SERVICE"
  private readonly state = ref<WebMCPActivityEntry[]>([])
  private readonly undoActions = reactive(new Map<string, () => boolean>())

  public readonly entries = computed(() => this.state.value)
  public readonly latest = computed(() => this.state.value[0] ?? null)

  public record(
    entry: Omit<WebMCPActivityEntry, "id" | "timestamp" | "canUndo">,
    undo?: () => boolean
  ) {
    const id = uuidV4()
    const next: WebMCPActivityEntry = {
      ...entry,
      id,
      timestamp: Date.now(),
      canUndo: Boolean(undo),
    }
    if (undo) this.undoActions.set(id, undo)

    const entries = [next, ...this.state.value].slice(0, 100)
    const liveIDs = new Set(entries.map(({ id: entryID }) => entryID))
    for (const entryID of this.undoActions.keys()) {
      if (!liveIDs.has(entryID)) this.undoActions.delete(entryID)
    }
    this.state.value = entries
    return id
  }

  public undo(id: string) {
    const action = this.undoActions.get(id)
    if (!action) return false

    this.undoActions.delete(id)
    const succeeded = action()
    this.state.value = this.state.value.map((entry) =>
      entry.id === id ? { ...entry, canUndo: false } : entry
    )
    return succeeded
  }

  public clear() {
    this.state.value = []
    this.undoActions.clear()
  }
}
