import type { SessionContext } from "@opencode/plugin/promise/session"
import { canonical } from "./prefix"
import { digest, record } from "./shared"

type ToolProfile = {
  readonly descriptionHash: string
  readonly schemaHash: string
  readonly compact: string
}

// OpenCode v2.3.0, packages/core/src/tool/plugin. Schema hashes are from
// tool/runtime.ts's normalized input JSON Schema, before provider lowering.
// The context hook does not expose tool ownership, so match the live name,
// description and complete schema. Leave aliases and overrides alone.
const TOOL_PROFILES = {
  read: {
    descriptionHash: "e6ecb6c162129bb9af6662e49fe1bf8c717fe73fce0b70231426355f364a0fc8",
    schemaHash: "c500a4017cacb9c3492b5a9364cab238305498ccdd2fdcd90c79164d024577fb",
    compact: "Read text, images, PDFs, or directory entries (one per line). Images and PDFs go directly to the model. Text lines have 1-based <line>: prefixes, not part of the file. Page with offset and limit; prefer larger reads and use grep to locate content in large files.",
  },
  grep: {
    descriptionHash: "7f673e0439d39f3baf03353a068df91bde20a9c189cc4e1625c18e2fd7c92400",
    schemaHash: "fd5fe5bd60ca1371a055af4e846f65f772de74adea2210080e98ebe61fca67d5",
    compact: "Find content using ripgrep regex or literal text. Narrow by path or include; returns matching paths, line numbers, and previews.",
  },
  edit: {
    descriptionHash: "2d71b0c3a25dacc15b17d53795cc2dec2ef6bd07031a32765ccfe716a08a3ecd",
    schemaHash: "0f4a3beb0cd64394d321432093aa6983b3b4dc554586196c8fd611ba7aabff2c",
    compact: "Replace exact text in an existing file. Preserve indentation and omit read line-number prefixes in both strings. Use \\n to preserve LF/CRLF; strings differing only in \\r edit line endings byte-for-byte. If exact matching fails, retries ignore typographic quote, dash and space variants, then trailing whitespace. A miss fails. oldString must be nonempty and differ from newString. Default replaceAll=false requires one match; add context to disambiguate or set replaceAll=true to replace every occurrence.",
  },
  write: {
    descriptionHash: "95008cb3f8ec278237a45d408fc018cab46cc7280bc4b36f58a1ebab0ca78ba8",
    schemaHash: "7a4a81bfc4c2af017756dd2bb4b99d8813bc4b38424456589af58cb8f3822989",
    compact: "Create or overwrite a local file, creating missing parent directories. Use edit for targeted changes.",
  },
  skill: {
    descriptionHash: "54cd97d5d5285155f2471c4caf1ec1d67dae0abbeb668a2564b979bc21ccb270",
    schemaHash: "0f797af54d65a932eeb4378c1843d29250ecf5dc5f29797399b0c13c577c9022",
    compact: "Load a matching skill's instructions and resources by available ID or one explicitly referenced by the user.",
  },
  todowrite: {
    descriptionHash: "876a6c6dc59690f6ea7b760252cea0b7051c79846f02f94bd274127996d1d447",
    schemaHash: "87b265db24b79d90d96ae0f5b56414a1e725489ab086ef65fd7a367afcbb42e9",
    compact: "Update the session's visible working plan for 3+ steps, multiple user tasks, or an explicit todo request. Skip simple or conversational tasks; use when unsure. Every call replaces the full list. Mark items in_progress at start and completed when done. Call only on changes.",
  },
} as const satisfies Record<string, ToolProfile>

// shell.ts has two complete stock variants, with an optional OS/shell sentence
// inserted by its context hook. Copy that live sentence rather than guessing it.
const SHELL_PROFILES = [
  {
    descriptionHash: "ce054c23a2a9e8faa6c48d2e08a3408e487c3bcea9d15cc1656aa7f7143a9554",
    schemaHash: "07cd332089f46e2f58a314226d8cfbcb66cdf01302bd5c59064a858ddd18c3b4",
    timeout: "Timeout is optional; background commands have no timeout by default.",
  },
  {
    descriptionHash: "290be9940b5b7104fb971c4133d8778959656c788f57f81ce587233a5e01bd6a",
    schemaHash: "a3205b7c133b0a228a8f575fac1254634a226b2aa8b4408d1292dae97f837d5f",
    timeout: "Foreground commands still running after timeout move to the background.",
  },
] as const

type ContextTool = SessionContext["tools"][string]

function attestShell(tool: ContextTool) {
  const start = "Execute a shell command and return its output. "
  if (!tool.description.startsWith(start)) return
  const rest = tool.description.slice(start.length)
  const environment = /^Commands run on (?:macOS|Windows|Linux|[a-z]+) using [a-z0-9_.+-]+\. /.exec(rest)?.[0] ?? ""
  const description = digest(start + rest.slice(environment.length))
  const match = SHELL_PROFILES.find((profile) => profile.descriptionHash === description)
  if (!match || match.schemaHash !== digest(JSON.stringify(canonical(tool.input)))) return
  return `Run a shell command and return its output. ${environment}Quote paths with spaces or special characters; prefer dedicated tools when possible. Large output is saved to a file with a truncated preview; rely on truncation unless filtering helps. ${match.timeout} Background calls return immediately and notify on completion.`
}

// v2.3.0 SessionSystemPrompt.render inserts these lines in this order.
const HOST_TOOL_GUIDANCE = [
  {
    name: "shell",
    duplicate: "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
    unique: "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
  },
  {
    name: "write",
    duplicate: "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
  },
  {
    name: "edit",
    duplicate: "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
  },
] as const

const HOST_TEMPLATE_HASHES: ReadonlySet<string> = new Set([
  "ab9749036fe5a6b96c74c302900f67a9b249589b4fc4b8a8d18f3c6879dc506d", // session/runner/prompt/system.txt
  "82d48b175f4ed1a2924d4adbeea3b51be7ecf25b1b0819467f9590d778af75bb", // plugin/system-prompt/gpt.txt
  "bbb87472e9f6e7960819e9e4af6bd0aed10db8fdc219c2e93820df8066cd5da3", // plugin/system-prompt/gpt-astra.txt
  "7c105ed2d94347b62bf828f1ccd86d9a73c9ee576aea678eac77cc98b633aab5", // stock plus Anthropic's appended template
])

function projectHost(event: SessionContext, attested: ReadonlySet<string>) {
  const host = event.system[0]
  if (!host || host.metadata !== undefined) return
  const present = HOST_TOOL_GUIDANCE.filter(({ name }) => Object.hasOwn(event.tools, name))
  if (!present.some(({ name }) => attested.has(name))) return
  const lines = present.flatMap((item) => "unique" in item ? [item.duplicate, item.unique] : [item.duplicate])
  const block = `\n${lines.join("\n")}\n`
  const index = host.text.indexOf(block)
  if (index === -1) return
  const before = host.text.slice(0, index + 1)
  const after = host.text.slice(index + block.length - 1)
  if (!HOST_TEMPLATE_HASHES.has(digest(`${before}\${OPENCODE_TOOL_GUIDANCE}${after}`))) return
  const kept = present.flatMap((item) => [
    ...(attested.has(item.name) ? [] : [item.duplicate]),
    ...("unique" in item ? [item.unique] : []),
  ])
  event.system[0] = { ...host, text: before + kept.join("\n") + after }
}

// Exact v2.3.0 initial renderer in skill/instructions.ts. Keep its catalog
// and entry tags so existing chronological instruction deltas still apply.
const SKILL_KEY = "core/skill-guidance"
const CATALOG_START = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
  "<available_skills>",
  "",
].join("\n")
const CATALOG_END = "\n</available_skills>"
const SKILL_TAG = /<\/?(?:id|name|description|skill|available_skills)>/

function projectCatalog(text: string) {
  if (!text.startsWith(CATALOG_START) || !text.endsWith(CATALOG_END)) return
  const body = text.slice(CATALOG_START.length, -CATALOG_END.length)
  const entry = /  <skill>\n    <id>([\s\S]*?)<\/id>\n    <name>([\s\S]*?)<\/name>\n    <description>([\s\S]*?)<\/description>\n  <\/skill>/gy
  const compact: string[] = []
  let cursor = 0
  while (cursor < body.length) {
    entry.lastIndex = cursor
    const match = entry.exec(body)
    if (!match) return
    const [, id, name, description] = match
    // The host renderer does not escape fields. Do not reinterpret ambiguous
    // markup as a catalog; leave the entire source in its original form.
    if ([id, name, description].some((field) => SKILL_TAG.test(field))) return
    compact.push(`<skill><id>${id}</id><name>${name}</name><description>${description}</description></skill>`)
    cursor = entry.lastIndex
    if (cursor === body.length) break
    if (body[cursor] !== "\n" || cursor + 1 === body.length) return
    cursor += 1
  }
  if (compact.length === 0) return
  const guidance = "When a task matches a skill's description, load it with the skill tool. User-invoked skills appear as <skill_content> blocks like tool output and need not be loaded again."
  return [guidance, "<available_skills>", ...compact, "</available_skills>"].join("\n")
}

function projectSkills(event: SessionContext) {
  // v2.3.0 toLLMMessages drops stored system notice IDs. Their source
  // metadata is unavailable here, so leave chronological updates intact.
  for (const [index, part] of event.system.entries()) {
    const experimental = part.metadata?.experimental
    if (!record(experimental) || !Array.isArray(experimental.instructions)) continue
    const sources = experimental.instructions.filter(
      (source: unknown): source is { readonly key: string; readonly text: string } =>
        record(source) && typeof source.key === "string" && typeof source.text === "string",
    )
    // Metadata retains the original text even after another hook has edited the
    // part. Only project a source if the whole current part still matches Core.
    if (sources.length !== experimental.instructions.length || sources.map((source) => source.text).join("\n\n") !== part.text) continue
    const [skill, duplicate] = sources.filter((source) => source.key === SKILL_KEY)
    if (!skill || duplicate) continue
    const projected = projectCatalog(skill.text)
    if (projected === undefined) continue
    event.system[index] = {
      ...part,
      text: sources.map((source) => source.key === SKILL_KEY ? projected : source.text).join("\n\n"),
    }
  }
}

export function projectPrompt(
  event: SessionContext,
  options: { compactPrompt: boolean; compactTools: boolean; compactSkills: boolean },
): void {
  if (options.compactPrompt || options.compactTools) {
    const attested = new Set<string>()
    // Core tracks tool origin by object identity. Do not replace a definition
    // object or mutate its description through one of several aliases.
    const seen = new Set<ContextTool>()
    const shared = new Set<ContextTool>()
    for (const tool of Object.values(event.tools)) {
      if (seen.has(tool)) shared.add(tool)
      else seen.add(tool)
    }
    for (const [name, profile] of Object.entries(TOOL_PROFILES)) {
      const tool = event.tools[name]
      if (!tool || shared.has(tool)) continue
      if (digest(tool.description) !== profile.descriptionHash) continue
      if (digest(JSON.stringify(canonical(tool.input))) !== profile.schemaHash) continue
      attested.add(name)
      if (options.compactTools) tool.description = profile.compact
    }
    const shell = event.tools.shell
    if (shell && !shared.has(shell)) {
      const compact = attestShell(shell)
      if (compact !== undefined) {
        attested.add("shell")
        if (options.compactTools) shell.description = compact
      }
    }
    if (options.compactPrompt) projectHost(event, attested)
  }
  if (options.compactSkills) projectSkills(event)
}
