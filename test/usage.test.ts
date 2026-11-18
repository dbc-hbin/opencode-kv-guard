import { describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { jsonSchema, stepCountIs, streamText } from "ai"
import type { ChatBody } from "../src/shared"
import type { WireMessage } from "../src/prefix"
import { observeResponse, UsageTracker, type ObservedCompletion } from "../src/usage"
import { cancellableResponse } from "../src/transport"

const encoder = new TextEncoder()

test("response replay records reasoning and tool fragments only after a complete successful stream without changing SSE bytes", async () => {
  const values = [
    { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Think " }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { reasoning_content: "carefully", tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "read", arguments: '{"file' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'Path":"a"}' } }] }, finish_reason: "tool_calls" }] },
  ]
  for (const done of [false, true]) {
    const recorded: unknown[] = []
    const source = values.map((value) => event(value)).join("") + (done ? "data: [DONE]\n\n" : "")
    const response = observeResponse(stream([encoder.encode(source)]), ({ assistant }) => {
      if (assistant) recorded.push(assistant)
    })
    expect(recorded).toEqual([])
    expect(await response.text()).toBe(source)
    expect(recorded).toEqual(done ? [{
      role: "assistant", content: "", reasoning_content: "Think carefully",
      tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: '{"filePath":"a"}' } }],
    }] : [])
  }
})

test("repeated tool-call id and name deltas are recorded once, like the SDK", async () => {
  const values = [
    { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"file' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: 'Path":"a"}' } }] }, finish_reason: "tool_calls" }] },
  ]
  const recorded: unknown[] = []
  const response = observeResponse(stream([encoder.encode(values.map((value) => event(value)).join("") + "data: [DONE]\n\n")]), ({ assistant }) => {
    if (assistant) recorded.push(assistant)
  })
  await response.text()
  expect(recorded).toEqual([{ role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"filePath":"a"}' } }] }])
  // A different id for the same index is ambiguous and must not be recorded.
  const conflicting = structuredClone(values)
  conflicting[1]!.choices[0]!.delta.tool_calls![0]!.id = "call_2"
  const rejected: unknown[] = []
  await observeResponse(stream([encoder.encode(conflicting.map((value) => event(value)).join("") + "data: [DONE]\n\n")]), ({ assistant }) => {
    if (assistant) rejected.push(assistant)
  }).text()
  expect(rejected).toEqual([])
})

test("tool replay arguments match the SDK round trip without changing response bytes", async () => {
  for (const [input, next, replayable] of [
    ['{"filePath": "/tmp/a"}', '{"filePath":"/tmp/a"}', true],
    ['{"2": 2, "1": 1, "path": "\\u002ftmp/a", "nested": [1.0, true]}', '{"1":1,"2":2,"path":"/tmp/a","nested":[1,true]}', true],
    [' [1, 2] ', '[1,2]', false],
    [' "path" ', '"path"', false],
    [' 1.0 ', '1', false],
    ['true', 'true', false],
    ['null', 'null', false],
    ['{"filePath":', '{}', false],
    ['', '{}', false],
  ] as const) {
    const recorded: WireMessage[] = []
    const requests: ChatBody[] = []
    const values = [
      { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "read", arguments: input.slice(0, 2) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: input.slice(2) } }] }, finish_reason: "tool_calls" }] },
    ]
    const source = values.map((value) => event(value)).join("") + "data: [DONE]\n\n"
    const provider = createOpenAICompatible({
      name: "fixture", baseURL: "http://127.0.0.1:1/v1",
      fetch: Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(await new Request(url, init).json() as ChatBody)
        if (requests.length > 1) return stream([encoder.encode(event({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n")])
        const response = observeResponse(stream([encoder.encode(source)]), ({ assistant }) => {
          if (assistant) recorded.push(assistant)
        })
        expect(await response.clone().text()).toBe(source)
        return response
      }, { preconnect: globalThis.fetch.preconnect }),
    })
    const result = streamText({
      model: provider.chatModel("fixture"), prompt: "Task", maxRetries: 0, stopWhen: stepCountIs(2),
      tools: { read: { inputSchema: jsonSchema({}), execute: async () => "result" } },
    })
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error
    }
    expect(await result.text).toBe("ok")
    expect(requests).toHaveLength(2)
    const assistant = requests[1]!.messages.find((message) => message.role === "assistant")!
    expect(assistant.tool_calls).toEqual([{ id: "call", type: "function", function: { name: "read", arguments: next } }])
    expect(recorded).toEqual(replayable ? [assistant] : [])

    const jsonRecorded: WireMessage[] = []
    const json = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: input } }] }, finish_reason: "tool_calls" }] })
    const response = observeResponse(new Response(json, { headers: { "content-type": "application/json" } }), ({ assistant }) => {
      if (assistant) jsonRecorded.push(assistant)
    })
    expect(await response.text()).toBe(json)
    expect(jsonRecorded).toEqual(recorded)
  }
})

test("truncated, opaque and multi-choice completions cannot become replay records", async () => {
  for (const choices of [
    [{ index: 0, message: { role: "assistant", content: "partial", reasoning_content: "reason" }, finish_reason: "length" }],
    [{ index: 0, message: { role: "assistant", content: "ok", signature: "opaque" }, finish_reason: "stop" }],
    [0, 1].map((index) => ({ index, message: { role: "assistant", content: "ok" }, finish_reason: "stop" })),
  ]) {
    const recorded: unknown[] = []
    const response = observeResponse(Response.json({ choices }), ({ assistant }) => {
      if (assistant) recorded.push(assistant)
    })
    await response.text()
    expect(recorded).toEqual([])
  }
})
const lane = JSON.stringify(["provider", "tenant-a", "session", "build"])
const fallback = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4)
type Final = { choices: { index: number; message: { role: string; content: string }; finish_reason: string }[]; usage: Record<string, unknown> }
function body(extra: ChatBody["messages"] = []): ChatBody {
  return { model: "fixture", messages: [{ role: "system", content: "Policy" }, { role: "user", content: "Task" }, ...extra], tools: [], chat_template_kwargs: { enable_thinking: true } }
}
function final(usage: Record<string, unknown> = { prompt_tokens: 100 }): Final {
  return { choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage }
}
function event(value: unknown, ending = "\n") {
  return `data: ${JSON.stringify(value)}${ending}${ending}`
}
function stream(chunks: Uint8Array[], headers: HeadersInit = { "content-type": "text/event-stream" }) {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) controller.close()
      else controller.enqueue(chunks[index++]!)
    },
  }, { highWaterMark: 0 }), { headers })
}
function watch(upstream: Response) {
  const receipts: ObservedCompletion[] = []
  const response = observeResponse(upstream, (receipt) => { receipts.push(receipt) })
  return { response, receipts }
}
function anchor(tracker: UsageTracker, prompt = body(), key = lane, tokens = 100, receipt?: string) {
  expect(tracker.record(tracker.begin(prompt, key, receipt), prompt, key, tokens)).toBe(true)
}

describe("provider usage anchors", () => {
  test("uses raw prompt tokens once, plus only the estimated appended message delta", () => {
    const tracker = new UsageTracker()
    const prompt = body()
    anchor(tracker, prompt, lane, 1_000)
    expect(tracker.estimate(prompt, lane, fallback)).toBe(1_000)
    const appended = body([{ role: "assistant", content: "Answer" }, { role: "user", content: "Next" }])
    expect(tracker.estimate(appended, lane, fallback)).toBe(1_000 + fallback(appended) - fallback(prompt))
    const tools = body([
      { role: "assistant", content: null, reasoning_content: "reason", tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call", content: [{ type: "text", text: "result" }] },
    ])
    expect(tracker.estimate(tools, lane, fallback)).toBe(1_000 + fallback(tools) - fallback(prompt))
  })

  test.each([false, true])("requires exact model, template, tools, nonmessage policy, history, tenant and lane (restored=%s)", (restored) => {
    let tracker = new UsageTracker()
    const prompt = body()
    anchor(tracker, prompt)
    if (restored) {
      const snapshot = tracker.snapshot([lane])
      tracker = new UsageTracker()
      tracker.restore(snapshot)
    }
    const edited = structuredClone(prompt)
    edited.messages[1]!.content = "Edited"
    const changed = [
      { ...prompt, model: "other" },
      { ...prompt, tools: [{ type: "function", function: { name: "new" } }] },
      { ...prompt, chat_template_kwargs: { enable_thinking: false } },
      { ...prompt, response_format: { type: "json_object" } },
      { ...prompt, messages: prompt.messages.slice(1) },
      { ...prompt, messages: [{ role: "user", content: "Compacted summary" }] },
      edited,
    ]
    for (const candidate of changed) expect(tracker.estimate(candidate, lane, fallback)).toBe(fallback(candidate))
    expect(tracker.estimate(prompt, JSON.stringify(["provider", "tenant-b", "session", "build"]), fallback)).toBe(fallback(prompt))
    expect(tracker.estimate(prompt, `${lane}:summary`, fallback)).toBe(fallback(prompt))
    expect(tracker.estimate(prompt, lane, fallback)).toBe(100)
  })

  test("does not infer changed policy overhead or appended media and signed fields", () => {
    const tracker = new UsageTracker()
    anchor(tracker)
    for (const message of [
      { role: "user", content: [{ type: "image_url", image_url: { url: "image" } }] },
      { role: "assistant", content: "text", signature: "signed" },
      { role: "assistant", content: null, reasoning: { signature: "signed" } },
      { role: "system", content: "Later policy" },
    ]) {
      const prompt = body([message])
      expect(tracker.estimate(prompt, lane, fallback)).toBe(fallback(prompt))
    }
    const appended = body([{ role: "user", content: "Next" }])
    expect(tracker.estimate(appended, lane, (value) => value === appended ? 1 : 2)).toBe(1)
  })

  test("newer dispatch wins even if the older response arrives last", () => {
    const tracker = new UsageTracker()
    const first = body()
    const next = body([{ role: "assistant", content: "Answer" }, { role: "user", content: "Next" }])
    const olderRequest = tracker.begin(first, lane)
    const newerRequest = tracker.begin(next, lane)
    // A checkpoint reload while requests are in flight must not reset their
    // dispatch ordering or replace the lane identity attached to the tickets.
    tracker.restore({ lanes: [] }, [lane])
    expect(tracker.record(newerRequest, next, lane, 200)).toBe(true)
    expect(tracker.record(olderRequest, first, lane, 50)).toBe(false)
    expect(tracker.estimate(next, lane, fallback)).toBe(200)
    expect(tracker.estimate(first, lane, fallback)).toBe(fallback(first))
  })

  test("history replacement invalidates the prior anchor even if the replacement is not recorded", () => {
    const tracker = new UsageTracker()
    anchor(tracker)
    const edited = body()
    edited.messages[1]!.content = "Replacement"
    tracker.begin(edited, lane)
    expect(tracker.estimate(body(), lane, fallback)).toBe(fallback(body()))
  })

  test.each([false, true])("checkpoint reload rejects old measurements before live mutation (delayedDispatch=%s)", (delayedDispatch) => {
    const first = new UsageTracker()
    const receipt = first.prepare(lane)
    const oldBody = body()
    const oldRequest = delayedDispatch ? undefined : first.begin(oldBody, lane, receipt)
    const newer = new UsageTracker()
    newer.restore(first.snapshot([lane]))
    const newerReceipt = newer.prepare(lane)
    const newBody = body([{ role: "assistant", content: "Answer" }, { role: "user", content: "새로운 기록" }])
    anchor(newer, newBody, lane, 16_500, newerReceipt)
    // A preparation reloads another process's checkpoint while the old
    // response in this instance is still in flight and has no newer dispatch.
    first.restore(newer.snapshot([lane]), [lane])

    const accepted = first.record(oldRequest ?? first.begin(oldBody, lane, receipt), oldBody, lane, 500)

    expect(accepted).toBe(false)
    expect(first.estimate(newBody, lane, fallback)).toBe(16_500)
  })

  test("delete and clear invalidate in-flight tickets without affecting other lanes", () => {
    const tracker = new UsageTracker()
    anchor(tracker, body(), "other", 300)
    const request = tracker.begin(body(), lane)
    tracker.delete(lane)
    expect(tracker.record(request, body(), lane, 100)).toBe(false)
    expect(tracker.estimate(body(), "other", fallback)).toBe(300)
    const clearing = tracker.begin(body(), "other")
    tracker.clear()
    expect(tracker.record(clearing, body(), "other", 100)).toBe(false)
    expect(tracker.estimate(body(), "other", fallback)).toBe(fallback(body()))
  })

  test("mismatched body or lane cannot commit another request's tokens", () => {
    const tracker = new UsageTracker()
    const prompt = body()
    const request = tracker.begin(prompt, lane)
    expect(tracker.record(request, prompt, "different", 100)).toBe(false)
    const changedRequest = tracker.begin(prompt, lane)
    prompt.messages[1]!.content = "Mutated after dispatch"
    expect(tracker.record(changedRequest, prompt, lane, 100)).toBe(false)
  })
})

describe("streaming usage observation", () => {
  test("preserves exact SSE bytes across every byte boundary and drains usage after DONE", async () => {
    const source = ": ping\r\nid: 1\r\n" + event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }, "\r\n") + event({ choices: [{ index: 0, delta: { content: "한😀" }, finish_reason: null }] }, "\r\n") + event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "\r\n") + "data: [DONE]\r\n\r\n" + event({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 9, total_tokens: 330, prompt_tokens_details: { cached_tokens: 250 } } }, "\r\n")
    const bytes = encoder.encode(source)
    const chunks = [...bytes].map((byte) => new Uint8Array([byte]))
    const observed = watch(stream(chunks))
    expect(new Uint8Array(await observed.response.arrayBuffer())).toEqual(bytes)
    expect(observed.receipts).toEqual([{
      promptTokens: 321, completionTokens: 9, totalTokens: 330, cachedTokens: 250,
      finishReason: "stop", assistant: { role: "assistant", content: "한😀" },
    }])
  })

  test("does not read ahead without downstream demand or stop at finish_reason", async () => {
    let pulls = 0
    const chunks = [event({ choices: [{ index: 0, delta: { content: "one" }, finish_reason: null }] }), event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), event({ choices: [], usage: { prompt_tokens: 400 } }), "data: [DONE]\n\n"]
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls++]
        if (chunk === undefined) controller.close()
        else controller.enqueue(encoder.encode(chunk))
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
    const observed = watch(upstream)
    expect(pulls).toBe(0)
    const reader = observed.response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(chunks[0])
    expect(pulls).toBe(1)
    for (let index = 1; index < chunks.length; index++) expect(new TextDecoder().decode((await reader.read()).value)).toBe(chunks[index])
    expect((await reader.read()).done).toBe(true)
    expect(observed.receipts).toMatchObject([{ promptTokens: 400 }])
  })

  test("accepts zero prompt tokens in a complete response without replayable content", async () => {
    const source = event({ choices: [{ index: 0, delta: { role: "assistant", content: "", tool_calls: [{ index: 0 }] }, finish_reason: null }] }) + event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0 } }) + "data: [DONE]\n\n"
    const observed = watch(stream([encoder.encode(source)]))
    await observed.response.text()
    expect(observed.receipts).toEqual([{ promptTokens: 0, finishReason: "stop" }])
  })

  for (const alias of ["cached_tokens", "prompt_cache_hit_tokens", "cachedContentTokenCount", "cache_read_input_tokens", "cache_hit_tokens"]) {
    test(`accepts numeric ${alias} without adding it to raw prompt_tokens`, async () => {
      const source = event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 200, [alias]: 150 } }) + event({ choices: [], usage: { prompt_tokens: 200, [alias]: 150 } }) + "data: [DONE]\n\n"
      const observed = watch(stream([encoder.encode(source)]))
      await observed.response.text()
      expect(observed.receipts).toMatchObject([{ promptTokens: 200, cachedTokens: 150 }])
    })
  }

  test("nested cached tokens take priority and missing or invalid counters stay absent", async () => {
    const observed = watch(Response.json(final({ prompt_tokens: 100, cached_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } })))
    await observed.response.text()
    expect(observed.receipts).toMatchObject([{ cachedTokens: 0 }])
    const missing = watch(Response.json(final({ prompt_tokens: "100", cached_tokens: "80", completion_tokens: -1, total_tokens: Number.MAX_SAFE_INTEGER + 1 })))
    await missing.response.text()
    expect(missing.receipts).toEqual([{ finishReason: "stop", assistant: { role: "assistant", content: "ok" } }])
  })

  test("accepts usage reported on a single choice", async () => {
    const source = event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40 } }] }) + "data: [DONE]\n\n"
    const observed = watch(stream([encoder.encode(source)]))
    await observed.response.text()
    expect(observed.receipts).toMatchObject([{ promptTokens: 100, cachedTokens: 40 }])
  })

  test("requires successful HTTP status, all final choices, DONE and clean EOF", async () => {
    const cases = [
      new Response(JSON.stringify(final()), { status: 429, statusText: "Rate Limited", headers: { "content-type": "application/json", "x-fixture": "kept" } }),
      stream([encoder.encode(event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }))]),
      stream([encoder.encode(event({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\n")]),
      stream([encoder.encode(event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }, { index: 1, delta: { content: "unfinished" }, finish_reason: null }], usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\n")]),
      stream([encoder.encode(event({ error: { message: "provider failure" }, usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\n")]),
      stream([encoder.encode("event: error\ndata: {}\n\n")]),
      stream([encoder.encode(event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\ndata: {\"truncated\":")]),
      new Response("{incomplete", { headers: { "content-type": "application/json" } }),
    ]
    for (const source of cases) {
      const { status, statusText } = source
      const observed = watch(source)
      expect(observed.response.status).toBe(status)
      expect(observed.response.statusText).toBe(statusText)
      if (status === 429) expect(observed.response.headers.get("x-fixture")).toBe("kept")
      await observed.response.text()
      expect(observed.receipts).toEqual([])
    }
  })

  test("cancellation propagates its reason and never records partial usage", async () => {
    const cancelled = Promise.withResolvers<unknown>()
    let sent = false
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(encoder.encode(event({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }], usage: { prompt_tokens: 100 } })))
        }
      },
      cancel(reason) { cancelled.resolve(reason) },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
    const observed = watch(upstream)
    const reader = observed.response.body!.getReader()
    await reader.read()
    const reason = new Error("consumer stopped")
    await reader.cancel(reason)
    expect(await cancelled.promise).toBe(reason)
    expect(observed.receipts).toEqual([])
  })

  test("abort interrupts a pending read and forwards cancellation to upstream", async () => {
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<unknown>()
    const signal = new AbortController()
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull() { started.resolve() },
      cancel(reason) { cancelled.resolve(reason) },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
    const observed = watch(upstream)
    const response = cancellableResponse(observed.response, signal.signal)
    if (!response.body) throw new Error("Missing response stream")
    const pending = response.body.getReader().read()
    await started.promise
    const reason = new Error("aborted")
    signal.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(await cancelled.promise).toBe(reason)
    expect(observed.receipts).toEqual([])
  })

  test("already-aborted signals cancel immediately, and stream errors remain errors", async () => {
    const cancelled = Promise.withResolvers<unknown>()
    const signal = new AbortController()
    const reason = new Error("already aborted")
    signal.abort(reason)
    const observed = watch(new Response(new ReadableStream({ cancel(value) { cancelled.resolve(value) } }), { headers: { "content-type": "text/event-stream" } }))
    await expect(cancellableResponse(observed.response, signal.signal).text()).rejects.toBe(reason)
    expect(await cancelled.promise).toBe(reason)
    expect(observed.receipts).toEqual([])
    const failure = new Error("upstream broke")
    const broken = watch(new Response(new ReadableStream({ pull(controller) { controller.error(failure) } }), { headers: { "content-type": "text/event-stream" } }))
    await expect(broken.response.text()).rejects.toBe(failure)
    expect(broken.receipts).toEqual([])
  })

  test("an error after final usage and DONE still cannot publish a receipt", async () => {
    const failure = new Error("connection failed after terminal event")
    let sent = false
    const source = event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\n"
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(failure)
        else { sent = true; controller.enqueue(encoder.encode(source)) }
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
    const observed = watch(upstream)
    await expect(observed.response.text()).rejects.toBe(failure)
    expect(observed.receipts).toEqual([])
  })

  test("abort during usage persistence rejects the reader before the write finishes", async () => {
    const entered = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    const saved = Promise.withResolvers<void>()
    const signal = new AbortController()
    const observed = observeResponse(Response.json(final()), async () => {
      entered.resolve()
      await commit.promise
      saved.resolve()
    })
    const pending = cancellableResponse(observed, signal.signal).text()
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(() => deadline.reject(new Error("Abort did not reach the pending reader")), 1000)
    const failure = new Error("request aborted during persistence")
    try {
      await entered.promise
      signal.abort(failure)
      await expect(Promise.race([pending, deadline.promise])).rejects.toBe(failure)
    } finally {
      clearTimeout(timer)
      commit.resolve()
      await saved.promise
      await pending.catch(() => {})
    }
  })
})

describe("response observation preserves wire data", () => {
  test("multiline SSE preserves CRLF, comments, IDs and data split across chunks", async () => {
    const prefix = ": comment\r\nid: 7\r\nevent: message\r\n"
    const frame = prefix + 'data: {"choices":[\r\ndata: {"index":0,"delta":{"reasoning":"think"},"finish_reason":null}]}\r\n\r\n'
    const source = frame + event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }, "\r\n") + "data: [DONE]\r\n\r\n"
    const observed = watch(stream([...encoder.encode(source)].map((byte) => new Uint8Array([byte]))))
    expect(await observed.response.text()).toBe(source)
    expect(observed.receipts).toMatchObject([{ promptTokens: 100 }])
  })

  test("JSON observation preserves the original status, headers and chunked body", async () => {
    const bodyText = ` \n ${JSON.stringify(final())} \t`
    const source = new Response(stream([encoder.encode(bodyText.slice(0, 5)), encoder.encode(bodyText.slice(5))]).body, {
      status: 201, statusText: "Created",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(bodyText)), "x-fixture": "kept" },
    })
    const observed = watch(source)
    expect(observed.response.status).toBe(201)
    expect(observed.response.statusText).toBe("Created")
    expect(observed.response.headers.get("content-length")).toBe(source.headers.get("content-length"))
    expect(observed.response.headers.get("x-fixture")).toBe("kept")
    expect(await observed.response.text()).toBe(bodyText)
    expect(observed.receipts).toMatchObject([{ promptTokens: 100 }])
  })
})
