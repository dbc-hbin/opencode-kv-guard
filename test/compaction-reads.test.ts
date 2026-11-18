import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageToolStateCompleted, SessionMessageUser, ToolContent } from "@opencode/client"
import { Agent, Model, Provider } from "@opencode/plugin"
import { SessionMessage } from "@opencode/schema/session-message"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { RollingCompaction, type CompactionContext } from "../src/compaction"
import { readEvidence, readRegions } from "../src/compaction-reads"
import { contentArtifactName } from "../src/compaction-shake"
import type { WireMessage } from "../src/prefix"

const path = resolve("/workspace/logic.ts")
const model = Model.Ref.make({ providerID: Provider.ID.make("local"), id: Model.ID.make("fixture") })
const agent = Agent.ID.make("build")
const count = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const empty = new Set<number>()
const eligible = { archived: empty, reduced: empty, count }

type ReadFixture = {
  readonly input?: { readonly path: string; readonly offset?: number; readonly limit?: number }
  readonly rows?: readonly string[]
  readonly text?: string
  readonly metadata?: SessionMessageToolStateCompleted["metadata"] | null
  readonly executed?: boolean
  readonly error?: boolean
}

function read(id: string, options: ReadFixture = {}) {
  const input = options.input ?? { path }
  const start = input.offset || 1
  const rows = options.rows ?? ["first", "second", "third"]
  const text = options.text ?? [
    `Read file ${input.path}, lines ${start}-${start + rows.length - 1}`,
    ...rows.map((line, index) => `${start + index}: ${line}`),
  ].join("\n")
  const metadata = options.metadata === null ? undefined : options.metadata ?? { truncated: false }
  const content: [ToolContent] = [{ type: "text", text }]
  const tool: SessionMessageAssistantTool = {
    type: "tool", id, name: "read", executed: options.executed ?? false, time: { created: 1 },
    state: options.error
      ? { status: "error", input, content, metadata, error: { type: "tool.execution", message: "Permission denied" } }
      : { status: "completed", input, content, metadata },
  }
  const call = { id, type: "function", function: { name: "read", arguments: JSON.stringify(input) } }
  const result: WireMessage = { role: "tool", tool_call_id: id, content: text }
  return { tool, call, result, text }
}

function step(...reads: readonly ReturnType<typeof read>[]) {
  const durable: SessionMessageAssistant = {
    id: SessionMessage.ID.create(), type: "assistant", agent, model, time: { created: 1 },
    content: reads.map(({ tool }) => tool),
  }
  const owner: WireMessage = { role: "assistant", content: null, tool_calls: reads.map(({ call }) => call) }
  return { durable, owner, wire: [owner, ...reads.map(({ result }) => result)] }
}

test("selects an earlier overlapping read only with a still-live encompassing result, retaining exact raw output", () => {
  const old = read("old", { input: { path, offset: 2, limit: 3 }, rows: ["α body", "", "ω tail"] })
  const newer = read("newer", { input: { path, offset: 1, limit: 4 }, rows: ["heading", "α body", "", "ω tail"] })
  const left = step(old)
  const right = step(newer)
  const messages = [...left.wire, ...right.wire]
  const original = structuredClone(messages)
  const evidence = readEvidence([left.durable, right.durable])

  expect(readRegions(messages, { ...eligible, evidence })).toEqual([
    { index: 1, kind: "read", text: old.text, tokens: count(old.text) },
  ])
  expect(readRegions(messages, { ...eligible, evidence, archived: new Set([3]) })).toEqual([])
  expect(readRegions(messages, { ...eligible, evidence, reduced: new Set([3]) })).toEqual([])
  expect(readRegions(messages, { ...eligible, evidence, archived: new Set([1]) })).toEqual([])
  expect(readRegions(messages, { ...eligible, evidence, reduced: new Set([1]) })).toEqual([])
  expect(messages).toEqual(original)
})

test("keeps one verbatim witness for byte-identical results within a parallel batch", () => {
  const first = read("first")
  const second = read("second", { input: { path, offset: 1, limit: 3 } })
  const third = read("third")
  const batch = step(first, second, third)

  expect(readRegions(batch.wire, { ...eligible, evidence: readEvidence([batch.durable]) })).toEqual([
    { index: 1, kind: "read", text: first.text, tokens: count(first.text) },
    { index: 2, kind: "read", text: second.text, tokens: count(second.text) },
  ])
})

test("a shake that replaces the witness restores the older read at commit and on restart", async () => {
  const rows = ["a".repeat(1700), "b".repeat(1700)]
  const older = read("older", { rows })
  const newer = read("newer", { rows })
  const batch = step(older, newer)
  const extra = { role: "assistant", content: null, tool_calls: [{ id: "shell", type: "function", function: { name: "bash", arguments: "{}" } }] }
  const currentUser = { role: "user", content: "c".repeat(17000) }
  const body = { model: "fixture", messages: [
    extra, { role: "tool", tool_call_id: "shell", content: "s".repeat(6500) }, ...batch.wire, currentUser,
  ] }
  const options = { bytesPerToken: 1, thresholdTokens: 28000 }
  const context: CompactionContext = {
    session: "session", lane: "test", contextWindow: 40000, outputLimit: 500, currentUser,
    readEvidence: readEvidence([batch.durable]),
    completeSummary: async () => { throw new Error("Shake should fit without a summary request") },
    artifacts: { path: (text) => `/artifacts/${contentArtifactName(text)}`, save: async () => {} },
  }
  const rolling = new RollingCompaction(options)
  const result = await rolling.prepare(body, context)
  if ("response" in result) throw new Error("Unexpected upstream response")
  expect(result.body.messages).toContain(older.result)
  expect(String(result.body.messages[4]?.content)).toStartWith("[Content removed")
  expect(result.report?.supersededReads).toBe(0)

  const snapshot = rolling.snapshot(context.session)
  // Simulate a stored projection from a version that accepted both reductions.
  snapshot.lanes[0]!.state.reductions!.push({
    index: 3, kind: "read", path: context.artifacts!.path(older.text), tokens: count(older.text),
  })
  const restored = new RollingCompaction(options)
  expect(await restored.restore(context.session, snapshot)).toBe(true)
  expect(restored.reconstruct(body, context)).toEqual(result.body)
})

test.each([
  ["changed lines", { rows: ["first", "edited", "third", "fourth"] }],
  ["non-enclosing lines", { input: { path, offset: 3 }, rows: ["third", "fourth"] }],
  ["different file", { input: { path: resolve("/other/logic.ts") } }],
  ["truncated result metadata", { metadata: { truncated: true } }],
  ["unknown result metadata", { metadata: null }],
  ["tool error", { error: true }],
  ["provider-executed call", { executed: true }],
] satisfies [string, ReadFixture][])("preserves both reads with %s", (_reason, variation) => {
  const first = step(read("first"))
  const second = step(read("second", variation))
  const evidence = readEvidence([first.durable, second.durable])

  expect(readRegions([...first.wire, ...second.wire], { ...eligible, evidence })).toEqual([])
})

test("does not infer chronological coverage from nonidentical reads in a parallel batch", () => {
  const first = read("first", { input: { path, offset: 2 }, rows: ["second", "third"] })
  const batch = step(first, read("second"))

  expect(readRegions(batch.wire, { ...eligible, evidence: readEvidence([batch.durable]) })).toEqual([])
})

test.each([
  ["past-end tail", { input: { path, offset: 10 }, text: `Read file ${path}, lines 1-1 (offset 10 is past the end; the file has 1 line)\n1: only` }],
  ["negative tail", { input: { path, offset: -5 }, text: `Read file ${path}, lines 1-1\n1: only` }],
  ["truncation footer", { text: `Read file ${path}, lines 1-1\n1: first\n[Output truncated. Continue reading with offset: 2]` }],
  ["clamped line", { rows: ["x".repeat(2000) + "... (line truncated to 2000 chars)"] }],
  ["malformed rows", { text: `Read file ${path}, lines 1-2\n1: first\n3: third` }],
  ["inconsistent limit", { input: { path, limit: 1 }, rows: ["first", "second"] }],
  ["different rendered path", { text: `Read file ${resolve("/other/logic.ts")}, lines 1-1\n1: only` }],
  ["directory listing", { text: `Read directory ${path}, entries 1-1\nlogic.ts` }],
] satisfies [string, ReadFixture][])("keeps even byte-identical results for a %s", (_reason, variation) => {
  const first = step(read("first", variation))
  const second = step(read("second", variation))
  const evidence = readEvidence([first.durable, second.durable])

  expect(readRegions([...first.wire, ...second.wire], { ...eligible, evidence })).toEqual([])
})

test.each([
  resolve("/workspace/AGENTS.md"),
  resolve("/workspace/SKILL.md"),
  resolve("/workspace/.opencode/skills/a/references/source.ts"),
  resolve("/data/opencode/tool-output/tool_native123"),
  resolve("/data/opencode/shell/project-id/sh_0123456789abbmX93ehri1f9A.out"),
  resolve("/other/tool_0123456789ab_kvguard_" + "a".repeat(52)),
  "relative/source.ts",
  "skill://test/reference.md",
  "artifact://test",
])("keeps protected or nonabsolute read target %s", (target) => {
  const first = step(read("first", { input: { path: target } }))
  const second = step(read("second", { input: { path: target } }))
  const evidence = readEvidence([first.durable, second.durable])

  expect(readRegions([...first.wire, ...second.wire], { ...eligible, evidence })).toEqual([])
})

test("keeps a native read of a durably attached path even when the attachment uses another name", () => {
  const target = resolve("/workspace/attached file.ts")
  const first = step(read("first", { input: { path: target } }))
  const second = step(read("second", { input: { path: target } }))
  const user: SessionMessageUser = {
    type: "user", id: SessionMessage.ID.create(), time: { created: 2 }, text: "Review this",
    files: [{ mime: "text/plain", data: "", name: "renamed", source: { type: "uri", uri: pathToFileURL(target).href } }],
  }
  const evidence = readEvidence([first.durable, second.durable, user])

  expect(readRegions([...first.wire, ...second.wire], { ...eligible, evidence })).toEqual([])
})

test.each([
  ["no evidence", false, (owner: WireMessage, result: WireMessage) => [owner, result]],
  ["changed raw result", true, (owner: WireMessage, result: WireMessage) => [owner, { ...result, content: `${result.content}\n` }]],
  ["changed arguments", true, (_owner: WireMessage, result: WireMessage) => [step(read("second", { input: { path, limit: 3 } })).owner, result]],
  ["opaque result", true, (owner: WireMessage, result: WireMessage) => [owner, { ...result, content: [{ type: "file", uri: "file:///opaque" }] }]],
  ["signed result", true, (owner: WireMessage, result: WireMessage) => [owner, { ...result, signature: "signature" }]],
  ["unknown result metadata", true, (owner: WireMessage, result: WireMessage) => [owner, { ...result, provider_options: { reference: "opaque" } }]],
  ["opaque assistant", true, (owner: WireMessage, result: WireMessage) => [{ ...owner, reasoning_opaque: "opaque" }, result]],
] as const)("keeps history with %s at the provider boundary", (_reason, attested, transform) => {
  const first = step(read("first"))
  const secondRead = read("second")
  const second = step(secondRead)
  const messages = [...first.wire, ...transform(second.owner, secondRead.result)]
  const evidence = attested ? readEvidence([first.durable, second.durable]) : undefined

  expect(readRegions(messages, { ...eligible, evidence })).toEqual([])
})

test("does not use a call ID repeated in durable history, even if only one occurrence is on the wire", () => {
  const first = step(read("first"))
  const second = step(read("second"))
  const repeated = step(read("second", { error: true }))
  const evidence = readEvidence([first.durable, second.durable, repeated.durable])

  expect(readRegions([...first.wire, ...second.wire], { ...eligible, evidence })).toEqual([])
})

test("does not use repeated wire IDs to pick a witness or claim a raw result", () => {
  const first = step(read("first"))
  const second = step(read("second"))
  const evidence = readEvidence([first.durable, second.durable])

  expect(readRegions([...first.wire, ...second.wire, ...second.wire], { ...eligible, evidence })).toEqual([])
})
