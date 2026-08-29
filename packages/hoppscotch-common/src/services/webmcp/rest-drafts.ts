import { HoppGQLAuth, HoppRESTAuth, HoppRESTRequest } from "@hoppscotch/data"
import { cloneDeep } from "lodash-es"

import { configureRESTAuthParser } from "./schemas"

type AuthConfiguration = Omit<
  ReturnType<typeof configureRESTAuthParser.parse>,
  "expectedRevision"
>

const referenceFields: Record<
  AuthConfiguration["authType"],
  readonly string[]
> = {
  inherit: [],
  none: [],
  basic: ["username", "password"],
  digest: ["username", "password"],
  bearer: ["token"],
  "oauth-2": ["token", "clientID", "clientSecret"],
  "api-key": ["key", "value"],
  "aws-signature": [
    "accessKey",
    "secretKey",
    "region",
    "serviceName",
    "serviceToken",
  ],
  hawk: ["authId", "authKey"],
  jwt: ["secret", "privateKey"],
}

const placementTypes = new Set<AuthConfiguration["authType"]>([
  "oauth-2",
  "api-key",
  "aws-signature",
  "jwt",
])

const defaultAuth = (authType: AuthConfiguration["authType"]): HoppRESTAuth => {
  const authActive = true
  switch (authType) {
    case "inherit":
    case "none":
      return { authType, authActive }
    case "basic":
      return { authType, authActive, username: "", password: "" }
    case "digest":
      return {
        authType,
        authActive,
        username: "",
        password: "",
        realm: "",
        nonce: "",
        algorithm: "MD5",
        qop: "auth",
        nc: "",
        cnonce: "",
        opaque: "",
        disableRetry: false,
      }
    case "bearer":
      return { authType, authActive, token: "" }
    case "oauth-2":
      return {
        authType,
        authActive,
        addTo: "HEADERS",
        grantTypeInfo: {
          grantType: "AUTHORIZATION_CODE",
          authEndpoint: "",
          tokenEndpoint: "",
          clientID: "",
          clientSecret: "",
          token: "",
          isPKCE: false,
          codeVerifierMethod: "S256",
          authRequestParams: [],
          tokenRequestParams: [],
          refreshRequestParams: [],
          tokenType: "access_token",
        },
      }
    case "api-key":
      return {
        authType,
        authActive,
        key: "",
        value: "",
        addTo: "HEADERS",
      }
    case "aws-signature":
      return {
        authType,
        authActive,
        accessKey: "",
        secretKey: "",
        region: "",
        serviceName: "",
        serviceToken: "",
        addTo: "HEADERS",
      }
    case "hawk":
      return {
        authType,
        authActive,
        authId: "",
        authKey: "",
        algorithm: "sha256",
        includePayloadHash: false,
      }
    case "jwt":
      return {
        authType,
        authActive,
        secret: "",
        privateKey: "",
        algorithm: "HS256",
        payload: "{}",
        addTo: "HEADERS",
        isSecretBase64Encoded: false,
        headerPrefix: "Bearer ",
        paramName: "token",
        jwtHeaders: "{}",
      }
  }
}

const environmentTemplate = (name: string) => `<<${name}>>`

export const configureRESTAuth = (
  current: HoppRESTAuth,
  configuration: AuthConfiguration
): HoppRESTAuth => {
  const candidate =
    current.authType === configuration.authType
      ? cloneDeep(current)
      : defaultAuth(configuration.authType)

  candidate.authActive = configuration.active

  if (configuration.placement !== undefined) {
    if (!placementTypes.has(configuration.authType) || !("addTo" in candidate))
      throw new Error("This authorization mode does not support placement")
    candidate.addTo = configuration.placement
  }

  const references = configuration.references ?? {}
  const supported = new Set(referenceFields[configuration.authType])
  for (const [field, name] of Object.entries(references)) {
    if (name === undefined) continue
    if (!supported.has(field)) {
      throw new Error(
        `${field} is not a supported reference for ${configuration.authType}`
      )
    }
    const value = environmentTemplate(name)
    if (candidate.authType === "oauth-2") {
      if (!(["token", "clientID", "clientSecret"] as string[]).includes(field))
        throw new Error(`Unsupported OAuth reference ${field}`)
      candidate.grantTypeInfo = {
        ...candidate.grantTypeInfo,
        [field]: value,
      }
    } else {
      Object.assign(candidate, { [field]: value })
    }
  }

  const parsed = HoppRESTAuth.safeParse(candidate)
  if (!parsed.success)
    throw new Error("The authorization configuration is not valid")
  return parsed.data
}

export const replaceRESTDraftFields = (
  request: HoppRESTRequest,
  fields: Partial<
    Pick<
      HoppRESTRequest,
      "auth" | "requestVariables" | "preRequestScript" | "testScript"
    >
  >
) => {
  const candidate = { ...cloneDeep(request), ...cloneDeep(fields) }
  const parsed = HoppRESTRequest.safeParse(candidate)
  if (parsed.type !== "ok")
    throw new Error("The change does not produce a valid REST request")
  return parsed.value
}

/** GraphQL supports the auth subset shared with the REST draft editor. */
export const configureGQLAuth = (
  current: HoppGQLAuth,
  configuration: AuthConfiguration
): HoppGQLAuth => {
  if (
    ![
      "inherit",
      "none",
      "basic",
      "bearer",
      "oauth-2",
      "api-key",
      "aws-signature",
    ].includes(configuration.authType)
  ) {
    throw new Error("This authorization mode is not supported by GraphQL")
  }
  const restAuth = configureRESTAuth(
    current as unknown as HoppRESTAuth,
    configuration
  )
  const parsed = HoppGQLAuth.safeParse(restAuth)
  if (!parsed.success)
    throw new Error("The authorization configuration is not valid for GraphQL")
  return parsed.data
}
