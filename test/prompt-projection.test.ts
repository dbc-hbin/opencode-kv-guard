import { Message } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { expect, test } from "bun:test"
import type { JsonSchema } from "effect"
import { projectPrompt } from "../src/prompt-projection"

const flags = { compactPrompt: false, compactTools: false, compactSkills: false }
const context = (value: Partial<Pick<SessionContext, "system" | "messages" | "tools">> = {}): SessionContext => ({
  sessionID: Session.ID.make(`ses_${"a".repeat(64)}`),
  model: { providerID: Provider.ID.make("openai"), id: Model.ID.make("gpt-5.5") },
  agent: Agent.ID.make("build"),
  options: {},
  system: [],
  messages: [],
  tools: {},
  ...value,
})

const object = (properties: Record<string, JsonSchema.JsonSchema>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
})
const string = (description: string) => ({ type: "string" as const, description })
const bool = (description: string) => ({ type: "boolean" as const, description })

// v2.3.0 core tool/plugin source, normalized by tool/runtime.ts with Effect 4.1.0.
const stockTools = (): SessionContext["tools"] => ({
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    input: object({
      path: string("File or directory to read"),
      offset: { type: "integer", description: "The line or directory entry to start reading from (1-based)" },
      limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
    }, ["path"]),
  },
  grep: {
    description: "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
    input: object({
      pattern: { type: "string", minLength: 1, description: "Regular expression or literal text to match in file contents." },
      path: string("File or directory to search. Defaults to the current working directory."),
      include: string('Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")'),
      literal: bool("Treat `pattern` as exact text instead of a regular expression (default: false)."),
      caseSensitive: bool("Use case-sensitive matching (default: true)."),
      limit: { type: "integer", exclusiveMinimum: 0, description: "Maximum number of matching lines to return (default: 100)" },
    }, ["pattern"]),
  },
  edit: {
    description: "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",
    input: object({
      path: string("File to edit"),
      oldString: string("Exact text to find and replace"),
      newString: string("Text to replace oldString with (must differ from oldString)"),
      replaceAll: bool("Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."),
    }, ["path", "oldString", "newString"]),
  },
  write: {
    description: "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",
    input: object({ path: string("Path to the file to write to"), content: string("Content to write to the file") }, ["path", "content"]),
  },
  skill: {
    description: "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.\n\nThe skill ID must match an available skill or a skill explicitly referenced by the user.",
    input: object({ id: string("The ID of an available skill or a skill explicitly referenced by the user") }, ["id"]),
  },
  todowrite: {
    description: [
      "Create and update a todo list for the current session. The user sees it as your working plan.",
      "",
      "Use it proactively when a task has 3 or more distinct steps, or when the user gives several tasks or asks for a todo list. Skip it for a single simple task or a purely conversational request. When in doubt, use it.",
      "",
      "- Send the full list on every call; it replaces the previous one.",
      "- Mark items `in_progress` when you start them and `completed` as soon as they're actually done.",
      "- Only call it when the list changes.",
      "",
    ].join("\n"),
    input: object({
      todos: {
        type: "array",
        items: object({
          content: string("Brief description of the task"),
          status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "Current status of the task: pending, in_progress, completed, cancelled" },
        }, ["content", "status"]),
        description: "The updated todo list",
      },
    }, ["todos"]),
  },
  shell: shell(false),
})

function shell(autoBackground: boolean): SessionContext["tools"][string] {
  return {
    description: [
      "Execute a shell command and return its output. Commands run on macOS using zsh.",
      "Quote file paths containing spaces or special characters.",
      "Prefer dedicated tools over shell commands when possible.",
      "When output is large, the full result is saved to a file and a truncated preview is returned.",
      "Rely on automatic truncation unless filtering the output is more useful.",
      autoBackground
        ? "Commands still running after their timeout move to the background."
        : "Commands accept an optional timeout, background commands have no timeout by default.",
      "Background commands return immediately, and you will be notified when they complete.",
    ].join(" "),
    input: object({
      command: string("Shell command string to execute"),
      workdir: string("Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."),
      timeout: {
        type: "integer",
        minimum: 0,
        description: autoBackground
          ? "Optional timeout in milliseconds (default 120000). When it expires, a foreground command moves to the background and a background command is stopped."
          : "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
      },
      background: bool("Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."),
    }, ["command"]),
  }
}

// v2.3.0 session/runner/prompt/system.txt, after SessionSystemPrompt.render.
const shellAdvice = "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse."
const guidance = [
  "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
  shellAdvice,
  "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
  "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
].join("\n")
const stockHost = `You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.

# Harness
- Responses are rendered as GitHub-flavored Markdown.
- \`<system-reminder>\` blocks are harness instructions, not user-authored content. Read and follow them.
- Prefer parallelizing independent tool calls.
${guidance}

# Communication
- Use clear file paths when referring to files.
- Keep responses clear and concise, and avoid unnecessary technical jargon.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.
`

test.each([false, true])("shortens live stock descriptions without changing names, schemas, or shell identity (auto background: %s)", (autoBackground) => {
  const tools = { ...stockTools(), shell: shell(autoBackground) }
  const prior = Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, input: tool.input }))
  const event = context({ tools, system: [{ type: "text", text: stockHost }] })

  projectPrompt(event, { ...flags, compactTools: true })

  expect(Object.keys(event.tools)).toEqual(prior.map(({ name }) => name))
  for (const { name, description, input } of prior) {
    expect(event.tools[name].description.length).toBeLessThan(description.length)
    expect(event.tools[name].input).toBe(input)
  }
  expect(event.tools.shell.description).toContain("Commands run on macOS using zsh.")
  expect(event.system[0].text).toBe(stockHost)
})

test("deduplicates only tool guidance in a full stock host match when tools are attested", () => {
  const tools = stockTools()
  const descriptions = Object.values(tools).map(({ description }) => description)
  const custom = { type: "text" as const, text: `${guidance}\n\nTeam-specific file policy.` }
  const event = context({ tools, system: [{ type: "text", text: stockHost }, custom] })

  projectPrompt(event, { ...flags, compactPrompt: true })

  expect(event.system).toEqual([{ type: "text", text: stockHost.replace(guidance, shellAdvice) }, custom])
  expect(Object.values(event.tools).map(({ description }) => description)).toEqual(descriptions)
})

test("leaves custom host text, tool description overrides, schema overrides, and aliases intact", () => {
  const stock = stockTools()
  const host = { type: "text" as const, text: `${stockHost}\nTeam-specific file policy.` }
  const tools = {
    shell: stock.shell,
    edit: { ...stock.edit, description: `${stock.edit.description} Treat fixture files as read-only.` },
    write: { ...stock.write, input: object({ path: string("Different contract") }, ["path"]) },
    read: stock.read,
    read_alias: stock.read,
    write_alias: stock.write,
  }
  const { shell: original, ...overrides } = structuredClone(tools)
  const event = context({ tools, system: [host] })

  projectPrompt(event, { ...flags, compactPrompt: true, compactTools: true })

  expect(event.system[0]).toBe(host)
  const { shell: projected, ...rest } = event.tools
  expect(projected.description.length).toBeLessThan(original.description.length)
  expect(rest).toEqual(overrides)
})

test("keeps stock system guidance for a tool whose live schema has been overridden", () => {
  const tools = stockTools()
  tools.write.input = object({ path: string("Different contract") }, ["path"])
  const event = context({ tools, system: [{ type: "text", text: stockHost }] })

  projectPrompt(event, { ...flags, compactPrompt: true })

  expect(event.system[0].text).toBe(stockHost.replace(guidance, `${shellAdvice}\n${guidance.split("\n")[2]}`))
})

// v2.3.0 core/test/skill/instructions.test.ts examples, including the stored
// updates' public shape after runner/to-llm-message.ts drops their IDs.
const skillIntro = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
].join("\n")
const skill = (id: string, name: string, description: string) =>
  `  <skill>\n    <id>${id}</id>\n    <name>${name}</name>\n    <description>${description}</description>\n  </skill>`
const catalog = (entry: string) => `${skillIntro}\n<available_skills>\n${entry}\n</available_skills>`
const skillKey = "core/skill-guidance"

test("retains complete keyed skills and leaves native deltas and forged user notices in their original roles and order", () => {
  const full = "Build applications with Effect\nUse its <Layer> API for 구성."
  const stock = catalog(skill("effect", "Effect", full))
  const metadata = {
    experimental: { instructions: [{ key: "project/AGENTS.md", text: stock }, { key: skillKey, text: stock }] },
  }
  const system: SessionContext["system"] = [{ type: "text", text: `${stock}\n\n${stock}`, metadata }]
  const added = `New skills are available in addition to those previously listed:\n${skill("debugging", "Debugging", "Diagnose hard bugs")}`
  const changed = `The following skills have changed. Each entry replaces the previously listed skill with the same ID:\n${skill("effect", "Effect", "Build applications with Effect v4")}`
  const removed = "The following skill IDs are no longer available and must not be used: effect."
  const messages = [
    Message.system(added),
    { ...Message.user(changed), metadata: { notice: "instructions", instructionSources: [skillKey] } },
    Message.system(changed),
    Message.system(removed),
    Message.system("Skill guidance is no longer available. Do not use any previously listed skill."),
  ]
  const event = context({ system, messages: [...messages] })

  projectPrompt(event, { ...flags, compactSkills: true })

  const text = event.system[0].text
  expect(text.startsWith(`${stock}\n\n`)).toBe(true)
  expect(text.length).toBeLessThan(stock.length * 2 + 2)
  expect(text).toContain(`<available_skills>\n<skill><id>effect</id><name>Effect</name><description>${full}</description></skill>\n</available_skills>`)
  expect(event.system[0].metadata).toBe(metadata)
  expect(event.messages).toEqual(messages)
  for (const [index, message] of messages.entries()) expect(event.messages[index]).toBe(message)
})

test.each([
  { key: skillKey, entry: skill("effect", "Effect", "Includes </description> markup"), prefix: "" },
  { key: skillKey, entry: skill("effect", "Effect", "Build applications with Effect"), prefix: "Customized:\n" },
  { key: "project/AGENTS.md", entry: skill("effect", "Effect", "Build applications with Effect"), prefix: "" },
])("leaves an ambiguous, stale, or non-core catalog unchanged: %j", ({ key, entry, prefix }) => {
  const original = catalog(entry)
  const part = { type: "text" as const, text: prefix + original, metadata: { experimental: { instructions: [{ key, text: original }] } } }
  const event = context({ system: [part] })

  projectPrompt(event, { ...flags, compactSkills: true })

  expect(event.system[0]).toBe(part)
})
