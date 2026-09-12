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

type BrowserWebMCPToolDefinition = Omit<WebMCPToolDefinition, "execute"> & {
  execute: (
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => unknown | Promise<unknown>
}

const composeExecutionSignal = (
  packSignal: AbortSignal,
  callerSignal?: AbortSignal
): AbortSignal => {
  // Keep the pack signal itself for the usual browser invocation path. This
  // allows handlers that return a live background subscription to continue
  // observing pack disposal after execute has settled.
  if (!callerSignal || callerSignal === packSignal) {
    return packSignal
  }

  return AbortSignal.any([packSignal, callerSignal])
}

type ModelContextDocument = Document & {
  modelContext?: {
    registerTool: (
      tool: BrowserWebMCPToolDefinition,
      options?: { signal?: AbortSignal }
    ) => Promise<void>
  }
}

export type WebMCPPreflightStatus =
  | "ready"
  | "disabled"
  | "insecure-context"
  | "unsupported"
  | "registration-error"

export type WebMCPPreflightReport = {
  enabled: boolean
  secureContext: boolean
  modelContextAvailable: boolean
  registerToolAvailable: boolean
  status: WebMCPPreflightStatus
  reason: string
}

export class WebMCPAdapter {
  public readonly diagnostic = ref<
    "idle" | "disabled" | "unsupported" | "ready" | "registration-error"
  >("idle")

  public constructor(private readonly enabled: boolean) {}

  public getPreflightReport(): WebMCPPreflightReport {
    const webDocument = (
      typeof document !== "undefined" ? document : {}
    ) as ModelContextDocument
    const secureContext =
      typeof window !== "undefined"
        ? window.isSecureContext !== undefined
          ? Boolean(window.isSecureContext)
          : true
        : true
    const modelContext = webDocument.modelContext
    const modelContextAvailable = Boolean(modelContext)
    const registerToolAvailable =
      typeof modelContext?.registerTool === "function"

    if (!this.enabled) {
      return {
        enabled: false,
        secureContext,
        modelContextAvailable,
        registerToolAvailable,
        status: "disabled",
        reason:
          "WebMCP is disabled. Enable it by setting VITE_ENABLE_WEBMCP=true.",
      }
    }

    if (!secureContext) {
      return {
        enabled: true,
        secureContext: false,
        modelContextAvailable,
        registerToolAvailable,
        status: "insecure-context",
        reason:
          "WebMCP requires a secure origin (HTTPS or localhost). Current window origin is not secure.",
      }
    }

    if (!modelContextAvailable || !registerToolAvailable) {
      return {
        enabled: true,
        secureContext,
        modelContextAvailable,
        registerToolAvailable,
        status: "unsupported",
        reason:
          "document.modelContext is not supported by this browser. Ensure Chrome 153+ with chrome://flags/#enable-webmcp-testing enabled or an active Origin Trial token.",
      }
    }

    return {
      enabled: true,
      secureContext,
      modelContextAvailable,
      registerToolAvailable,
      status:
        this.diagnostic.value === "registration-error"
          ? "registration-error"
          : "ready",
      reason:
        this.diagnostic.value === "registration-error"
          ? "One or more tools failed to register with document.modelContext."
          : "WebMCP is ready and supported in this environment.",
    }
  }

  public isAvailable() {
    const report = this.getPreflightReport()
    if (report.status === "ready") {
      this.diagnostic.value = "ready"
      return true
    }
    if (report.status === "disabled") {
      this.diagnostic.value = "disabled"
      return false
    }
    this.diagnostic.value = "unsupported"
    return false
  }

  public async register(tool: WebMCPToolDefinition, signal: AbortSignal) {
    if (!this.isAvailable()) return false
    try {
      const registeredTool: BrowserWebMCPToolDefinition = {
        ...tool,
        execute: async (input, options) => {
          const executionSignal = composeExecutionSignal(
            signal,
            options?.signal
          )
          if (executionSignal.aborted) {
            throw executionSignal.reason
          }
          return await tool.execute(input, { signal: executionSignal })
        },
      }

      await (document as ModelContextDocument).modelContext!.registerTool(
        registeredTool,
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
