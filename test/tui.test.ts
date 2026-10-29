import { describe, expect, test } from "bun:test"
import type { TuiEventBus } from "@opencode-ai/plugin/tui"
import { createOpencodeClient, type AssistantMessage, type Event } from "@opencode-ai/sdk/v2"
import { watchSessionUsage } from "../src/tui"

function assistant(id: string, input: number, read = 0, write = 0): AssistantMessage {
  return {
    id, sessionID: "session", role: "assistant", time: { created: 1 }, parentID: "user", modelID: "fixture", providerID: "fixture", mode: "build", agent: "build",
    path: { cwd: "/fixture", root: "/fixture" }, cost: 0, tokens: { input, output: 0, reasoning: 0, cache: { read, write } },
  }
}

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
