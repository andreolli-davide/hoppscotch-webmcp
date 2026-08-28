import { ref } from "vue"

export type WebMCPToolDefinition = {
  name: string
  title?: string
  description: string
  inputSchema?: object
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean }
  execute: (
    input: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => unknown | Promise<unknown>
}

type ModelContextDocument = Document & {
  modelContext?: {
    registerTool: (
      tool: WebMCPToolDefinition,
      options?: { signal?: AbortSignal }
    ) => Promise<void>
  }
}

export class WebMCPAdapter {
  public readonly diagnostic = ref<
    "idle" | "disabled" | "unsupported" | "ready" | "registration-error"
  >("idle")

  public constructor(private readonly enabled: boolean) {}

  public isAvailable() {
    const webDocument = document as ModelContextDocument
    if (!this.enabled) {
      this.diagnostic.value = "disabled"
      return false
    }
    if (!webDocument.modelContext) {
      this.diagnostic.value = "unsupported"
      return false
    }
    this.diagnostic.value = "ready"
    return true
  }

  public async register(tool: WebMCPToolDefinition, signal: AbortSignal) {
    if (!this.isAvailable()) return false
    try {
      await (document as ModelContextDocument).modelContext!.registerTool(
        tool,
        {
          signal,
        }
      )
      return true
    } catch (error) {
      this.diagnostic.value = "registration-error"
      console.warn(`[WebMCP] Failed to register ${tool.name}`, error)
      return false
    }
  }
}
