import { describe, expect, test } from "bun:test"
import type { TuiEventBus } from "@opencode-ai/plugin/tui"
import { createOpencodeClient, type AssistantMessage, type Event, type Part } from "@opencode-ai/sdk/v2"
import { responsePerformance, watchSessionUsage } from "../src/tui"

function assistant(id: string, input: number, read = 0, write = 0): AssistantMessage {
  return {
    id, sessionID: "session", role: "assistant", time: { created: 1 }, parentID: "user", modelID: "fixture", providerID: "fixture", mode: "build", agent: "build",
    path: { cwd: "/fixture", root: "/fixture" }, cost: 0, tokens: { input, output: 0, reasoning: 0, cache: { read, write } },
  }
}

describe("TUI output throughput", () => {
  test.each([
    { output: 60, reasoning: 40, duration: 2000, expected: 50 },
    { output: 0, reasoning: 100, duration: 2000, expected: 50 },
    { output: 60, reasoning: 40, duration: 10_000, expected: 10 },
    { output: 60, reasoning: 40, duration: 100, expected: 1000 },
    { output: 60, reasoning: 40, duration: 99, expected: undefined },
    { output: 0, reasoning: 0, duration: 2000, expected: undefined },
    { output: NaN, reasoning: 0, duration: 2000, expected: undefined },
    { output: 60, reasoning: 40, duration: Infinity, expected: undefined },
    { output: 60, reasoning: 40, duration: -1, expected: undefined },
  ])("uses all reported output over elapsed time: $output + $reasoning / $duration ms", ({ output, reasoning, duration, expected }) => {
    const message = assistant("reply", 1000, 800)
    message.tokens.output = output
    message.tokens.reasoning = reasoning
    message.time.completed = message.time.created + duration
    expect(responsePerformance([message], () => []).throughput).toBe(expected)
  })

  test("uses only the latest assistant and clears an old rate when a new response starts", () => {
    const completed = assistant("old", 1000)
    completed.tokens.output = 100
    completed.time.completed = completed.time.created + 2000
    const user = { id: "user", sessionID: "session", role: "user", time: { created: 3000 }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } } as const
    const pending = assistant("new", 0)
    expect(responsePerformance([], () => []).throughput).toBeUndefined()
    expect(responsePerformance([user], () => []).throughput).toBeUndefined()
    expect(responsePerformance([completed, user], () => []).throughput).toBe(50)
    expect(responsePerformance([completed, user, pending], () => []).throughput).toBeUndefined()
    pending.tokens.output = 200
    expect(responsePerformance([completed, user, pending], () => []).throughput).toBeUndefined()
    pending.time.completed = pending.time.created + 2000
    expect(responsePerformance([completed, user, pending], () => []).throughput).toBe(100)
  })

  test("separates first-token latency, generation throughput and end-to-end time using persisted parts", () => {
    const message = assistant("reply", 1000, 800)
    message.time = { created: 1000, completed: 6000 }
    message.tokens.output = 120
    message.tokens.reasoning = 80
    const parts: Part[] = [
      { id: "synthetic", sessionID: "session", messageID: "reply", type: "text", text: "injected", synthetic: true, time: { start: 1000, end: 1000 } },
      { id: "empty", sessionID: "session", messageID: "reply", type: "text", text: "", time: { start: 1100, end: 1100 } },
      { id: "reasoning", sessionID: "session", messageID: "reply", type: "reasoning", text: "thinking", time: { start: 2000, end: 3000 } },
      { id: "answer", sessionID: "session", messageID: "reply", type: "text", text: "answer", time: { start: 4000, end: 5900 } },
    ]
    expect(responsePerformance([message], (id) => id === message.id ? parts : [])).toEqual({
      ttftMs: 1000, throughput: 40, generationThroughput: 50, e2eMs: 5000,
    })
    message.time.completed = undefined
    expect(responsePerformance([message], () => parts)).toEqual({
      ttftMs: 1000, throughput: undefined, generationThroughput: undefined, e2eMs: undefined,
    })
  })

  test("does not invent first-token timing from tools, untimed parts or invalid timestamps", () => {
    const message = assistant("reply", 1000)
    message.time = { created: 1000, completed: 6000 }
    message.tokens.output = 200
    const text: Part = { id: "text", sessionID: "session", messageID: "reply", type: "text", text: "answer", time: { start: 2000, end: 5900 } }
    const tool: Part = { id: "tool", sessionID: "session", messageID: "reply", type: "tool", tool: "read", callID: "call", state: { status: "running", input: {}, time: { start: 1500 } } }
    const candidates: Part[][] = [
      [], [tool], [tool, text], [{ ...text, time: undefined }],
      [{ ...text, time: { start: 999 } }], [{ ...text, time: { start: 6001 } }], [{ ...text, time: { start: NaN } }],
    ]
    for (const parts of candidates) expect(responsePerformance([message], () => parts)).toEqual({
      ttftMs: undefined, throughput: 40, generationThroughput: undefined, e2eMs: 5000,
    })
    expect(responsePerformance([message], () => [{ ...text, time: { start: 6000 } }])).toEqual({
      ttftMs: 5000, throughput: 40, generationThroughput: undefined, e2eMs: 5000,
    })
  })
})

function fixture() {
  const listeners = new Set<(event: Event) => void>()
  const event: TuiEventBus = {
    on(type, handler) {
      const listener = (event: Event) => {
        if (event.type === type) handler(event as Parameters<typeof handler>[0])
      }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const requested = Promise.withResolvers<URL>()
  const response = Promise.withResolvers<Response>()
  const requests: URL[] = []
  const client = createOpencodeClient({
    baseUrl: "http://cache-usage.test",
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url)
      requests.push(url)
      requested.resolve(url)
      return response.promise
    }, { preconnect: globalThis.fetch.preconnect }),
  })
  const emit = (event: Event) => { for (const listener of listeners) listener(event) }
  const update = (info: AssistantMessage) => emit({ id: `event-${info.id}`, type: "message.updated", properties: { sessionID: info.sessionID, info } })
  const remove = (messageID: string) => emit({ id: `removed-${messageID}`, type: "message.removed", properties: { sessionID: "session", messageID } })
  const resolve = (messages: AssistantMessage[]) => response.resolve(Response.json(messages.map((info) => ({ info, parts: [] }))))
  return { api: { client, event }, requested: requested.promise, requests, listeners, update, remove, resolve }
}

describe("TUI session cache usage", () => {
  test("counts misses older than the latest 100 messages and updates totals without refetching", async () => {
    const current = fixture()
    const initial = Promise.withResolvers<{ read: number; prompt: number }>()
    const updates: { read: number; prompt: number }[] = []
    const dispose = watchSessionUsage(current.api, "session", (usage) => { updates.push(usage); initial.resolve(usage) })
    try {
      const request = await current.requested
      expect(request.pathname).toBe("/session/session/message")
      expect(request.searchParams.has("limit")).toBe(false)
      current.resolve([assistant("old-miss", 100_000), ...Array.from({ length: 100 }, (_, index) => assistant(`hit-${index}`, 0, 1000))])
      expect(await initial.promise).toEqual({ read: 100_000, prompt: 200_000 })
      const changed = assistant("hit-99", 100, 400, 500)
      current.update(changed)
      current.update(changed)
      expect(updates.at(-1)).toEqual({ read: 99_400, prompt: 200_000 })
      current.update({ ...assistant("other", 1000), sessionID: "other-session" })
      expect(updates.at(-1)).toEqual({ read: 99_400, prompt: 200_000 })
      current.update(assistant("new-hit", 0, 1000))
      current.remove("old-miss")
      expect(updates.at(-1)).toEqual({ read: 100_400, prompt: 101_000 })
      expect(current.requests).toHaveLength(1)
    } finally {
      dispose()
    }
    expect(current.listeners.size).toBe(0)
    const count = updates.length
    current.update(assistant("after-dispose", 500))
    expect(updates).toHaveLength(count)
  }, 2000)

  test("keeps updates and removals received while full history is loading", async () => {
    const current = fixture()
    const initial = Promise.withResolvers<{ read: number; prompt: number }>()
    const dispose = watchSessionUsage(current.api, "session", initial.resolve)
    try {
      await current.requested
      current.update(assistant("changed", 50, 50))
      current.remove("removed")
      current.update(assistant("new", 0, 100))
      current.resolve([assistant("changed", 100), assistant("removed", 0, 100)])
      expect(await initial.promise).toEqual({ read: 150, prompt: 200 })
    } finally {
      dispose()
    }
  }, 2000)

  test("retries the full history load after it fails, on the next update", async () => {
    const listeners = new Set<(event: Event) => void>()
    const event: TuiEventBus = {
      on(type, handler) {
        const listener = (event: Event) => { if (event.type === type) handler(event as Parameters<typeof handler>[0]) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const attempts: PromiseWithResolvers<Response>[] = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
    const requested = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let calls = 0
    const client = createOpencodeClient({
      baseUrl: "http://cache-usage-retry.test",
      fetch: Object.assign(async () => {
        const index = calls++
        requested[index]?.resolve()
        return attempts[index]?.promise ?? Promise.reject(new Error("unexpected extra load"))
      }, { preconnect: globalThis.fetch.preconnect }),
    })
    const emit = (info: AssistantMessage) => { for (const listener of listeners) listener({ id: `event-${info.id}`, type: "message.updated", properties: { sessionID: info.sessionID, info } }) }
    const updates: { read: number; prompt: number }[] = []
    const reported = Promise.withResolvers<{ read: number; prompt: number }>()
    const loadFailed = Promise.withResolvers<unknown>()
    const dispose = watchSessionUsage({ client, event }, "session", (usage) => { updates.push(usage); reported.resolve(usage) }, loadFailed.resolve)
    try {
      await requested[0]!.promise
      attempts[0]!.resolve(new Response("unavailable", { status: 503 }))
      await loadFailed.promise
      // The failed load reports nothing; the next update for this session retries it.
      emit(assistant("live", 10, 10))
      await requested[1]!.promise
      expect(updates).toEqual([])
      attempts[1]!.resolve(Response.json([assistant("old", 1000), assistant("live", 10, 10)].map((info) => ({ info, parts: [] }))))
      expect(await reported.promise).toEqual({ read: 10, prompt: 1020 })
      expect(calls).toBe(2)
    } finally {
      dispose()
    }
  }, 2000)
})
