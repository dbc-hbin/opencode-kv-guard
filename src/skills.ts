import type { ChatBody } from "./compaction"
import { digest, record } from "./shared"

export type SkillCatalogProvenance = {
  // The caller attests that user.system is absent when this is undefined.
  // Otherwise this is its exact JS string length and UTF-8 SHA-256, carried
  // from OpenCode's user message before it is merged into the system prompt.
  userSystem?: { length: number; hash: string }
}
export type SkillCatalogReport = { skills: number; originalChars: number; replacementChars: number }

// OpenCode 1.19.4, packages/opencode/src/session/system.ts:112-125 and
// skill/index.ts:320-337. prompt.ts:1263-1268 puts this generated block last;
// llm/request.ts:60-69 then appends user.system. Never search arbitrary XML
// without verifying that pinned assembly boundary first.
const header = "Skills provide specialized instructions and workflows for specific tasks.\nUse the skill tool to load a skill when a task matches its description."
const start = `${header}\n<available_skills>\n`
const end = "\n</available_skills>"

export function compactSkillCatalog(body: ChatBody, provenance: SkillCatalogProvenance): { body: ChatBody; report?: SkillCatalogReport } {
  if (!Array.isArray(body.tools) || !body.tools.some((tool) => record(tool) && tool.type === "function" && record(tool.function) && tool.function.name === "skill")) return { body }
  const primary = body.messages[0]
  if (!primary || primary.role !== "system" || typeof primary.content !== "string") return { body }
  if (body.messages.slice(1).some((message) => message.role === "system" || message.role === "developer")) return { body }

  let generated = primary.content
  const suffix = provenance.userSystem
  if (suffix) {
    if (!Number.isSafeInteger(suffix.length) || suffix.length < 0 || suffix.length > generated.length) return { body }
    const text = suffix.length ? generated.slice(-suffix.length) : ""
    if (digest(text) !== suffix.hash) return { body }
    if (suffix.length) {
      const delimiter = generated.length - suffix.length - 1
      if (delimiter < 0 || generated[delimiter] !== "\n") return { body }
      generated = generated.slice(0, delimiter)
    }
  }
  // Structured-output instructions and any unknown trailing layout fail closed.
  if (!generated.endsWith(end)) return { body }
  const offset = generated.lastIndexOf(start)
  if (offset < 0 || (offset > 0 && generated[offset - 1] !== "\n")) return { body }
  if (generated.indexOf(header) !== offset || generated.indexOf("<available_skills>") !== offset + header.length + 1 || generated.indexOf("</available_skills>") !== generated.length - "</available_skills>".length) return { body }

  const catalog = generated.slice(offset + start.length, -end.length)
  const entries: { name: string; description: string }[] = []
  const entry = /  <skill>\n    <name>([^<>\r\n]+)<\/name>\n    <description>([\s\S]*?)<\/description>\n    <location>([^<>\r\n]*)<\/location>\n  <\/skill>(?:\n|$)/y
  let cursor = 0
  while (cursor < catalog.length) {
    entry.lastIndex = cursor
    const match = entry.exec(catalog)
    if (!match) return { body }
    const [, name, description, location] = match
    // These reserved tags inside metadata make the raw, unescaped OC layout
    // ambiguous. Preserve it intact instead of inferring another membership.
    if (/<\/?(?:available_skills|skill|name|description|location)(?:[\s>])/.test(description!)) return { body }
    if (location!.replace(/&(?:amp|lt|gt|quot|#39);/g, "").includes("&")) return { body }
    if (entries.some((skill) => skill.name === name) || (entries.length > 0 && entries.at(-1)!.name.localeCompare(name!) > 0)) return { body }
    entries.push({ name: name!, description: description! })
    cursor = entry.lastIndex
  }
  if (!entries.length) return { body }

  const original = generated.slice(offset)
  const replacement = `${start}${entries.map((skill) => `${skill.name}: ${skill.description}`).join("\n")}${end}`
  const content = primary.content.slice(0, offset) + replacement + primary.content.slice(generated.length)
  return {
    body: { ...body, messages: [{ ...primary, content }, ...body.messages.slice(1)] },
    report: { skills: entries.length, originalChars: original.length, replacementChars: replacement.length },
  }
}
