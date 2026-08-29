import { Environment } from "@hoppscotch/data"
import { Service } from "dioc"
import { v4 as uuidV4 } from "uuid"

import { TeamAccessRole } from "~/helpers/backend/graphql"
import { TeamEnvironment } from "~/helpers/teams/TeamEnvironment"
import TeamEnvironmentAdapter from "~/helpers/teams/TeamEnvironmentAdapter"
import {
  environmentsStore,
  getCurrentEnvironment,
  getSelectedEnvironmentIndex,
  SelectedEnvironmentIndex,
  setSelectedEnvironmentIndex,
} from "~/newstore/environments"
import { CurrentValueService } from "~/services/current-environment-value.service"
import { SecretEnvironmentService } from "~/services/secret-environment.service"
import { WorkspaceService } from "~/services/workspace.service"

type EnvironmentChoice = {
  key: string
  handle: string
  scope: "none" | "personal" | "team"
  environment: Environment | null
  selection: SelectedEnvironmentIndex
  editable: boolean
}

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
    this.handles.clear()
    this.teamLoad = this.teamEnvironments.changeTeamID(teamID).catch(() => {
      // The adapter already reports and logs its application error. Keep
      // personal environments available if the team list cannot be loaded.
    })
    await this.teamLoad
    this.teamLoad = null
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
