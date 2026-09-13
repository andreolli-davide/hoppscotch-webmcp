import { AgentActionApprovalService } from "./human-control"
import type { AgentApprovalRequest } from "./human-control"

export type ExecutionLifecycleOptions<TSnapshot, TResult> = {
  approval: AgentActionApprovalService
  request: AgentApprovalRequest | null
  signal: AbortSignal
  capture: () => TSnapshot
  revalidate: (snapshot: TSnapshot) => boolean
  execute: (snapshot: TSnapshot) => TResult | Promise<TResult>
  denied: (cancelled: boolean) => TResult
  stale: () => TResult
  error: (error: unknown) => TResult
}

/**
 * Runs a consequential WebMCP operation with one well-defined approval gate.
 * The target snapshot is captured before any await, checked after approval,
 * and handed to the callback so callers cannot accidentally execute a stale
 * target outside the gate.
 */
export async function runWebMCPExecution<TSnapshot, TResult>(
  options: ExecutionLifecycleOptions<TSnapshot, TResult>
): Promise<TResult> {
  if (options.signal.aborted) return options.denied(true)

  let snapshot: TSnapshot
  try {
    snapshot = options.capture()
  } catch (error) {
    return options.error(error)
  }
  if (options.signal.aborted) return options.denied(true)

  try {
    const approved = options.request
      ? await options.approval.request(options.request, options.signal)
      : true
    if (!approved || options.signal.aborted)
      return options.denied(options.signal.aborted)
    if (!options.revalidate(snapshot)) return options.stale()

    if (options.signal.aborted) return options.denied(true)
    return await options.execute(snapshot)
  } catch (error) {
    if (options.signal.aborted) return options.denied(true)
    return options.error(error)
  }
}
