import { describe, expect, test } from "bun:test"
import { compactToolDescriptions } from "../src/tools"

// Exact OpenCode 1.19.4 wire descriptions; bash is rendered with non-default
// shell, temp path, timeout and truncation limits.
const original: Record<string, string> = await Bun.file(new URL("./fixtures/tool-descriptions-1.19.4.json", import.meta.url)).json()
const listing = "\nAvailable agent types and the tools they have access to:\n- explore: Fast agent.\n- general: General-purpose agent."
const tool = (name: string, description: string) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: { [name]: { type: "string" } } } } })
const fixed = ["read", "edit", "write", "glob", "grep", "webfetch", "todowrite", "skill", "question", "apply_patch", "lsp", "plan_exit"]
const description = (value: unknown) => (value as { function: { description: string } }).function.description

describe("builtin tool description compression", () => {
  test("replaces every recognized builtin while keeping names, schemas and rendered values", () => {
    const tools = [
      ...fixed.map((name) => tool(name, original[name]!)),
      tool("bash", original.bash!),
      tool("websearch", original.websearchTemplate!.replace("{{year}}", "2031")),
      tool("task", original.task! + listing),
    ]
    const result = compactToolDescriptions(tools)
    expect(result.report?.tools).toBe(tools.length)
    expect(result.report!.replacementChars).toBeLessThan(result.report!.originalChars / 2)
    result.tools.forEach((compacted, index) => {
      expect(compacted).toEqual({ ...tools[index]!, function: { ...tools[index]!.function, description: description(compacted) } })
      expect(description(compacted).length).toBeLessThan(tools[index]!.function.description.length)
    })
    const byName = Object.fromEntries(result.tools.map((compacted, index) => [tools[index]!.function.name, description(compacted)]))
    for (const value of ["bash session", "OS: linux", "/state/opencode/tmp", "default 300000", "500 lines", "10240 bytes", "`workdir`"]) expect(byName.bash).toContain(value)
    expect(byName.websearch).toContain("current year is 2031")
    expect(byName.task!.endsWith(listing)).toBe(true)
    for (const parameter of ["subagent_type", "description", "prompt", "task_id"]) expect(byName.task).toContain(`\`${parameter}\``)
    expect(byName.read).toContain("`<line>: <content>`")
    expect(byName.edit).toContain("`<line>: `")
    expect(byName.edit).toContain("`replaceAll`")
  })

  test("keeps the background-mode paragraph only when the core added it", () => {
    const [plain, background] = compactToolDescriptions([
      tool("task", original.task! + listing),
      tool("task", original.task! + original.taskBackground! + listing),
    ]).tools
    expect(description(plain)).not.toContain("background")
    expect(description(background)).toContain("`background: true`")
    expect(description(background).endsWith(listing)).toBe(true)
  })

  test("leaves edited, custom, plugin-amended and non-POSIX layouts intact", () => {
    const unchanged = [
      tool("read", original.read! + " "),
      tool("read", original.edit!),
      tool("custom_tool", original.read!),
      tool("bash", original.bash!.replace("Shell: bash", "Shell: pwsh").replace("persistent shell session", "PowerShell session")),
      tool("bash", original.bash!.replace("# Git and GitHub", "# Git")),
      tool("task", `${original.task}\nExtra plugin guidance.${listing}`),
      tool("task", original.task!),
      tool("websearch", original.websearchTemplate!),
      { type: "function", function: { name: "read" } },
      { type: "custom", function: { name: "read", description: original.read } },
    ]
    const result = compactToolDescriptions(unchanged)
    expect(result.report).toBeUndefined()
    expect(result.tools).toBe(unchanged)
  })

  test("is stable across repeated requests and idempotent", () => {
    const tools = [tool("bash", original.bash!), tool("todowrite", original.todowrite!)]
    const first = compactToolDescriptions(tools)
    expect(compactToolDescriptions(structuredClone(tools)).tools).toEqual(first.tools)
    const again = compactToolDescriptions(first.tools)
    expect(again.report).toBeUndefined()
    expect(again.tools).toBe(first.tools)
  })
})
