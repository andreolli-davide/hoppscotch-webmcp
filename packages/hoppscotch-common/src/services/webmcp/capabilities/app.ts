import { WebMCPAdapter } from "../adapter"
import { AgentActivityService } from "../human-control"
import { ActiveAppContextService } from "../context"
import { WebMCPErrorCode, WebMCPToolFailure, WebMCPToolResult } from "../types"
import { findSkill, listSkills } from "../skills"
import {
  emptyInputSchema,
  getSkillInputSchema,
  getSkillParser,
  switchWorkspaceInputSchema,
  switchWorkspaceParser,
} from "../schemas"
import { WorkspaceService } from "../../workspace.service"

export type AppCapabilityRuntime = {
  adapter: WebMCPAdapter
  context: ActiveAppContextService
  workspace: WorkspaceService
  activity: AgentActivityService
  validBoundary: (input: unknown) => boolean
  failure: (
    code: WebMCPErrorCode,
    message: string,
    scope?: "app-context",
    retryable?: boolean
  ) => WebMCPToolFailure
  result: <T extends object>(
    scope: "app-context",
    payload: T
  ) => WebMCPToolResult<T>
  redactor: () => { scrub: (value: string, limit: number) => string }
}

export class AppCapability {
  public constructor(private readonly runtime: AppCapabilityRuntime) {}

  public async register(signal: AbortSignal) {
    const { runtime } = this
    await Promise.all([
      runtime.adapter.register(
        {
          name: "inspect_app_context",
          title: "Inspect Hoppscotch context",
          description:
            "Inspect the visible Hoppscotch surface, workspace, selected environment, active live artifact, and capability packs. Results use bounded, redacted projections.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (
              !runtime.validBoundary(input) ||
              Object.keys(input).length !== 0
            )
              return runtime.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            return runtime.result("app-context", {})
          },
        },
        signal
      ),
      runtime.adapter.register(
        {
          name: "list_workspaces",
          title: "List available workspaces",
          description:
            "List personal and team workspaces with their names, roles, and current selection status.",
          inputSchema: emptyInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (
              !runtime.validBoundary(input) ||
              Object.keys(input).length !== 0
            )
              return runtime.failure(
                "INVALID_INPUT",
                "This tool accepts an empty object only."
              )
            const current = runtime.workspace.currentWorkspace.value
            const redactor = runtime.redactor()
            const teams =
              runtime.workspace.acquireTeamListAdapter(null).teamList$.value
            return runtime.result("app-context", {
              workspaces: [
                {
                  id: "personal",
                  name: "Personal Workspace",
                  type: "personal",
                  isCurrent: current.type === "personal",
                },
                ...teams.map((team) => ({
                  id: team.id,
                  name: redactor.scrub(team.name, 64),
                  type: "team",
                  role: team.myRole
                    ? redactor.scrub(team.myRole, 32)
                    : undefined,
                  isCurrent:
                    current.type === "team" && current.teamID === team.id,
                })),
              ],
            })
          },
        },
        signal
      ),
      runtime.adapter.register(
        {
          name: "switch_workspace",
          title: "Switch active workspace",
          description:
            "Switch to the personal workspace or a team workspace by workspace ID.",
          inputSchema: switchWorkspaceInputSchema,
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: Record<string, unknown>) => {
            if (!runtime.validBoundary(input))
              return runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            const parsed = switchWorkspaceParser.safeParse(input)
            if (!parsed.success)
              return runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            if (
              !runtime.context.matches(
                "app-context",
                parsed.data.expectedRevision
              )
            )
              return runtime.failure(
                "STATE_CHANGED",
                "The application context changed; inspect it again."
              )
            if (parsed.data.workspaceID === "personal")
              runtime.workspace.changeWorkspace({ type: "personal" })
            else {
              const team = runtime.workspace
                .acquireTeamListAdapter(null)
                .teamList$.value.find((t) => t.id === parsed.data.workspaceID)
              if (!team)
                return runtime.failure(
                  "INVALID_INPUT",
                  "The requested team workspace was not found."
                )
              runtime.workspace.changeWorkspace({
                type: "team",
                teamID: team.id,
                teamName: team.name,
                role: team.myRole,
              })
            }
            runtime.activity.record({
              tool: "switch_workspace",
              outcome: "changed",
              summary: `Switched workspace to ${parsed.data.workspaceID}`,
              revision: runtime.context.revision("app-context"),
            })
            return runtime.result("app-context", { switched: true })
          },
        },
        signal
      ),
      runtime.adapter.register(
        {
          name: "get_skill",
          title: "Get Hoppscotch skill or documentation",
          description:
            "Retrieve reference documentation, rules, API signatures, and code examples for Hoppscotch capabilities (e.g. 'scripting-sandbox', 'variables-and-environments', 'test-assertions', 'auth-configuration'). Omit name or pass 'list' to view the index of all available skills.",
          inputSchema: getSkillInputSchema,
          annotations: { readOnlyHint: true, untrustedContentHint: false },
          execute: async (input: Record<string, unknown>) => {
            if (!runtime.validBoundary(input))
              return runtime.failure(
                "INVALID_INPUT",
                "The input is not safe JSON data."
              )
            const parsed = getSkillParser.safeParse(input)
            if (!parsed.success)
              return runtime.failure(
                "INVALID_INPUT",
                parsed.error.issues[0]?.message ?? "Invalid input"
              )
            if (!parsed.data.name || parsed.data.name.toLowerCase() === "list")
              return runtime.result("app-context", { skills: listSkills() })
            const skill = findSkill(parsed.data.name)
            if (!skill)
              return runtime.failure(
                "INVALID_INPUT",
                `Skill '${parsed.data.name}' not found. Available skills: ${listSkills()
                  .map((s) => `'${s.name}'`)
                  .join(", ")}.`
              )
            return runtime.result("app-context", { skill })
          },
        },
        signal
      ),
    ])
  }
}
