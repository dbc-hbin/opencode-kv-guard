import { describe, expect, test } from "bun:test"
import { OpenCode, type OpenCodeEvent, type SessionMessageAssistant, type SessionMessageInfo } from "@opencode/client"
import { watchSessionUsage } from "../src/tui"

function assistant(id: string, input: number, cache = { read: 0, write: 0 }): SessionMessageAssistant {
  return {
    id,
    type: "assistant",
    time: { created: 1, completed: 2 },
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    content: [],
    tokens: { input, cache, output: 900, reasoning: 800 },
  }
}

function fixture(intercept?: (request: Request, response: Response) => Response | Promise<Response>) {
  const listeners = new Set<(event: { details: OpenCodeEvent }) => void>()
  const sessions = new Map<string, {
    readonly messages: readonly SessionMessageInfo[]
    readonly boundary?: string
    readonly origin?: string
  }>()
  const client = OpenCode.make({
    baseUrl: "http://cache-usage.test",
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const [, , , id, endpoint] = url.pathname.split("/")
      const session = sessions.get(id)
      if (!session) return new Response(null, { status: 404 })
      if (!endpoint) {
        return Response.json({ data: {
          id,
          fork: session.origin && { sessionID: session.origin },
          revert: session.boundary && { messageID: session.boundary },
        } })
      }
      const cursor = url.searchParams.get("cursor")
      const requestedOrder = url.searchParams.get("order")
      if (cursor && requestedOrder) return new Response(null, { status: 400 })
      const [order, offsetText] = cursor?.split(":") ?? [requestedOrder ?? "desc", "0"]
      const offset = Number(offsetText)
      const limit = Number(url.searchParams.get("limit") ?? 50)
      const type = url.searchParams.get("type")
      const messages = session.messages.filter((message) => !type || message.type === type)
      const data = (order === "desc" ? messages.toReversed() : messages).slice(offset, offset + limit)
      const response = Response.json({ data, cursor: { next: data.length ? `${order}:${offset + data.length}` : null } })
      return intercept?.(request, response) ?? response
    }, { preconnect: fetch.preconnect }),
  })
  const emit = (details: OpenCodeEvent) => {
    for (const listen of listeners) listen({ details })
  }
  type Rates = NonNullable<Parameters<Parameters<typeof watchSessionUsage>[2]>[0]>
  const watch = (id: string) => {
    let next = Promise.withResolvers<Rates>()
    const observed: Rates[] = []
    const dispose = watchSessionUsage({
      client,
      data: {
        listen(handler) {
          listeners.add(handler)
          return () => { listeners.delete(handler) }
        },
      },
    }, id, (rates) => {
      if (!rates) return
      observed.push(rates)
      next.resolve(rates)
      next = Promise.withResolvers<Rates>()
    })
    return {
      observed,
      next: () => next.promise,
      dispose,
    }
  }
  return { sessions, emit, watch }
}

const durable = (sessionID: string) => ({ aggregateID: sessionID, seq: 1, version: 1 } as const)

function ended(sessionID: string, message: SessionMessageAssistant): OpenCodeEvent {
  if (!message.tokens) throw new Error("The test step must report usage")
  return {
    id: `ended-${message.id}`, created: 2, durable: durable(sessionID), type: "session.step.ended",
    data: { sessionID, assistantMessageID: message.id, cost: 0, finish: "stop", tokens: message.tokens },
  }
}

describe("TUI input cache rates", () => {
  test("includes every page and weights reads by all input, including cache writes", async () => {
    const current = fixture()
    current.sessions.set("session", { messages: [
      assistant("old-miss", 1000),
      ...Array.from({ length: 200 }, (_, index) => assistant(`hit-${index}`, 0, { read: 10, write: 0 })),
      assistant("last", 10, { read: 30, write: 10 }),
    ] })
    const watch = current.watch("session")
    try {
      expect(await watch.next()).toEqual({ last: 60, session: 67 })
    } finally {
      watch.dispose()
    }
  })

  test("merges live completions with a delayed snapshot and ignores other sessions", async () => {
    const pending = Promise.withResolvers<Response>()
    const snapshot = Promise.withResolvers<Response>()
    const current = fixture((request, response) => {
      if (new URL(request.url).searchParams.has("cursor")) return response
      snapshot.resolve(response)
      return pending.promise
    })
    current.sessions.set("session", { messages: [assistant("overlap", 100)] })
    const watch = current.watch("session")
    const update = watch.next()
    try {
      const captured = await snapshot.promise
      current.emit(ended("session", assistant("overlap", 50, { read: 50, write: 0 })))
      current.emit(ended("session", assistant("live", 0, { read: 100, write: 0 })))
      current.emit(ended("other", assistant("irrelevant", 500)))
      expect(watch.observed).toEqual([])
      pending.resolve(captured)
      expect(await update).toEqual({ last: 100, session: 75 })

      const next = watch.next()
      current.emit(ended("session", assistant("next", 100)))
      expect(await next).toEqual({ last: 0, session: 50 })
      watch.dispose()
      current.emit(ended("session", assistant("after-disposal", 100)))
      expect(watch.observed).toHaveLength(2)
    } finally {
      pending.resolve(Response.json({ data: [], cursor: {} }))
      watch.dispose()
    }
  })

  test("does not reuse a previous hit rate when the last step reports no input", async () => {
    const current = fixture()
    current.sessions.set("session", { messages: [
      assistant("hit", 0, { read: 100, write: 0 }),
      assistant("unknown", 0),
    ] })
    const watch = current.watch("session")
    try {
      expect(await watch.next()).toEqual({ last: undefined, session: 100 })
    } finally {
      watch.dispose()
    }
  })

  test("a stored terminal failure without usage clears last request but preserves measured session usage", async () => {
    const current = fixture()
    current.sessions.set("session", { messages: [
      assistant("hit", 20, { read: 80, write: 0 }),
      { ...assistant("failed", 0), tokens: undefined, error: { type: "provider", message: "No usage received" } },
    ] })
    const watch = current.watch("session")
    try {
      expect(await watch.next()).toEqual({ last: undefined, session: 80 })
    } finally {
      watch.dispose()
    }
  })

  test("projects the fork's own ordered history through stage, clear, and commit", async () => {
    const current = fixture()
    const kept = assistant("fork_2", 50, { read: 50, write: 0 })
    const boundary = { id: "fork_9", type: "user", time: { created: 3 }, text: "Undo here" } as const
    const discarded = Array.from({ length: 201 }, (_, index) =>
      assistant(`fork_${index + 10}`, 0, { read: 100, write: 0 }))
    const messages = [kept, boundary, ...discarded]
    current.sessions.set("parent", { messages: [assistant("parent-only", 10_000)] })
    current.sessions.set("fork", { messages, origin: "parent", boundary: boundary.id })
    const watch = current.watch("fork")
    try {
      expect(await watch.next()).toEqual({ last: 50, session: 50 })

      const cleared = watch.next()
      current.sessions.set("fork", { messages, origin: "parent" })
      current.emit({ id: "clear", created: 4, type: "session.revert.cleared", durable: durable("fork"), data: { sessionID: "fork" } })
      expect(await cleared).toEqual({ last: 100, session: 100 })

      const staged = watch.next()
      current.sessions.set("fork", { messages, origin: "parent", boundary: boundary.id })
      current.emit({
        id: "stage", created: 5, type: "session.revert.staged", durable: durable("fork"),
        data: { sessionID: "fork", revert: { messageID: boundary.id } },
      })
      expect(await staged).toEqual({ last: 50, session: 50 })

      const committed = watch.next()
      current.sessions.set("fork", { messages: [kept], origin: "parent" })
      current.emit({
        id: "commit", created: 6, type: "session.revert.committed", durable: durable("fork"),
        data: { sessionID: "fork", to: boundary.id },
      })
      expect(await committed).toEqual({ last: 50, session: 50 })
      const updated = watch.next()
      current.emit(ended("fork", assistant("replacement", 100)))
      expect(await updated).toEqual({ last: 0, session: 25 })
    } finally {
      watch.dispose()
    }
  })
})
