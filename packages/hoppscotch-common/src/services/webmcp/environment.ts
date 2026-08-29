import { Environment } from "@hoppscotch/data"
import { Service } from "dioc"
import { v4 as uuidV4 } from "uuid"
import * as E from "fp-ts/Either"
import { cloneDeep } from "lodash-es"

import { TeamAccessRole } from "~/helpers/backend/graphql"
import { TeamEnvironment } from "~/helpers/teams/TeamEnvironment"
import TeamEnvironmentAdapter from "~/helpers/teams/TeamEnvironmentAdapter"
import {
  createTeamEnvironment,
  updateTeamEnvironment,
} from "~/helpers/backend/mutations/TeamEnvironment"
import { stripClientLocalValuesForWire } from "~/helpers/clientLocalVariables"
import {
  createEnvironment,
  environmentsStore,
  getCurrentEnvironment,
  getSelectedEnvironmentIndex,
  SelectedEnvironmentIndex,
  setEnvironmentVariables,
  setSelectedEnvironmentIndex,
} from "~/newstore/environments"
import { CurrentValueService } from "~/services/current-environment-value.service"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { WorkspaceService } from "~/services/workspace.service"

export type EnvironmentChoice = {
  key: string
  handle: string
  scope: "none" | "personal" | "team"
  environment: Environment | null
  selection: SelectedEnvironmentIndex
  editable: boolean
}

export type VariableMutationOp =
  | { op: "add"; key: string; value: string; secret?: boolean }
  | { op: "update"; key: string; value: string; secret?: boolean }
  | { op: "remove"; key: string }

const MAX_ENVIRONMENTS = 4
const MAX_VARIABLES = 4

export class WebMCPEnvironmentService extends Service {
  public static readonly ID = "WEBMCP_ENVIRONMENT_SERVICE"

  private readonly workspace = this.bind(WorkspaceService)
  private readonly secrets = this.bind(SecretEnvironmentService)
  private readonly currentValues = this.bind(CurrentValueService)
  private readonly teamEnvironments = new TeamEnvironmentAdapter(undefined)
  private readonly handles = new Map<string, string>()
  private activeTeamID: string | undefined
  private teamLoad: Promise<void> | null = null

  public async list(offset = 0) {
    await this.loadCurrentTeamEnvironments()
    const choices = this.choices()
    return {
      environments: choices
        .slice(offset, offset + MAX_ENVIRONMENTS)
        .map((choice) => ({
          handle: choice.handle,
          name: choice.environment?.name ?? "No environment",
          scope: choice.scope,
          editable: choice.editable,
          selected: this.isSelected(choice.selection),
          variableCount: choice.environment?.variables.length ?? 0,
          secretVariableCount:
            choice.environment?.variables.filter((variable) => variable.secret)
              .length ?? 0,
        })),
      nextOffset:
        offset + MAX_ENVIRONMENTS < choices.length
          ? offset + MAX_ENVIRONMENTS
          : null,
    }
  }

  public inspectSelected(referencedNames?: Set<string>) {
    const environment = getCurrentEnvironment()
    const selected = getSelectedEnvironmentIndex()
    const scope =
      selected.type === "NO_ENV_SELECTED"
        ? "none"
        : selected.type === "TEAM_ENV"
          ? "team"
          : "personal"
    const variables = environment.variables
      .map((variable, index) => ({ variable, index }))
      .filter(({ variable }) =>
        referencedNames ? referencedNames.has(variable.key) : true
      )

    return {
      name: environment.name,
      scope,
      variables: variables
        .slice(0, MAX_VARIABLES)
        .map(({ variable, index }) => {
          const secretValue = variable.secret
            ? this.secrets.getSecretEnvironmentVariableValue(
                environment.id,
                index
              )
            : null
          const currentValue = variable.secret
            ? secretValue?.value
            : (this.currentValues.getEnvironmentVariableValue(
                environment.id,
                index
              ) ?? variable.currentValue)
          const initialValue = variable.secret
            ? secretValue?.initialValue
            : variable.initialValue
          return {
            name: variable.key,
            secret: variable.secret,
            currentValueAvailable: Boolean(currentValue),
            initialValueAvailable: Boolean(initialValue),
          }
        }),
      variableCount: variables.length,
      truncated: variables.length > MAX_VARIABLES,
      valuesOmitted: true,
    }
  }

  public select(handle: string) {
    const choice = this.choices().find(
      (candidate) => candidate.handle === handle
    )
    if (!choice) return false
    setSelectedEnvironmentIndex(choice.selection)
    return true
  }

  public async resolveHandle(
    handle: string
  ): Promise<EnvironmentChoice | null> {
    await this.loadCurrentTeamEnvironments()
    return (
      this.choices().find((candidate) => candidate.handle === handle) ?? null
    )
  }

  public getRawVariables(envID: string, variables: Environment["variables"]) {
    return variables.map((variable, index) => {
      if (variable.secret) {
        const secretVal = this.secrets.getSecretEnvironmentVariableValue(
          envID,
          index
        )
        return {
          key: variable.key,
          initialValue: secretVal?.initialValue ?? "",
          currentValue: secretVal?.value ?? "",
          secret: true,
        }
      }
      const currentVal = this.currentValues.getEnvironmentVariableValue(
        envID,
        index
      )
      return {
        key: variable.key,
        initialValue: variable.initialValue,
        currentValue:
          currentVal ?? variable.currentValue ?? variable.initialValue,
        secret: false,
      }
    })
  }

  public populateLocalStores(
    envID: string,
    variables: readonly {
      key: string
      initialValue: string
      currentValue: string
      secret: boolean
    }[]
  ) {
    if (!envID) return

    const secrets = variables.flatMap((v, index) =>
      v.secret
        ? [
            {
              key: v.key,
              value: v.currentValue ?? v.initialValue ?? "",
              initialValue: v.initialValue ?? "",
              varIndex: index,
            },
          ]
        : []
    )

    const nonSecrets = variables.flatMap((v, index) =>
      !v.secret
        ? [
            {
              key: v.key,
              currentValue: v.currentValue ?? v.initialValue ?? "",
              varIndex: index,
              isSecret: false as const,
            },
          ]
        : []
    )

    this.secrets.addSecretEnvironment(envID, secrets)
    this.currentValues.addEnvironment(envID, nonSecrets)
  }

  public createPersonal(
    name: string,
    variables: Array<{ key: string; value: string; secret?: boolean }>
  ) {
    const envID = uuidV4()
    const rawVars = variables.map((v) => ({
      key: v.key,
      initialValue: v.value,
      currentValue: v.value,
      secret: v.secret ?? false,
    }))

    this.populateLocalStores(envID, rawVars)
    const wireVars = stripClientLocalValuesForWire(rawVars)
    createEnvironment(name, wireVars, envID)

    const createdEnv: Environment = {
      v: 2,
      id: envID,
      name,
      variables: wireVars,
    }

    const choice = this.choice(
      `personal:${envID}`,
      "personal",
      createdEnv,
      {
        type: "MY_ENV",
        index: environmentsStore.value.environments.length - 1,
      },
      true
    )

    return {
      id: envID,
      name,
      handle: choice.handle,
      variableCount: wireVars.length,
      secretVariableCount: rawVars.filter((v) => v.secret).length,
    }
  }

  public async createTeam(
    name: string,
    variables: Array<{ key: string; value: string; secret?: boolean }>
  ) {
    const workspace = this.workspace.currentWorkspace.value
    if (workspace.type !== "team") {
      return { error: "NOT_IN_TEAM_WORKSPACE" as const }
    }
    if (workspace.role === TeamAccessRole.Viewer) {
      return { error: "PERMISSION_DENIED" as const }
    }

    const rawVars = variables.map((v) => ({
      key: v.key,
      initialValue: v.value,
      currentValue: v.value,
      secret: v.secret ?? false,
    }))
    const wireVars = stripClientLocalValuesForWire(rawVars)

    const res = await createTeamEnvironment(
      JSON.stringify(wireVars),
      workspace.teamID,
      name
    )()

    if (E.isLeft(res)) {
      const errorMsg =
        typeof res.left.error === "string"
          ? res.left.error
          : "Failed to create team environment"
      return { error: errorMsg }
    }

    const teamEnvID = res.right.createTeamEnvironment.id
    this.populateLocalStores(teamEnvID, rawVars)

    await this.teamEnvironments.fetchList().catch(() => {})

    const choice = this.choice(
      `team:${workspace.teamID}:${teamEnvID}`,
      "team",
      {
        v: 2,
        id: teamEnvID,
        name,
        variables: wireVars,
      },
      {
        type: "TEAM_ENV",
        teamID: workspace.teamID,
        teamEnvID,
        environment: {
          v: 2,
          id: teamEnvID,
          name,
          variables: wireVars,
        },
      },
      true
    )

    return {
      id: teamEnvID,
      name,
      handle: choice.handle,
      variableCount: wireVars.length,
      secretVariableCount: rawVars.filter((v) => v.secret).length,
    }
  }

  public async mutateVariables(
    handle: string,
    operations: VariableMutationOp[]
  ): Promise<
    | {
        ok: true
        environmentName: string
        updatedKeys: string[]
        variableCount: number
        secretVariableCount: number
        undo: () => boolean | Promise<boolean>
      }
    | { ok: false; error: string; code?: string }
  > {
    const choice = await this.resolveHandle(handle)
    if (!choice || !choice.environment) {
      return {
        ok: false,
        error: "Environment not found or cannot be modified.",
        code: "ENVIRONMENT_NOT_FOUND",
      }
    }

    if (!choice.editable) {
      return {
        ok: false,
        error: "You do not have permission to edit this environment.",
        code: "PERMISSION_DENIED",
      }
    }

    const envID = choice.environment.id
    const existingRawVars = this.getRawVariables(
      envID,
      choice.environment.variables
    )
    const workingVars = cloneDeep(existingRawVars)
    const updatedKeys: string[] = []

    for (const op of operations) {
      if (op.op === "add") {
        if (workingVars.some((v) => v.key === op.key)) {
          return {
            ok: false,
            error: `Variable '${op.key}' already exists in environment. Use 'update' to modify it.`,
            code: "INVALID_INPUT",
          }
        }
        workingVars.push({
          key: op.key,
          initialValue: op.value,
          currentValue: op.value,
          secret: op.secret ?? false,
        })
        updatedKeys.push(op.key)
      } else if (op.op === "update") {
        const target = workingVars.find((v) => v.key === op.key)
        if (!target) {
          return {
            ok: false,
            error: `Variable '${op.key}' not found in environment.`,
            code: "INVALID_INPUT",
          }
        }
        if (target.secret && op.secret === false) {
          return {
            ok: false,
            error: `Cannot convert secret variable '${op.key}' to a non-secret variable.`,
            code: "INVALID_INPUT",
          }
        }
        target.initialValue = op.value
        target.currentValue = op.value
        if (op.secret !== undefined) {
          target.secret = op.secret
        }
        updatedKeys.push(op.key)
      } else if (op.op === "remove") {
        const index = workingVars.findIndex((v) => v.key === op.key)
        if (index === -1) {
          return {
            ok: false,
            error: `Variable '${op.key}' not found in environment.`,
            code: "INVALID_INPUT",
          }
        }
        workingVars.splice(index, 1)
        updatedKeys.push(op.key)
      }
    }

    const previousRawVars = cloneDeep(existingRawVars)
    const newWireVars = stripClientLocalValuesForWire(workingVars)

    if (choice.scope === "personal") {
      const envIndex = environmentsStore.value.environments.findIndex(
        (e) => e.id === envID
      )
      if (envIndex === -1) {
        return {
          ok: false,
          error: "Personal environment not found in store.",
          code: "ENVIRONMENT_NOT_FOUND",
        }
      }

      this.populateLocalStores(envID, workingVars)
      setEnvironmentVariables(envIndex, newWireVars)

      const undo = () => {
        const curIndex = environmentsStore.value.environments.findIndex(
          (e) => e.id === envID
        )
        if (curIndex === -1) return false
        this.populateLocalStores(envID, previousRawVars)
        setEnvironmentVariables(
          curIndex,
          stripClientLocalValuesForWire(previousRawVars)
        )
        return true
      }

      return {
        ok: true,
        environmentName: choice.environment.name,
        updatedKeys,
        variableCount: workingVars.length,
        secretVariableCount: workingVars.filter((v) => v.secret).length,
        undo,
      }
    } else if (choice.scope === "team") {
      const workspace = this.workspace.currentWorkspace.value
      if (
        workspace.type !== "team" ||
        workspace.role === TeamAccessRole.Viewer
      ) {
        return {
          ok: false,
          error: "You do not have permission to edit team environments.",
          code: "PERMISSION_DENIED",
        }
      }

      this.populateLocalStores(envID, workingVars)
      const res = await updateTeamEnvironment(
        JSON.stringify(newWireVars),
        envID,
        choice.environment.name
      )()

      if (E.isLeft(res)) {
        const errorMsg =
          typeof res.left.error === "string"
            ? res.left.error
            : "Failed to update team environment"
        return {
          ok: false,
          error: errorMsg,
          code: "MUTATION_FAILED",
        }
      }

      const undo = async () => {
        this.populateLocalStores(envID, previousRawVars)
        const undoRes = await updateTeamEnvironment(
          JSON.stringify(stripClientLocalValuesForWire(previousRawVars)),
          envID,
          choice.environment!.name
        )()
        return E.isRight(undoRes)
      }

      return {
        ok: true,
        environmentName: choice.environment.name,
        updatedKeys,
        variableCount: workingVars.length,
        secretVariableCount: workingVars.filter((v) => v.secret).length,
        undo,
      }
    }

    return {
      ok: false,
      error: "Unsupported environment scope.",
      code: "INVALID_INPUT",
    }
  }

  private choices(): EnvironmentChoice[] {
    const choices: EnvironmentChoice[] = [
      this.choice("none", "none", null, { type: "NO_ENV_SELECTED" }, true),
      ...environmentsStore.value.environments.map((environment, index) =>
        this.choice(
          `personal:${environment.id}`,
          "personal",
          environment,
          { type: "MY_ENV", index },
          true
        )
      ),
    ]

    const workspace = this.workspace.currentWorkspace.value
    if (workspace.type === "team") {
      const teamEnvironments = [
        ...this.teamEnvironments.teamEnvironmentList$.value,
      ].filter(({ teamID }) => teamID === workspace.teamID)
      const selected = getSelectedEnvironmentIndex()
      if (
        selected.type === "TEAM_ENV" &&
        selected.teamID === workspace.teamID &&
        !teamEnvironments.some(({ id }) => id === selected.teamEnvID)
      ) {
        teamEnvironments.push({
          id: selected.teamEnvID,
          teamID: selected.teamID,
          environment: selected.environment,
        })
      }
      choices.push(
        ...teamEnvironments.map((teamEnvironment) =>
          this.teamChoice(
            teamEnvironment,
            workspace.role !== TeamAccessRole.Viewer
          )
        )
      )
    }
    return choices
  }

  private async loadCurrentTeamEnvironments() {
    const workspace = this.workspace.currentWorkspace.value
    const teamID = workspace.type === "team" ? workspace.teamID : undefined
    if (teamID === this.activeTeamID) {
      await this.teamLoad
      return
    }

    this.activeTeamID = teamID
    for (const [key] of Array.from(this.handles.entries())) {
      if (key.startsWith("team:")) {
        this.handles.delete(key)
      }
    }
    const currentLoad = this.teamEnvironments.changeTeamID(teamID).catch(() => {
      // The adapter already reports and logs its application error. Keep
      // personal environments available if the team list cannot be loaded.
    })
    this.teamLoad = currentLoad
    await currentLoad
    if (this.teamLoad === currentLoad) {
      this.teamLoad = null
    }
  }

  private teamChoice(teamEnvironment: TeamEnvironment, editable: boolean) {
    return this.choice(
      `team:${teamEnvironment.teamID}:${teamEnvironment.id}`,
      "team",
      teamEnvironment.environment,
      {
        type: "TEAM_ENV",
        teamID: teamEnvironment.teamID,
        teamEnvID: teamEnvironment.id,
        environment: teamEnvironment.environment,
      },
      editable
    )
  }

  private choice(
    key: string,
    scope: EnvironmentChoice["scope"],
    environment: Environment | null,
    selection: SelectedEnvironmentIndex,
    editable: boolean
  ): EnvironmentChoice {
    let handle = this.handles.get(key)
    if (!handle) {
      handle = uuidV4()
      this.handles.set(key, handle)
    }
    return { key, handle, scope, environment, selection, editable }
  }

  private isSelected(selection: SelectedEnvironmentIndex) {
    const selected = getSelectedEnvironmentIndex()
    if (selected.type !== selection.type) return false
    if (selected.type === "MY_ENV" && selection.type === "MY_ENV")
      return selected.index === selection.index
    if (selected.type === "TEAM_ENV" && selection.type === "TEAM_ENV")
      return (
        selected.teamID === selection.teamID &&
        selected.teamEnvID === selection.teamEnvID
      )
    return selected.type === "NO_ENV_SELECTED"
  }
}
