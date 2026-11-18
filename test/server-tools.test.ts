import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, Model, Provider } from "@opencode/plugin"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import { CallID, Error as ToolError, type Result } from "@opencode/plugin/promise/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { registerTools } from "../src/server-tools"

function hooks<T>() {
  const callbacks: { [K in keyof T]?: (event: T[K]) => void | Promise<void> } = {}
  return {
    hook: async <K extends keyof T>(name: K, callback: (event: T[K]) => void | Promise<void>) => {
      callbacks[name] = callback
      return { dispose: async () => { delete callbacks[name] } }
    },
    emit: async <K extends keyof T>(name: K, event: T[K]) => {
      return callbacks[name]?.(event)
    },
  }
}

test("shrinks direct file and execute results independently and only for selected requests", async () => {
  const data = await mkdtemp(join(tmpdir(), "kv-guard-tool-hook-"))
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = data
  const session = hooks<SessionHooks>()
  const tool = hooks<ToolHooks>()
  const sessionID = Session.ID.create()
  const messageID = SessionMessage.ID.create()
  const agent = Agent.ID.make("build")
  const model = Model.Ref.make({ providerID: Provider.ID.make("local"), id: Model.ID.make("fixture") })
  const otherModel = Model.Ref.make({ ...model, providerID: Provider.ID.make("outside") })
  const owner = { sessionID, messageID, agent }
  const eventContext = async () =>
    [{ type: "assistant" as const, id: messageID, agent, model, content: [], time: { created: 1 } }]
  const host = {
    session: { ...session, context: eventContext },
    tool,
    event: { subscribe: async function* () {} },
  }
  const completed = (name: string, input: unknown, result: Result) => ({
    ...owner, id: CallID.make(crypto.randomUUID()), tool: name, status: "completed" as const, input, result,
  })
  let cleanup: Awaited<ReturnType<typeof registerTools>> = undefined
  try {
    const disabled = await registerTools(host, { providers: ["local"], shrinkToolOutputs: false })
    const primary = { kind: "primary" as const, sessionID, model, agent, headers: {} }
    const raw = ["first", "second"].map((text) => Array(80).fill(text).join("\n"))
    const unchanged = completed("grep", { pattern: "disabled" }, { content: raw[0] })
    await session.emit("model.request", primary)
    await tool.emit("execute.after", unchanged)
    expect(unchanged.result.content).toBe(raw[0])
    expect(unchanged.result.metadata?.outputPath).toBeUndefined()
    await disabled?.()

    cleanup = await registerTools(host, {
      providers: ["local"],
      shrinkToolOutputs: { maxBytes: 512, maxLines: 5 },
    })
    await session.emit("model.request", primary)
    await session.emit("model.request", { kind: "compaction", sessionID, model: otherModel, agent, headers: {} })
    const leafOutputs = [[{ path: "one" }], [{ path: "two" }]]
    const leaves = raw.map((content, index) => completed(
      "grep", { pattern: `actual-${index}`, include: "*.txt" }, { content, output: leafOutputs[index] },
    ))
    const schedule = { ...completed("grep", { pattern: "schedule" }, { content: raw.join("\n") }), messageID: SessionMessage.ID.create() }
    const errors = {
      ...owner, id: CallID.make("denied"), tool: "grep", status: "error" as const, input: { pattern: "denied" },
      error: new ToolError({ message: "blocked" }),
    }
    await Promise.all([
      ...leaves.map((leaf) => tool.emit("execute.after", leaf)),
      tool.emit("execute.after", schedule),
      tool.emit("execute.after", errors),
    ])
    expect(leaves.map((leaf) => leaf.result.output)).toEqual(leafOutputs)
    expect(schedule.result.metadata?.outputPath).toBeUndefined()
    const output = { output: raw.join("\n"), toolCalls: [], files: [] }
    const execute = completed("execute", { code: "return collected" }, { content: output.output, output })
    await tool.emit("execute.after", execute)
    expect(execute.result.output).toBe(output)
    expect(execute.result.content).not.toBe(output.output)
    for (const [index, leaf] of leaves.entries()) {
      const path: unknown = leaf.result.metadata?.outputPath
      if (typeof path !== "string") throw new Error("Expected each direct call's raw artifact")
      expect(await readFile(path, "utf8")).toBe(raw[index])
    }
    const aggregate: unknown = execute.result.metadata?.outputPath
    if (typeof aggregate !== "string") throw new Error("Expected full execute output")
    expect(await readFile(aggregate, "utf8")).toBe(output.output)

    await session.emit("model.request", { kind: "primary", sessionID, model: otherModel, agent, headers: {} })
    const unselected = completed("grep", { pattern: "unselected" }, { content: output.output })
    await tool.emit("execute.after", unselected)
    expect(unselected.result.content).toBe(output.output)
    expect(unselected.result.metadata?.outputPath).toBeUndefined()
  } finally {
    await cleanup?.()
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    await rm(data, { recursive: true, force: true })
  }
})
