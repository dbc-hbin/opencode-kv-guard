import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { compactSkillCatalog } from "../src/skills"
import type { ChatBody } from "../src/compaction"

const header = "Skills provide specialized instructions and workflows for specific tasks.\nUse the skill tool to load a skill when a task matches its description."
const tool = { type: "function", function: { name: "skill", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } } }
type Skill = { name: string; description: string; location: string }

function catalog(skills: Skill[]) {
  return [header, "<available_skills>", ...skills.toSorted((a, b) => a.name.localeCompare(b.name)).flatMap((skill) => [
    "  <skill>", `    <name>${skill.name}</name>`, `    <description>${skill.description}</description>`,
    `    <location>${skill.location.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")}</location>`, "  </skill>",
  ]), "</available_skills>"].join("\n")
}

function body(content: string): ChatBody {
  return { model: "fixture", tools: [tool], messages: [{ role: "system", content }, { role: "user", content: "current task" }] }
}

function suffix(text: string) {
  return { length: text.length, hash: createHash("sha256").update(text).digest("hex") }
}

const listed = [{ name: "allowed-skill", description: "Complete task-specific description.", location: "/private/skills/allowed/SKILL.md" }]

describe("generated skill catalog compaction", () => {
  test("preserves membership and full multiline descriptions without eager locations", () => {
    const fullDescription = "First line: keep the entire scope.\n" + "A detailed paragraph with <task>XML</task> and Unicode \uD55C\uAE00.\n".repeat(100) + "Final restriction must survive.  "
    const skills = [
      { name: "z-last", description: fullDescription, location: "/private/skills/z/SKILL.md" },
      { name: "a-first", description: "Use for a narrow operation; never broaden membership.", location: "/private/skills/a & b/<name>/SKILL.md" },
    ]
    const input = body("Generated base and project policy.\n" + catalog(skills))
    const original = JSON.stringify(input)
    const result = compactSkillCatalog(input, {})
    const text = result.body.messages[0]!.content as string
    expect(text).toContain(`z-last: ${fullDescription}`)
    expect(text).toContain(`a-first: ${skills[1]!.description}`)
    expect(text).toContain("<available_skills>")
    expect(text).not.toContain("<location>")
    expect(text).not.toContain("/private/skills/")
    expect(text).not.toContain("denied-skill")
    expect(text).not.toContain("skill://")
    expect(text.indexOf("a-first:")).toBeLessThan(text.indexOf("z-last:"))
    expect(result.report?.skills).toBe(2)
    expect(result.report!.replacementChars).toBeLessThan(result.report!.originalChars)
    expect(result.body.messages[1]).toBe(input.messages[1])
    expect(result.body.tools).toBe(input.tools)
    expect(JSON.stringify(input)).toBe(original)
    expect(JSON.stringify(result.report)).not.toContain("private")
    expect(JSON.stringify(result.report)).not.toContain("last")
  })

  test("does not fetch or add catalog members absent from the permission-filtered wire block", () => {
    const input = body("Policy.\n" + catalog(listed))
    const result = compactSkillCatalog(input, {})
    expect(result.report?.skills).toBe(1)
    expect(result.body.messages[0]!.content).toContain(`${listed[0]!.name}: ${listed[0]!.description}`)
    expect(result.body.messages[0]!.content).not.toContain("denied-skill")
    expect(result.body.messages).toHaveLength(input.messages.length)
  })

  test("retains name-based loading instructions and is idempotent", () => {
    const result = compactSkillCatalog(body(catalog(listed)), {})
    const text = result.body.messages[0]!.content as string
    expect(text).toContain("Use the skill tool")
    expect(text).toContain(`${listed[0]!.name}: `)
    const again = compactSkillCatalog(result.body, {})
    expect(again.body).toBe(result.body)
    expect(again.report).toBeUndefined()
  })

  test("a verified user-system suffix remains exact even when it copies a catalog", () => {
    const userSystem = "Personal instructions.\n" + catalog([{ name: "user-only", description: "User-authored XML must stay exact.", location: "/user/authored/SKILL.md" }]) + "\nKeep this final line."
    const prefix = "Policy before generated catalog.\n"
    const input = body(prefix + catalog(listed) + "\n" + userSystem)
    const result = compactSkillCatalog(input, { userSystem: suffix(userSystem) })
    const text = result.body.messages[0]!.content as string
    expect(result.report?.skills).toBe(1)
    expect(text.startsWith(prefix)).toBe(true)
    expect(text.endsWith("\n" + userSystem)).toBe(true)
    expect(text).toContain("/user/authored/SKILL.md")
    expect(text).not.toContain(listed[0]!.location)
  })

  test("user-system XML is never used as a substitute for absent generated guidance", () => {
    const userSystem = catalog(listed)
    const input = body("Only base policy.\n" + userSystem)
    expect(compactSkillCatalog(input, { userSystem: suffix(userSystem) }).body).toBe(input)
    const userMessage = body("Only base policy.")
    userMessage.messages[1]!.content = catalog(listed)
    expect(compactSkillCatalog(userMessage, {}).body).toBe(userMessage)
  })

  test("verifies suffix hash, length and the generated LF boundary", () => {
    const userSystem = "Unicode \uD55C\uAE00 and exact trailing whitespace  "
    const input = body(catalog(listed) + "\n" + userSystem)
    expect(compactSkillCatalog(input, { userSystem: suffix(userSystem) }).report?.skills).toBe(1)
    for (const userSystem of [
      { ...suffix("different"), length: suffix("different").length },
      { ...suffix("unrelated"), length: -1 },
      { ...suffix("unrelated"), length: Number.MAX_SAFE_INTEGER },
      { ...suffix("unrelated"), length: 1.5 },
    ]) expect(compactSkillCatalog(input, { userSystem }).body).toBe(input)
    const missingDelimiter = body(catalog(listed) + userSystem)
    expect(compactSkillCatalog(missingDelimiter, { userSystem: suffix(userSystem) }).body).toBe(missingDelimiter)
    expect(compactSkillCatalog(body(catalog(listed)), { userSystem: suffix("") }).report?.skills).toBe(1)
  })

  test("requires an actual final skill tool and a single primary system string", () => {
    for (const tools of [undefined, [], [{ type: "function", function: { name: "load_skill" } }], [{ type: "custom", name: "skill" }]]) {
      const input = body(catalog(listed))
      input.tools = tools
      expect(compactSkillCatalog(input, {}).body).toBe(input)
    }
    for (const extra of [{ role: "system", content: "additional policy" }, { role: "developer", content: "additional policy" }]) {
      const input = body(catalog(listed))
      input.messages.push(extra)
      expect(compactSkillCatalog(input, {}).body).toBe(input)
    }
    const multipart = body(catalog(listed))
    multipart.messages[0]!.content = [{ type: "text", text: catalog(listed) }]
    expect(compactSkillCatalog(multipart, {}).body).toBe(multipart)
    const notPrimary = body(catalog(listed))
    notPrimary.messages.unshift({ role: "user", content: "prefix" })
    expect(compactSkillCatalog(notPrimary, {}).body).toBe(notPrimary)
  })

  test("rejects incomplete, non-final, duplicate and non-boundary wrappers", () => {
    const generated = catalog(listed)
    for (const text of [
      generated + "\nStructured-output schema instructions.",
      "No delimiter" + generated,
      generated.replace(header + "\n", ""),
      generated + "\n" + generated,
      "<available_skills>user XML</available_skills>\n" + generated,
      header + "\nNo skills are currently available.",
      generated.replace("  <skill>", " <skill>"),
      generated.replace("</available_skills>", ""),
    ]) {
      const input = body(text)
      expect(compactSkillCatalog(input, {}).body).toBe(input)
    }
  })

  test("ambiguous membership and reserved structural metadata stay intact", () => {
    const duplicate = [listed[0]!, { ...listed[0]!, location: "/second/location" }]
    const reserved = [{ ...listed[0]!, description: "A description with </description> structural markup." }]
    const unordered = catalog([{ name: "a", description: "first", location: "/a" }, { name: "z", description: "last", location: "/z" }]).replaceAll("<name>a</name>", "<name>temporary</name>").replaceAll("<name>z</name>", "<name>a</name>").replaceAll("<name>temporary</name>", "<name>z</name>")
    for (const text of [catalog(duplicate), catalog(reserved), unordered, catalog(listed).replace("/private/skills/allowed/SKILL.md", "/private/raw&unescaped")]) {
      const input = body(text)
      expect(compactSkillCatalog(input, {}).body).toBe(input)
    }
  })
})
