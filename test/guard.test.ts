import { describe, expect, test } from "bun:test"
import { parseOptions } from "../src/options"
import { cancellableResponse } from "../src/transport"

describe("cancellable response", () => {
  test("closes a bodyless response synchronously", () => {
    const upstream = new Response(null, { status: 204 })
    let closed = 0
    const response = cancellableResponse(upstream, new AbortController().signal, () => { closed++ })
    expect(response).toBe(upstream)
    expect(closed).toBe(1)
  })

  test("preserves streaming bytes and headers and calls onClose only at EOF", async () => {
    const stream = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const upstream = new Response(new ReadableStream({ start: stream.resolve }), { headers: { "content-type": "text/event-stream", "x-proof": "kept" } })
    const abort = new AbortController()
    let closed = 0
    const response = cancellableResponse(upstream, abort.signal, () => { closed++ })
    const controller = await stream.promise
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Expected a response stream")
    const bytes = new TextEncoder().encode("data: first\n\n")
    controller.enqueue(bytes)
    expect((await reader.read()).value).toEqual(bytes)
    expect(closed).toBe(0)
    expect(response.headers.get("x-proof")).toBe("kept")
    controller.close()
    expect((await reader.read()).done).toBe(true)
    abort.abort()
    expect(closed).toBe(1)
  })

  test("consumer cancellation forwards its reason and waits for upstream cleanup", async () => {
    const cancelled = Promise.withResolvers<unknown>()
    const done = Promise.withResolvers<void>()
    const upstream = new Response(new ReadableStream({
      cancel(reason) { cancelled.resolve(reason); return done.promise },
    }))
    const abort = new AbortController()
    let closed = 0
    const response = cancellableResponse(upstream, abort.signal, () => { closed++ })
    if (!response.body) throw new Error("Expected a response stream")
    const stopping = response.body.cancel("stop")
    try {
      expect(await cancelled.promise).toBe("stop")
      expect(closed).toBe(0)
    } finally {
      done.resolve()
      await stopping
    }
    expect(closed).toBe(1)
  })

  test("abort before a consumer reads cancels the upstream and preserves its reason", async () => {
    const abort = new AbortController()
    const cancelled = Promise.withResolvers<unknown>()
    let closed = 0
    const response = cancellableResponse(new Response(new ReadableStream({ cancel: cancelled.resolve })), abort.signal, () => { closed++ })
    const reason = new Error("stop active")
    abort.abort(reason)
    await expect(response.text()).rejects.toBe(reason)
    expect(await cancelled.promise).toBe(reason)
    expect(closed).toBe(1)
  })

  test("upstream body errors reach the reader and close the response", async () => {
    const failure = new Error("body")
    const source = new Response(new ReadableStream({ pull(controller) { controller.error(failure) } }))
    let closed = 0
    const response = cancellableResponse(source, new AbortController().signal, () => { closed++ })
    await expect(response.text()).rejects.toBe(failure)
    expect(closed).toBe(1)
  })

  test("preserves HTTP error status, headers and body bytes", async () => {
    const body = JSON.stringify({ error: { message: "kv cache capacity exhausted" } })
    const error = cancellableResponse(new Response(body, { status: 503, headers: { "retry-after": "3" } }), new AbortController().signal)
    expect(error.status).toBe(503)
    expect(error.headers.get("retry-after")).toBe("3")
    expect(await error.text()).toBe(body)
  })
})

test.each([
  {}, { providers: [] }, { providers: [""] },
  { providers: ["proxy"], maxConcurrent: 1 }, { providers: ["proxy"], crossProcess: false },
  { providers: ["proxy"], maxOutputTokens: "16" }, { providers: ["proxy"], stateDirectory: "relative/state" },
  { providers: ["proxy"], compaction: null }, { providers: ["proxy"], compaction: { triggerRatio: 0.8 } },
  { providers: ["proxy"], speculativeCompaction: "true" }, { providers: ["proxy"], codeModeTools: ["read"] },
])("invalid plugin options fail before hooks are registered: %j", (options) => {
  expect(() => parseOptions(options)).toThrow()
})
