import { cloneDeep } from "lodash-es"

import {
  getSelectedEnvironmentIndex,
  getSelectedEnvironmentType,
  setSelectedEnvironmentIndex,
  deleteEnvironment,
  environmentsStore,
} from "~/newstore/environments"

import { approvalIdentity } from "../approval-scope"
import { runWebMCPExecution } from "../execution-lifecycle"
import {
  createEnvironmentInputSchema,
  createEnvironmentParser,
  editEnvironmentVariablesInputSchema,
  editEnvironmentVariablesParser,
  inspectEnvironmentInputSchema,
  inspectEnvironmentParser,
  listEnvironmentsInputSchema,
  listEnvironmentsParser,
  selectEnvironmentInputSchema,
  selectEnvironmentParser,
  deleteEnvironmentInputSchema,
  deleteEnvironmentParser,
} from "../schemas"
import type { WebMCPRuntime } from "../runtime"

export class EnvironmentCapability {
  public constructor(private readonly runtime: WebMCPRuntime) {}

  public async registerDurable(signal: AbortSignal) {
    const { runtime } = this
    await runtime.adapter.register(
      {
        name: "delete_environment",
        title: "Delete environment",
        description:
          "Permanently delete a custom environment definition. Requires exact environment confirmation name.",
        inputSchema: deleteEnvironmentInputSchema,
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input, { signal: executionSignal }) => {
          if (!runtime.validBoundary(input)) {
            return runtime.failure(
              "INVALID_INPUT",
              "The input is not safe JSON data."
            )
          }
          const parsed = deleteEnvironmentParser.safeParse(input)
          if (!parsed.success) {
            return runtime.failure(
              "INVALID_INPUT",
              parsed.error.issues[0]?.message ?? "Invalid input"
            )
          }
          if (
            !runtime.context.matches(
              "app-context",
              parsed.data.expectedRevision
            ) &&
            !runtime.context.matches(
              "rest-document",
              parsed.data.expectedRevision
            )
          ) {
            return runtime.failure(
              "STATE_CHANGED",
              "The application context changed; inspect it again.",
              "app-context",
              true
            )
          }

          const envs = environmentsStore.value.environments
          const targetEnv = envs[parsed.data.environmentIndex]
          if (!targetEnv) {
            return runtime.failure(
              "INVALID_INPUT",
              `Environment at index ${parsed.data.environmentIndex} not found.`,
              "app-context"
            )
          }

          if (targetEnv.name !== parsed.data.confirmationName) {
            return runtime.failure(
              "INVALID_INPUT",
              `Confirmation name '${parsed.data.confirmationName}' does not match environment name '${targetEnv.name}'.`,
              "app-context"
            )
          }

          const currentEnvName = runtime.context.capture().environment.name
          const workspaceType = runtime.context.capture().workspace.type

          return runWebMCPExecution({
            approval: runtime.approval,
            request: {
              action: "DELETE environment",
              method: "DELETE",
              target: targetEnv.name,
              environment: currentEnvName,
              workspace: workspaceType,
              grantKey: approvalIdentity({
                operation: "delete_environment",
                environmentScope: getSelectedEnvironmentType(),
                workspaceID: runtime.workspace.currentWorkspace.value,
                environmentID: targetEnv.id,
                revision: runtime.context.revision("app-context"),
                target: targetEnv.name,
                allowSession: false,
              }),
              allowSession: false,
            },
            signal: executionSignal,
            capture: () => ({
              targetEnv,
              revision: runtime.context.revision("app-context"),
            }),
            revalidate: (snapshot) =>
              runtime.context.matches("app-context", snapshot.revision) &&
              environmentsStore.value.environments[
                parsed.data.environmentIndex
              ] === snapshot.targetEnv &&
              snapshot.targetEnv.name === parsed.data.confirmationName,
            denied: (cancelled) => {
              runtime.activity.record({
                tool: "delete_environment",
                outcome: cancelled ? "cancelled" : "denied",
                summary: `Denied deleting environment '${targetEnv.name}'`,
                revision: runtime.context.revision("app-context"),
              })
              return runtime.failure(
                cancelled ? "CANCELLED" : "APPROVAL_DENIED",
                cancelled
                  ? "The deletion was cancelled."
                  : "The user rejected deleting the environment.",
                "app-context"
              )
            },
            stale: () =>
              runtime.failure(
                "STATE_CHANGED",
                "The environment or application context changed while approval was open.",
                "app-context",
                true
              ),
            error: (error) =>
              runtime.failure(
                "INVALID_INPUT",
                error instanceof Error
                  ? error.message
                  : "Environment deletion failed",
                "app-context"
              ),
            execute: (snapshot) => {
              const deletedName = snapshot.targetEnv.name
              deleteEnvironment(
                parsed.data.environmentIndex,
                snapshot.targetEnv.id
              )
              if (snapshot.targetEnv.id) {
                runtime.currentValues.deleteEnvironment(snapshot.targetEnv.id)
                runtime.secrets.deleteSecretEnvironment(snapshot.targetEnv.id)
              }

              runtime.activity.record({
                tool: "delete_environment",
                outcome: "changed",
                summary: `Permanently deleted environment '${deletedName}'`,
                revision: runtime.context.revision("app-context"),
              })

              return runtime.result("app-context", {
                success: true,
                deletedEnvironment: deletedName,
              })
            },
          })
        },
      },
      signal
    )
  }

  public async register(signal: AbortSignal) {
    const { runtime } = this
    await Promise.all([
      runtime.adapter.register(
        {
          name: "list_environments",
          title: "List available environments",
          description:
            "List personal and current-workspace environment choices as bounded metadata with opaque handles, names, scope, selection, and variable counts.",
          inputSchema: listEnvironmentsInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (!runtime.validBoundary(input)) {
              return runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            }
            const parsed = listEnvironmentsParser.safeParse(input)
            if (!parsed.success) {
              return runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            }
            const rest = runtime.visibleREST()
            if ("ok" in rest) return rest
            const listed = await runtime.environments.list(parsed.data.offset)
            const current = runtime.visibleREST()
            if ("ok" in current) return current
            const redactor = runtime.redactor()
            listed.environments = listed.environments.map((environment) => ({
              ...environment,
              name: redactor.scrub(environment.name, 64),
            }))
            return runtime.result("app-context", listed)
          },
        },
        signal
      ),
      runtime.adapter.register(
        {
          name: "inspect_environment",
          title: "Inspect selected environment",
          description:
            "Inspect the selected environment through variable names, classification, and value-availability metadata.",
          inputSchema: inspectEnvironmentInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.inspectEnvironment(input),
        },
        signal
      ),
      runtime.adapter.register(
        {
          name: "select_environment",
          title: "Select an environment",
          description:
            "Select an app-provided environment for the visible REST workspace using a revision-bound opaque handle. This visibly updates normal app state.",
          inputSchema: selectEnvironmentInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) =>
            this.selectEnvironment(input),
        },
        signal
      ),
      runtime.adapter.register(
        {
          name: "create_environment",
          title: "Create an environment",
          description:
            "Create a personal or team environment with optional initial variables and secrets. Secrets and team environments require human confirmation.",
          inputSchema: createEnvironmentInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) =>
            this.createEnvironment(input, executionSignal),
        },
        signal
      ),
      runtime.adapter.register(
        {
          name: "edit_environment_variables",
          title: "Edit environment variables and secrets",
          description:
            "Batch add, update, or remove variables and secrets in an environment using an opaque environment handle. Secret updates and team environments require human confirmation; secrets cannot be downgraded to non-secrets.",
          inputSchema: editEnvironmentVariablesInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input, { signal: executionSignal }) =>
            this.editEnvironmentVariables(input, executionSignal),
        },
        signal
      ),
    ])
  }
  private async inspectEnvironment(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = inspectEnvironmentParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    const referencedNames = parsed.data.referencedOnly
      ? new Set(
          [
            ...JSON.stringify(rest.tab.document.request).matchAll(
              /<<([^<>]+)>>/g
            ),
          ].map((match) => match[1])
        )
      : undefined
    const environment =
      this.runtime.environments.inspectSelected(referencedNames)
    const redactor = this.runtime.redactor()
    environment.name = redactor.scrub(environment.name, 64)
    environment.variables = environment.variables.map((variable) => ({
      ...variable,
      name: redactor.scrub(variable.name, 64),
    }))
    return this.runtime.result("rest-document", { environment })
  }

  private async selectEnvironment(input: Record<string, unknown>) {
    if (!this.runtime.validBoundary(input))
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    const parsed = selectEnvironmentParser.safeParse(input)
    if (!parsed.success)
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches("app-context", parsed.data.expectedRevision)
    ) {
      return this.runtime.failure(
        "STATE_CHANGED",
        "The app context changed; list environments again.",
        "app-context",
        true
      )
    }

    const original = cloneDeep(getSelectedEnvironmentIndex())
    if (!this.runtime.environments.select(parsed.data.environmentHandle)) {
      return this.runtime.failure(
        "ENVIRONMENT_NOT_FOUND",
        "The environment handle is no longer available; list environments again.",
        "app-context",
        true
      )
    }
    const resultingRevision = this.runtime.context.revision("app-context")
    const token = rest.token
    const selectedName = this.runtime
      .redactor()
      .scrub(this.runtime.context.capture().environment.name, 64)
    this.runtime.activity.record(
      {
        tool: "select_environment",
        outcome: "changed",
        summary: `Selected environment ${selectedName}`.slice(0, 256),
        revision: resultingRevision,
      },
      () => {
        if (
          this.runtime.context.captureVisibleREST()?.token !== token ||
          !this.runtime.context.matches("app-context", resultingRevision)
        )
          return false
        setSelectedEnvironmentIndex(original)
        return true
      }
    )
    return this.runtime.result("app-context", { selected: true })
  }

  private async createEnvironment(
    input: Record<string, unknown>,
    executionSignal?: AbortSignal
  ) {
    if (!this.runtime.validBoundary(input)) {
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    }
    const parsed = createEnvironmentParser.safeParse(input)
    if (!parsed.success) {
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches(
        "app-context",
        parsed.data.expectedRevision
      ) &&
      !this.runtime.context.matches(
        "rest-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
        "STATE_CHANGED",
        "The application context changed; inspect it again.",
        "app-context",
        true
      )
    }

    const hasSecrets = parsed.data.variables.some((v) => v.secret)
    const isTeam = parsed.data.scope === "team"
    const currentEnvName = this.runtime.context.capture().environment.name
    const workspaceType = this.runtime.context.capture().workspace.type

    const executeCreation = async () => {
      let created: {
        id: string
        name: string
        handle: string
        variableCount: number
        secretVariableCount: number
      }

      if (parsed.data.scope === "personal") {
        created = this.runtime.environments.createPersonal(
          parsed.data.name,
          parsed.data.variables
        )
      } else {
        const res = await this.runtime.environments.createTeam(
          parsed.data.name,
          parsed.data.variables
        )
        if ("error" in res) {
          if (res.error === "PERMISSION_DENIED") {
            return this.runtime.failure(
              "PERMISSION_DENIED",
              "You do not have permission to create team environments.",
              "app-context"
            )
          }
          return this.runtime.failure(
            "INVALID_INPUT",
            `Failed to create team environment: ${res.error}`,
            "app-context"
          )
        }
        created = res
      }

      const resultingRevision = this.runtime.context.revision("app-context")
      this.runtime.activity.record({
        tool: "create_environment",
        outcome: "changed",
        summary: `Created ${parsed.data.scope} environment '${created.name}' with ${created.variableCount} variables`,
        revision: resultingRevision,
      })

      return this.runtime.result("app-context", {
        environmentHandle: created.handle,
        name: this.runtime.redactor().scrub(created.name, 64),
        scope: parsed.data.scope,
        variableCount: created.variableCount,
        secretVariableCount: created.secretVariableCount,
        valuesOmitted: true,
      })
    }
    if (!isTeam && !hasSecrets)
      return runWebMCPExecution({
        approval: this.runtime.approval,
        request: null,
        signal: executionSignal ?? new AbortController().signal,
        capture: () => ({
          revision: this.runtime.context.revision("app-context"),
        }),
        revalidate: (snapshot) =>
          this.runtime.context.matches("app-context", snapshot.revision),
        denied: (cancelled) =>
          this.runtime.failure(
            cancelled ? "CANCELLED" : "APPROVAL_DENIED",
            cancelled ? "The action was cancelled." : "The action was denied.",
            "app-context"
          ),
        stale: () =>
          this.runtime.failure(
            "STATE_CHANGED",
            "The application context changed.",
            "app-context",
            true
          ),
        error: (error) =>
          this.runtime.failure(
            "EXECUTION_FAILED",
            error instanceof Error
              ? error.message
              : "Environment creation failed",
            "app-context"
          ),
        execute: () => executeCreation(),
      })
    return runWebMCPExecution({
      approval: this.runtime.approval,
      request: {
        action: isTeam
          ? "CREATE team environment"
          : "CREATE personal environment with secrets",
        method: "CREATE",
        target: parsed.data.name,
        environment: currentEnvName,
        workspace: workspaceType,
        grantKey: approvalIdentity({
          operation: "create_environment",
          environmentScope: getSelectedEnvironmentType(),
          workspaceID: this.runtime.workspace.currentWorkspace.value,
          scope: parsed.data.scope,
          revision: this.runtime.context.revision("app-context"),
          target: parsed.data.name,
        }),
        description: hasSecrets
          ? `Create environment '${parsed.data.name}' containing secret variable(s)`
          : `Create team environment '${parsed.data.name}' in team workspace`,
      },
      signal: executionSignal ?? new AbortController().signal,
      capture: () => ({
        revision: this.runtime.context.revision("app-context"),
      }),
      revalidate: (snapshot) =>
        this.runtime.context.matches("app-context", snapshot.revision),
      denied: (cancelled) =>
        this.runtime.failure(
          cancelled ? "CANCELLED" : "APPROVAL_DENIED",
          cancelled
            ? "The action was cancelled."
            : "The user rejected creating the environment.",
          "app-context"
        ),
      stale: () =>
        this.runtime.failure(
          "STATE_CHANGED",
          "The application context changed while approval was open.",
          "app-context",
          true
        ),
      error: (error) =>
        this.runtime.failure(
          "EXECUTION_FAILED",
          error instanceof Error
            ? error.message
            : "Environment creation failed",
          "app-context"
        ),
      execute: () => executeCreation(),
    })
  }

  private async editEnvironmentVariables(
    input: Record<string, unknown>,
    executionSignal?: AbortSignal
  ) {
    if (!this.runtime.validBoundary(input)) {
      return this.runtime.failure(
        "INVALID_INPUT",
        "The input is not safe JSON data."
      )
    }
    const parsed = editEnvironmentVariablesParser.safeParse(input)
    if (!parsed.success) {
      return this.runtime.failure(
        "INVALID_INPUT",
        parsed.error.issues[0]?.message ?? "Invalid input"
      )
    }
    const rest = this.runtime.visibleREST()
    if ("ok" in rest) return rest
    if (
      !this.runtime.context.matches(
        "app-context",
        parsed.data.expectedRevision
      ) &&
      !this.runtime.context.matches(
        "rest-document",
        parsed.data.expectedRevision
      )
    ) {
      return this.runtime.failure(
        "STATE_CHANGED",
        "The application context changed; inspect it again.",
        "app-context",
        true
      )
    }

    const appContextRevision = this.runtime.context.revision("app-context")
    const dependencyRevision = this.runtime.context.revision("rest-document")
    const choice = await this.runtime.environments.resolveHandle(
      parsed.data.environmentHandle
    )
    if (!choice || !choice.environment) {
      return this.runtime.failure(
        "ENVIRONMENT_NOT_FOUND",
        "The environment handle is no longer available; list environments again.",
        "app-context",
        true
      )
    }

    if (!choice.editable) {
      return this.runtime.failure(
        "PERMISSION_DENIED",
        "You do not have permission to edit this environment.",
        "app-context"
      )
    }

    const hasSecretOps = parsed.data.operations.some(
      (op) =>
        (op.op === "add" && op.secret) ||
        (op.op === "update" && op.secret) ||
        (op.op === "update" &&
          choice.environment?.variables.find((v) => v.key === op.key)?.secret)
    )
    const isTeam = choice.scope === "team"
    const currentEnvName = this.runtime.context.capture().environment.name
    const workspaceType = this.runtime.context.capture().workspace.type

    const executeEdit = async () => {
      const res = await this.runtime.environments.mutateVariables(
        parsed.data.environmentHandle,
        parsed.data.operations
      )

      if (!res.ok) {
        if (res.code === "PERMISSION_DENIED") {
          return this.runtime.failure(
            "PERMISSION_DENIED",
            res.error,
            "app-context"
          )
        }
        return this.runtime.failure("INVALID_INPUT", res.error, "app-context")
      }

      const resultingRevision = this.runtime.context.revision("app-context")
      const envName = this.runtime.redactor().scrub(res.environmentName, 64)
      this.runtime.activity.record(
        {
          tool: "edit_environment_variables",
          outcome: "changed",
          summary: `Updated variables [${res.updatedKeys.join(", ")}] in environment '${envName}'`,
          revision: resultingRevision,
        },
        () => {
          const undoResult = res.undo()
          return typeof undoResult === "boolean" ? undoResult : true
        }
      )

      return this.runtime.result("app-context", {
        environmentHandle: parsed.data.environmentHandle,
        environmentName: envName,
        updatedKeys: res.updatedKeys.map((k) =>
          this.runtime.redactor().scrub(k, 64)
        ),
        variableCount: res.variableCount,
        secretVariableCount: res.secretVariableCount,
        valuesOmitted: true,
      })
    }
    if (!isTeam && !hasSecretOps)
      return runWebMCPExecution({
        approval: this.runtime.approval,
        request: null,
        signal: executionSignal ?? new AbortController().signal,
        capture: () => ({
          choice,
          revision: appContextRevision,
          dependencyRevision,
        }),
        revalidate: (snapshot) =>
          this.runtime.context.matches("app-context", snapshot.revision) &&
          this.runtime.context.matches(
            "rest-document",
            snapshot.dependencyRevision
          ) &&
          snapshot.choice.environment?.id === choice.environment?.id,
        denied: (cancelled) =>
          this.runtime.failure(
            cancelled ? "CANCELLED" : "APPROVAL_DENIED",
            cancelled ? "The action was cancelled." : "The action was denied.",
            "app-context"
          ),
        stale: () =>
          this.runtime.failure(
            "STATE_CHANGED",
            "The environment changed.",
            "app-context",
            true
          ),
        error: (error) =>
          this.runtime.failure(
            "EXECUTION_FAILED",
            error instanceof Error ? error.message : "Environment edit failed",
            "app-context"
          ),
        execute: () => executeEdit(),
      })
    const keysAffected = parsed.data.operations.map((o) => o.key).join(", ")
    return runWebMCPExecution({
      approval: this.runtime.approval,
      request: {
        action: isTeam
          ? "EDIT team environment variables"
          : "EDIT environment secrets",
        method: "UPDATE",
        target: `${choice.environment.name} (${keysAffected})`,
        environment: currentEnvName,
        workspace: workspaceType,
        grantKey: approvalIdentity({
          operation: "edit_environment_variables",
          environmentScope: getSelectedEnvironmentType(),
          workspaceID: this.runtime.workspace.currentWorkspace.value,
          environmentID: choice.environment.id,
          revision: appContextRevision,
          details: { keys: keysAffected },
        }),
        description: isTeam
          ? `Modify variables in team environment '${choice.environment.name}'`
          : `Modify secret variable(s) in environment '${choice.environment.name}'`,
      },
      signal: executionSignal ?? new AbortController().signal,
      capture: () => ({
        choice,
        revision: appContextRevision,
        dependencyRevision,
      }),
      revalidate: (snapshot) =>
        this.runtime.context.matches("app-context", snapshot.revision) &&
        this.runtime.context.matches(
          "rest-document",
          snapshot.dependencyRevision
        ) &&
        snapshot.choice.environment?.id === choice.environment?.id,
      denied: (cancelled) =>
        this.runtime.failure(
          cancelled ? "CANCELLED" : "APPROVAL_DENIED",
          cancelled
            ? "The action was cancelled."
            : "The user rejected editing the environment variables.",
          "app-context"
        ),
      stale: () =>
        this.runtime.failure(
          "STATE_CHANGED",
          "The environment changed while approval was open.",
          "app-context",
          true
        ),
      error: (error) =>
        this.runtime.failure(
          "EXECUTION_FAILED",
          error instanceof Error ? error.message : "Environment edit failed",
          "app-context"
        ),
      execute: () => executeEdit(),
    })
  }
}
