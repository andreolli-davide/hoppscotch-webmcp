type IdentityValue = string | number | boolean | null

type WorkspaceIdentity =
  | { readonly type: "personal" }
  | { readonly type: "team"; readonly teamID: string }

export type ApprovalIdentityInput = {
  operation: string
  workspaceID: WorkspaceIdentity
  environmentID?: string | number | undefined
  environmentScope: string
  scope?: string | undefined
  revision: string
  dependencyRevision?: string | number | undefined
  target?: IdentityValue
  action?: IdentityValue
  details?: Record<string, IdentityValue | undefined>
  allowSession?: boolean
}

const normalize = (value: IdentityValue | WorkspaceIdentity | undefined) =>
  value && typeof value === "object"
    ? `${value.type}:${"teamID" in value ? (value.teamID ?? "") : ""}`
    : (value ?? "")

/** Stable authorization identity. Display labels must never be substituted for these fields. */
export const approvalIdentity = (input: ApprovalIdentityInput) =>
  JSON.stringify({
    operation: input.operation,
    workspaceID: normalize(input.workspaceID),
    environmentID: normalize(input.environmentID),
    environmentScope: input.environmentScope,
    scope: normalize(input.scope),
    revision: normalize(input.revision),
    dependencyRevision: normalize(input.dependencyRevision),
    target: normalize(input.target),
    action: normalize(input.action),
    details: Object.fromEntries(
      Object.entries(input.details ?? {})
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
    ),
    nonce: input.allowSession === false ? crypto.randomUUID() : undefined,
  })
