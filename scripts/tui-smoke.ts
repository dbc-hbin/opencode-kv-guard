import type { OpenCodeEvent, SessionInfo, SessionMessageAssistant } from "@opencode/client"
import { RGBA } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import plugin from "../src/tui"

const sessionID = "ses_cache_sidebar"
const tokens = (read: number) => ({ input: 100 - read, output: 10, reasoning: 0, cache: { read, write: 0 } })
const assistant = (id: string, read: number): SessionMessageAssistant => ({
  id,
  type: "assistant",
  time: { created: 1, completed: 2 },
  agent: "build",
  model: { providerID: "fixture", id: "fixture" },
  content: [],
  tokens: tokens(read),
})
const session: SessionInfo = {
  id: sessionID,
  title: "Input cache sidebar smoke",
  projectID: "global",
  location: { directory: process.cwd() },
  time: { created: 1, updated: 2 },
  cost: 0,
  tokens: tokens(0),
}

const slots: Array<(input: { readonly sessionID: string }) => JSX.Element> = []
const listeners = new Set<(event: { details: OpenCodeEvent }) => void>()
plugin.setup({
  client: {
    session: { get: async () => session },
    message: { list: async () => ({
      data: [assistant("msg_second", 80), assistant("msg_first", 40)],
      cursor: {},
    }) },
  },
  data: {
    listen(handler) {
      listeners.add(handler)
      return () => { listeners.delete(handler) }
    },
  },
  theme: { text: { base: RGBA.fromHex("#ffffff"), muted: RGBA.fromHex("#aaaaaa") } },
  ui: {
    slot(claim) {
      if (claim.append === "sidebar.content") slots.push(claim.render)
      return () => { slots.length = 0 }
    },
  },
})
const [render] = slots
if (!render) throw new Error("The plugin did not register its sidebar")

const wide = 37 // OpenCode's 42-column sidebar minus the host's content padding.
await using surface = await testRender(() => render({ sessionID }), { width: wide, height: 5 })
const capture = async (label: string, expected: readonly string[]) => {
  const frame = await surface.waitForFrame((text) => {
    const rows = text.trimEnd().split("\n").map((row) => row.trimEnd())
    return rows.length === expected.length && rows.every((row, index) => row === expected[index])
  })
  console.log(`${label}\n${frame.trimEnd().split("\n").map((row) => row.trimEnd()).join("\n")}`)
}

await capture("37 columns, seeded history", ["Input cache", "Last request: 80%", "Session: 60%"])
surface.resize(24, 5)
for (const listen of listeners) listen({
  details: {
    id: "evt_live",
    created: 3,
    durable: { aggregateID: sessionID, seq: 3, version: 1 },
    type: "session.step.ended",
    data: { sessionID, assistantMessageID: "msg_live", cost: 0, finish: "stop", tokens: tokens(0) },
  },
})
await capture("24 columns, live update", ["Input cache", "Last request: 0%", "Session: 40%"])
for (const listen of listeners) listen({
  details: {
    id: "evt_failed",
    created: 4,
    durable: { aggregateID: sessionID, seq: 4, version: 1 },
    type: "session.step.failed",
    data: { sessionID, assistantMessageID: "msg_failed", error: { type: "provider", message: "No usage received" } },
  },
})
await capture("24 columns, failure without usage", ["Input cache", "Last request: -", "Session: 40%"])
