import { getDefaultGQLRequest, getDefaultRESTRequest } from "@hoppscotch/data"
import { describe, expect, it } from "vitest"

import {
  configureGQLAuth,
  configureRESTAuth,
  replaceRESTDraftFields,
} from "../rest-drafts"

describe("WebMCP REST draft extensions", () => {
  it("writes credential references without accepting credential values", () => {
    const auth = configureRESTAuth(getDefaultRESTRequest().auth, {
      authType: "basic",
      active: true,
      references: { username: "API_USER", password: "API_PASSWORD" },
    })

    expect(auth).toEqual({
      authType: "basic",
      authActive: true,
      username: "<<API_USER>>",
      password: "<<API_PASSWORD>>",
    })
  })

  it("preserves existing credentials when changing metadata on the same mode", () => {
    const auth = configureRESTAuth(
      {
        authType: "api-key",
        authActive: true,
        key: "<<KEY_NAME>>",
        value: "<<KEY_VALUE>>",
        addTo: "HEADERS",
      },
      {
        authType: "api-key",
        active: false,
        placement: "QUERY_PARAMS",
      }
    )

    expect(auth).toMatchObject({
      authActive: false,
      key: "<<KEY_NAME>>",
      value: "<<KEY_VALUE>>",
      addTo: "QUERY_PARAMS",
    })
  })

  it("rejects references that do not belong to the selected mode", () => {
    expect(() =>
      configureRESTAuth(getDefaultRESTRequest().auth, {
        authType: "bearer",
        active: true,
        references: { password: "PASSWORD" },
      })
    ).toThrow("not a supported reference")
  })

  it("replaces only the requested draft extension fields", () => {
    const original = getDefaultRESTRequest()
    const updated = replaceRESTDraftFields(original, {
      requestVariables: [{ key: "ORDER_ID", value: "42", active: true }],
      testScript: "pw.expect(1).toBe(1)",
    })

    expect(updated.requestVariables).toHaveLength(1)
    expect(updated.testScript).toBe("pw.expect(1).toBe(1)")
    expect(updated.endpoint).toBe(original.endpoint)
    expect(updated.auth).toEqual(original.auth)
  })

  it("maps GraphQL authorization references without permitting REST-only modes", () => {
    expect(
      configureGQLAuth(getDefaultGQLRequest().auth, {
        authType: "bearer",
        active: true,
        references: { token: "GQL_TOKEN" },
      })
    ).toMatchObject({ authType: "bearer", token: "<<GQL_TOKEN>>" })
    expect(() =>
      configureGQLAuth(getDefaultGQLRequest().auth, {
        authType: "jwt",
        active: true,
      })
    ).toThrow("not supported by GraphQL")
  })
})
