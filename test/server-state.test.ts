import { afterEach, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckpointStore } from "../src/checkpoints"
import { ServerState, type StateOptions } from "../src/server-state"
import type { TransportRequest } from "../src/server-transport"
import { digest, type ChatBody } from "../src/shared"

type HistoryEvent = Parameters<ServerState["onEvent"]>[0]

const sessionID = "session"
const project = "project"
const lane = "fixture/tenant-A/session"
const primary: ChatBody = { model: "fixture", messages: [{ role: "user", content: "Private task" }] }
const answer = { role: "assistant", content: "Answer" }
const extended: ChatBody = { ...primary, messages: [...primary.messages, answer, { role: "user", content: "Next question" }] }
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function options(overrides: Partial<StateOptions> = {}): Promise<StateOptions> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "kv-guard-v2-state-"))
  directories.push(stateDirectory)
  return { providers: ["fixture"], diagnostics: false, persistence: true, prefixGuard: true, usageAccounting: true, stateDirectory, ...overrides }
}

function request(body: ChatBody = primary, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    id: randomUUID(), providerID: "fixture", sessionID, agent: "build", kind: "primary", endpoint: digest("endpoint"),
    lane, headScope: digest("head scope"), body, signal: new AbortController().signal, ...overrides,
  }
}

function checkpoint({ stateDirectory }: StateOptions) {
  return new CheckpointStore(join(stateDirectory, "checkpoints"), project, "opencode-v2-wire")
}

function outgoing(body: ChatBody | Response | void) {
  if (body instanceof Response) throw new Error(`Unexpected compaction response: ${body.status}`)
  return body
}

const eventBase = { id: "event", created: 1 }
const durable = { aggregateID: sessionID, seq: 42 }
const historyEvents = [
  { ...eventBase, type: "session.forked", durable: { ...durable, version: 2 }, data: { sessionID, parentID: "parent", boundary: { type: "through", messageID: "message" } } },
  { ...eventBase, type: "session.revert.staged", durable: { ...durable, version: 1 }, data: { sessionID, revert: { messageID: "message" } } },
  { ...eventBase, type: "session.revert.cleared", durable: { ...durable, version: 1 }, data: { sessionID } },
  { ...eventBase, type: "session.revert.committed", durable: { ...durable, version: 1 }, data: { sessionID, to: "message" } },
  { ...eventBase, type: "session.compaction.ended", durable: { ...durable, version: 1 }, data: { sessionID, reason: "manual", text: "Native summary" } },
  { ...eventBase, type: "session.deleted", durable: { ...durable, version: 2 }, data: { sessionID } },
] satisfies readonly HistoryEvent[]

test("only the latest exact request controls retained usage and reasoning across servers", async () => {
  const config = await options()
  const first = new ServerState(project, config)
  const second = new ServerState(project, config)
  const stale = request()
  const latest = request()
  await first.onRequest(stale)
  await second.onRequest(latest)
  await second.onComplete(latest, { promptTokens: 725, cachedTokens: 32, finishReason: "stop", assistant: { ...answer, reasoning_content: "Current reasoning" } })

  await first.onComplete(stale, { promptTokens: 75, finishReason: "stop", assistant: { ...answer, reasoning_content: "Stale reasoning" } })

  const state = await checkpoint(config).load(sessionID)
  expect(state.snapshot?.usage.lanes).toEqual([expect.objectContaining({ anchor: expect.objectContaining({ promptTokens: 725 }) })])
  const resumed = new ServerState(project, config)
  const continued = outgoing(await resumed.onRequest(request(extended)))
  expect(continued?.messages[1]).toEqual({ ...answer, reasoning_content: "Current reasoning" })
})

test("does not accept a successful receipt for a structurally equivalent body that was never sent", async () => {
  const config = await options()
  const state = new ServerState(project, config)
  const dispatched = request()
  await state.onRequest(dispatched)
  const otherBody = { messages: dispatched.body.messages, model: dispatched.body.model }

  await state.onComplete({ ...dispatched, body: otherBody }, { promptTokens: 725, finishReason: "stop", assistant: { ...answer, reasoning_content: "Unbound reasoning" } })

  const saved = await checkpoint(config).load(sessionID)
  expect(saved.snapshot?.usage.lanes).toEqual([{ lane: digest(lane), receipt: dispatched.id }])
  const continuation = await state.onRequest(request(extended))
  expect(outgoing(continuation)?.messages[1]).toEqual(answer)
})

test("does not store the measured prompt as an anchor when cached tokens exceed it", async () => {
  const config = await options()
  const state = new ServerState(project, config)
  try {
    const dispatched = request()
    await state.onRequest(dispatched)
    await state.onComplete(dispatched, { promptTokens: 100, cachedTokens: 101, finishReason: "stop" })
    const saved = await checkpoint(config).load(sessionID)
    expect(saved.snapshot?.usage.lanes).toEqual([{ lane: digest(lane), receipt: dispatched.id }])
  } finally {
    await state.dispose()
  }
})

test.each(historyEvents)("invalidates retained evidence and in-flight receipts on $type", async (event) => {
  const config = await options()
  const state = new ServerState(project, config)
  const delayed = request()
  await state.onRequest(delayed)
  await state.onComplete(delayed, { promptTokens: 725, finishReason: "stop", assistant: { ...answer, reasoning_content: "Before boundary" } })
  const observer = new ServerState(project, config)
  const invalidating = observer.onEvent(event)
  await observer.dispose()
  await invalidating

  await state.onComplete(delayed, { promptTokens: 925, finishReason: "stop", assistant: { ...answer, reasoning_content: "Late response" } })

  const saved = await checkpoint(config).load(sessionID)
  if (event.type === "session.deleted") {
    expect(saved).toMatchObject({ reason: "deleted", snapshot: null })
    expect(await state.onRequest(request(extended))).toBeUndefined()
  } else {
    expect(saved.snapshot?.usage.lanes).toEqual([])
    expect(saved.snapshot?.prefix.lanes).toEqual([])
    expect(outgoing(await state.onRequest(request(extended)))?.messages[1]).toEqual(answer)
  }
})

test("a fork invalidates only the child, not the parent's active receipt", async () => {
  const config = await options()
  const state = new ServerState(project, config)
  const parent = request(primary, { sessionID: "parent" })
  await state.onRequest(parent)

  await state.onEvent(historyEvents[0])

  await state.onComplete(parent, { promptTokens: 950 })
  const saved = await checkpoint(config).load("parent")
  expect(saved.snapshot?.usage.lanes).toEqual([expect.objectContaining({ anchor: expect.objectContaining({ promptTokens: 950 }) })])
})

test("untracked native history events never create checkpoint files", async () => {
  const config = await options()
  const state = new ServerState(project, config)

  for (const event of historyEvents) await state.onEvent(event)

  expect(await readdir(config.stateDirectory, { recursive: true })).toEqual([])
})

test("disabled persistence retains evidence in the live instance only", async () => {
  const config = await options({ persistence: false })
  const state = new ServerState(project, config)
  const completed = request()
  await state.onRequest(completed)
  await state.onComplete(completed, { finishReason: "stop", assistant: { ...answer, reasoning_content: "Live reasoning" } })

  const live = await state.onRequest(request(extended))
  const restarted = await new ServerState(project, config).onRequest(request(extended))

  expect(outgoing(live)?.messages[1]).toEqual({ ...answer, reasoning_content: "Live reasoning" })
  expect(outgoing(restarted)?.messages[1]).toEqual(answer)
  expect(await readdir(config.stateDirectory, { recursive: true })).toEqual([])
})

test("auxiliary compaction does not replace primary receipts or replay state", async () => {
  const config = await options()
  const state = new ServerState(project, config)
  const initial = request()
  await state.onRequest(initial)
  const auxiliary = request({ model: "fixture", messages: [{ role: "user", content: "Summarize" }] }, { kind: "compaction" })

  expect(await state.onRequest(auxiliary)).toBeUndefined()
  await state.onComplete(auxiliary, { promptTokens: 86 })
  await state.onComplete(initial, { promptTokens: 125 })

  const saved = await checkpoint(config).load(sessionID)
  expect(saved.snapshot?.usage.lanes).toEqual([expect.objectContaining({ anchor: expect.objectContaining({ promptTokens: 125 }) })])
})

test("prefix diagnostics reuse the provider's measured occupancy and never print input", async () => {
  const config = await options({ diagnostics: true })
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const state = new ServerState(project, config)
    const initial = request()
    await state.onRequest(initial)
    await state.onComplete(initial, { promptTokens: 870, cachedTokens: 280 })
    const resumed = new ServerState(project, config)

    await resumed.onRequest(request())

    const diagnostics = log.mock.calls.flat().map((line) => JSON.parse(String(line)))
    expect(diagnostics.at(-1)).toMatchObject({
      event: "wire.prefix", estimatedPromptTokens: 870, firstRequest: false, sharedMessages: 1,
      wireFingerprint: digest(JSON.stringify(primary)), wireBytes: Buffer.byteLength(JSON.stringify(primary)),
    })
    expect(JSON.stringify(diagnostics)).not.toContain("Private task")
  } finally {
    log.mockRestore()
  }
})

test("rolling compaction restores its wire projection and usage receipt but discards them at a native boundary", async () => {
  const config = await options({ compaction: { thresholdTokens: 1200, keepRecentTokens: 128, summaryOutputTokens: 256 } })
  const body: ChatBody = { ...primary, max_tokens: 128, stream: true, messages: [
    { role: "system", content: "Preserve actual instructions" },
    { role: "user", content: `Original older user request ${"old text ".repeat(700)}` },
    answer,
    primary.messages[0],
  ] }
  let summaries = 0
  const compact = (source: ChatBody) => request(source, { compaction: {
    limits: { context: 16000, output: 1024, wireOutput: 128 }, currentUser: source.messages.at(-1)!,
    async completeSummary() {
      summaries++
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: `Checkpoint ${summaries}` } }] })
    },
  } })
  const initial = new ServerState(project, config)
  const original = compact(body)
  const projected = outgoing(await initial.onRequest(original))!
  expect(summaries).toBe(1)
  expect(JSON.stringify(projected)).toContain("Checkpoint 1")
  expect(JSON.stringify(projected)).not.toContain("Original older user request")
  await initial.onComplete({ ...original, body: projected }, { promptTokens: 400, finishReason: "stop", assistant: answer })
  expect((await checkpoint(config).load(sessionID)).snapshot?.usage.lanes[0]?.anchor?.promptTokens).toBe(400)
  await initial.dispose()

  const restored = new ServerState(project, config)
  const continued = { ...body, messages: [...body.messages, answer, { role: "user", content: "Next task" }] }
  const resumed = outgoing(await restored.onRequest(compact(continued)))!
  expect(resumed.messages.slice(0, projected.messages.length)).toEqual(projected.messages)
  expect(summaries).toBe(1)

  await restored.onEvent(historyEvents[4])
  expect((await checkpoint(config).load(sessionID)).snapshot?.compaction).toBeUndefined()
  const replaced = outgoing(await restored.onRequest(compact(continued)))
  expect(summaries).toBe(2)
  expect(JSON.stringify(replaced)).not.toContain("Checkpoint 1")
})

test("a durable history change cancels a summary before publishing its projection", async () => {
  const config = await options({ compaction: { thresholdTokens: 1200, keepRecentTokens: 128 } })
  const state = new ServerState(project, config)
  const body: ChatBody = { ...primary, max_tokens: 128, messages: [
    { role: "user", content: "prior discussion ".repeat(450) }, answer, ...primary.messages,
  ] }
  const entered = Promise.withResolvers<AbortSignal>()
  const preparation = state.onRequest(request(body, { compaction: {
    limits: { context: 32000, output: 1024, wireOutput: 128 }, currentUser: body.messages.at(-1)!,
    async completeSummary(_body, signal) {
      if (!signal) throw new Error("Expected compaction cancellation signal")
      entered.resolve(signal)
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    },
  } }))
  const signal = await entered.promise
  const boundary = state.onEvent(historyEvents[4])
  await expect(preparation).rejects.toThrow("session history changed during compaction")
  await boundary
  expect(signal.aborted).toBe(true)
  const saved = await checkpoint(config).load(sessionID)
  expect(saved.snapshot).toMatchObject({ boundary: durable.seq, prefix: { lanes: [] }, usage: { lanes: [] } })
  expect(saved.snapshot?.compaction).toBeUndefined()
})

test("a successful main response starts speculation without publishing it; a matching extension adopts it", async () => {
  const config = await options({
    compaction: { bytesPerToken: 1, thresholdTokens: 5500, keepRecentTokens: 256, summaryOutputTokens: 256 },
    diagnostics: true, speculativeCompaction: true, usageAccounting: false,
  })
  const staged = Promise.withResolvers<void>()
  const log = spyOn(console, "error").mockImplementation((line) => {
    if (JSON.parse(String(line)).event === "wire.compaction-staged") staged.resolve()
  })
  const state = new ServerState(project, config)
  const old = { role: "user", content: "Old narrative " + "history ".repeat(480) }
  const body: ChatBody = { ...primary, stream: true, max_tokens: 128, messages: [old, answer, ...primary.messages] }
  const limits = { context: 16000, output: 1024, wireOutput: 128 }
  let background = 0
  let foreground = 0
  const prepare = (candidate: ChatBody) => request(candidate, { signal: new AbortController().signal, compaction: {
    limits, currentUser: candidate.messages.at(-1)!,
    async completeSummary() {
      foreground++
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Foreground summary" } }] })
    },
    async backgroundSummary(_body, signal) {
      signal.throwIfAborted()
      background++
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Staged summary" } }] })
    },
  } })
  try {
    const first = prepare(body)
    const initial = outgoing(await state.onRequest(first))!
    expect(initial).toEqual(body)
    expect(background).toBe(0)
    await state.onComplete({ ...first, body: initial }, { finishReason: "stop", assistant: answer })
    await staged.promise
    expect((await checkpoint(config).load(sessionID)).snapshot?.compaction).toBeUndefined()

    const next = { ...body, messages: [...body.messages, { role: "assistant", content: "new ".repeat(550) }, { role: "user", content: "Next task" }] }
    const prepared = outgoing(await state.onRequest(prepare(next)))
    expect(JSON.stringify(prepared)).toContain("Staged summary")
    expect(JSON.stringify(prepared)).not.toContain("Old narrative")
    expect(prepared?.messages.at(-1)).toEqual(next.messages.at(-1))
    expect({ foreground, background }).toEqual({ foreground: 0, background: 1 })
    expect((await checkpoint(config).load(sessionID)).snapshot?.compaction?.lanes).toHaveLength(1)
  } finally {
    log.mockRestore()
    await state.dispose()
  }
})

test("exact model thresholds override the global threshold without changing another provider", async () => {
  const config = await options({
    providers: ["fixture", "other"],
    compaction: { thresholdTokens: 10000, keepRecentTokens: 128, summaryOutputTokens: 256 },
    modelBudgets: [{ providerID: "fixture", modelID: "alias", thresholdPercent: 5 }],
  })
  const body: ChatBody = { ...primary, stream: true, max_tokens: 128, messages: [
    { role: "user", content: "Old context ".repeat(520) }, answer, ...primary.messages,
  ] }
  const state = new ServerState(project, config)
  let summaries = 0
  const prepare = (providerID: string) => request(body, { providerID, modelID: "alias", lane: providerID, compaction: {
    limits: { context: 16000, output: 1024, wireOutput: 128 }, currentUser: body.messages.at(-1)!,
    async completeSummary() {
      summaries++
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Model-specific summary" } }] })
    },
  } })
  try {
    expect(outgoing(await state.onRequest(prepare("other")))).toEqual(body)
    expect(summaries).toBe(0)
    const projected = outgoing(await state.onRequest(prepare("fixture")))
    expect(JSON.stringify(projected)).toContain("Model-specific summary")
    expect(summaries).toBe(1)
  } finally {
    await state.dispose()
  }
})

test("the next main request cancels unfinished speculation instead of waiting for it", async () => {
  const config = await options({
    compaction: { bytesPerToken: 1, thresholdTokens: 5500, keepRecentTokens: 256, summaryOutputTokens: 256 },
    speculativeCompaction: true, usageAccounting: false,
  })
  const state = new ServerState(project, config)
  const body: ChatBody = { ...primary, stream: true, max_tokens: 128, messages: [
    { role: "user", content: "history ".repeat(480) }, answer, ...primary.messages,
  ] }
  const started = Promise.withResolvers<AbortSignal>()
  let foreground = 0
  const prepare = (candidate: ChatBody) => request(candidate, { compaction: {
    limits: { context: 16000, output: 1024, wireOutput: 128 }, currentUser: candidate.messages.at(-1)!,
    async completeSummary() {
      foreground++
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Foreground summary" } }] })
    },
    async backgroundSummary(_body, signal) {
      started.resolve(signal)
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    },
  } })
  try {
    const first = prepare(body)
    const initial = outgoing(await state.onRequest(first))!
    await state.onComplete({ ...first, body: initial }, { finishReason: "stop", assistant: answer })
    const signal = await started.promise
    const next = { ...body, messages: [...body.messages, { role: "assistant", content: "new ".repeat(550) }, { role: "user", content: "Next task" }] }
    const forwarded = outgoing(await state.onRequest(prepare(next)))
    expect(signal.aborted).toBe(true)
    expect(foreground).toBe(1)
    expect(JSON.stringify(forwarded)).toContain("Foreground summary")
  } finally {
    await state.dispose()
  }
})

test("speculation sends once and discards a partial draft when two authority intervals need summaries", async () => {
  const config = await options({
    compaction: { bytesPerToken: 1, thresholdTokens: 5500, keepRecentTokens: 256, summaryOutputTokens: 256 },
    speculativeCompaction: true, prefixHandoff: false, persistence: false, usageAccounting: false,
  })
  const state = new ServerState(project, config)
  const body: ChatBody = { ...primary, stream: true, max_tokens: 128, messages: [
    { role: "user", content: "first ".repeat(300) }, answer,
    { role: "developer", content: "Later policy" },
    { role: "user", content: "second ".repeat(300) }, answer, ...primary.messages,
  ] }
  const completion = (text: string) =>
    Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] })
  let background = 0
  let foreground = 0
  const prepare = (candidate: ChatBody) => request(candidate, { compaction: {
    limits: { context: 16000, output: 1024, wireOutput: 128 }, currentUser: candidate.messages.at(-1)!,
    async completeSummary() { return completion(`Foreground summary ${++foreground}`) },
    async backgroundSummary() { return completion(`Background summary ${++background}`) },
  } })
  try {
    const first = prepare(body)
    const initial = outgoing(await state.onRequest(first))!
    await state.onComplete({ ...first, body: initial }, { finishReason: "stop", assistant: answer })
    // Let the in-memory response and both summary steps settle without another request interrupting the draft.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(background).toBe(1)
    const next = { ...body, messages: [...body.messages, { role: "assistant", content: "new ".repeat(550) }, { role: "user", content: "Next task" }] }
    const forwarded = outgoing(await state.onRequest(prepare(next)))!
    const calls = foreground
    const baseline = new ServerState(project, { ...config, speculativeCompaction: false })
    try {
      foreground = 0
      expect(outgoing(await baseline.onRequest(prepare(next)))).toEqual(forwarded)
      expect(calls).toBe(foreground)
      expect(calls).toBeGreaterThanOrEqual(2)
    } finally {
      await baseline.dispose()
    }
  } finally {
    await state.dispose()
  }
})
