import { describe, expect, it } from "vitest"

import { findSkill, listSkills, SKILLS_CATALOG } from "../skills"

describe("WebMCP Skills Catalog", () => {
  it("lists all available skills with required metadata", () => {
    const skills = listSkills()
    expect(skills.length).toBeGreaterThanOrEqual(4)

    const skillNames = skills.map((s) => s.name)
    expect(skillNames).toContain("scripting-sandbox")
    expect(skillNames).toContain("variables-and-environments")
    expect(skillNames).toContain("test-assertions")
    expect(skillNames).toContain("auth-configuration")

    for (const skill of skills) {
      expect(skill.name).toBeTruthy()
      expect(skill.title).toBeTruthy()
      expect(skill.description).toBeTruthy()
      expect(skill.tags.length).toBeGreaterThan(0)
    }
  })

  it("finds skills by exact name and case-insensitively", () => {
    const skill1 = findSkill("scripting-sandbox")
    expect(skill1).toBeDefined()
    expect(skill1?.name).toBe("scripting-sandbox")
    expect(skill1?.guide).toContain("pw.env.get")
    expect(skill1?.guide).toContain("crypto")

    const skillCase = findSkill("SCRIPTING-SANDBOX")
    expect(skillCase).toBeDefined()
    expect(skillCase?.name).toBe("scripting-sandbox")
  })

  it("finds skills by keyword or tag", () => {
    const skillByTag = findSkill("assertions")
    expect(skillByTag).toBeDefined()
    expect(skillByTag?.name).toBe("test-assertions")

    const skillByTitleWord = findSkill("Environments")
    expect(skillByTitleWord).toBeDefined()
    expect(skillByTitleWord?.name).toBe("variables-and-environments")
  })

  it("returns null for nonexistent skill queries", () => {
    expect(findSkill("nonexistent-skill-query-xyz")).toBeNull()
  })

  it("ensures all skill guides fit comfortably under output byte limit (8192 bytes)", () => {
    const MAX_OUTPUT_BYTES = 8192

    for (const detail of Object.values(SKILLS_CATALOG)) {
      const payload = {
        protocolVersion: "hoppscotch.webmcp.v1",
        appContext: {
          surface: "rest",
          mode: "rest",
          workspace: { type: "personal" },
          environment: { name: "Global", scope: "none" },
          dirtyDocumentCount: 0,
          capabilityPacks: ["app-context", "rest"],
        },
        revisionScope: "app-context",
        revision: "app-context:1",
        ok: true,
        skill: detail,
      }

      const byteLength = new TextEncoder().encode(
        JSON.stringify(payload)
      ).byteLength
      expect(byteLength).toBeLessThan(MAX_OUTPUT_BYTES)
    }
  })
})
