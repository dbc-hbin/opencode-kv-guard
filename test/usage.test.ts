import { describe, expect, test } from "bun:test"
import type { ChatBody } from "../src/compaction"
import { observeResponse, UsageTracker, type ObserveResponseOptions, type UsageReport } from "../src/usage"

const encoder = new TextEncoder()
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
function watch(response: Response, options: Omit<ObserveResponseOptions, "onReport">) {
  const report = Promise.withResolvers<UsageReport>()
  return { response: observeResponse(response, { ...options, onReport: report.resolve }), report: report.promise }
}
async function anchor(tracker: UsageTracker, prompt = body(), key = lane, tokens = 100) {
  const observed = watch(Response.json(final({ prompt_tokens: tokens })), { body: prompt, lane: key, tracker })
  await observed.response.text()
  expect((await observed.report).anchorRecorded).toBe(true)
}

describe("provider usage anchors", () => {
  test("uses raw prompt tokens once, plus only the estimated appended message delta", async () => {
    const tracker = new UsageTracker()
    const prompt = body()
    const observed = watch(Response.json(final({ prompt_tokens: 1_000, completion_tokens: 20, total_tokens: 1_020, prompt_tokens_details: { cached_tokens: 800 } })), { body: prompt, lane, tracker })
    await observed.response.text()
    expect(await observed.report).toMatchObject({ promptTokens: 1_000, cachedTokens: 800, completionTokens: 20, totalTokens: 1_020, anchorRecorded: true })
    expect(tracker.estimate(prompt, lane, fallback)).toBe(1_000)
    const appended = body([{ role: "assistant", content: "Answer" }, { role: "user", content: "Next" }])
    expect(tracker.estimate(appended, lane, fallback)).toBe(1_000 + fallback(appended) - fallback(prompt))
    const tools = body([
      { role: "assistant", content: null, reasoning_content: "reason", tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call", content: [{ type: "text", text: "result" }] },
    ])
    expect(tracker.estimate(tools, lane, fallback)).toBe(1_000 + fallback(tools) - fallback(prompt))
  })

  test("requires exact model, template, tools, nonmessage policy, history, tenant and lane", async () => {
    const tracker = new UsageTracker()
    const prompt = body()
    await anchor(tracker, prompt)
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

  test("does not infer changed policy overhead or appended media and signed fields", async () => {
    const tracker = new UsageTracker()
    await anchor(tracker)
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

  test("newer dispatch wins even if the older response reaches headers last", async () => {
    const tracker = new UsageTracker()
    const first = body()
    const next = body([{ role: "assistant", content: "Answer" }, { role: "user", content: "Next" }])
    const olderRequest = tracker.begin(first, lane)
    const newerRequest = tracker.begin(next, lane)
    const newer = watch(Response.json(final({ prompt_tokens: 200 })), { body: next, lane, tracker, request: newerRequest })
    await newer.response.text()
    expect((await newer.report).anchorRecorded).toBe(true)
    const older = watch(Response.json(final({ prompt_tokens: 50 })), { body: first, lane, tracker, request: olderRequest })
    await older.response.text()
    expect((await older.report).anchorRecorded).toBe(false)
    expect(tracker.estimate(next, lane, fallback)).toBe(200)
    expect(tracker.estimate(first, lane, fallback)).toBe(fallback(first))
  })

  test("history replacement invalidates the prior anchor even if the replacement fails", async () => {
    const tracker = new UsageTracker()
    await anchor(tracker)
    const edited = body()
    edited.messages[1]!.content = "Replacement"
    const request = tracker.begin(edited, lane)
    const observed = watch(new Response("failure", { status: 503 }), { body: edited, lane, tracker, request })
    expect(await observed.response.text()).toBe("failure")
    expect((await observed.report).anchorRecorded).toBe(false)
    expect(tracker.estimate(body(), lane, fallback)).toBe(fallback(body()))
  })

  test("delete and clear invalidate in-flight tickets without affecting other lanes", async () => {
    const tracker = new UsageTracker()
    await anchor(tracker, body(), "other", 300)
    const request = tracker.begin(body(), lane)
    tracker.delete(lane)
    const observed = watch(Response.json(final()), { body: body(), lane, tracker, request })
    await observed.response.text()
    expect((await observed.report).anchorRecorded).toBe(false)
    expect(tracker.estimate(body(), "other", fallback)).toBe(300)
    const clearing = tracker.begin(body(), "other")
    tracker.clear()
    const afterClear = watch(Response.json(final()), { body: body(), lane: "other", tracker, request: clearing })
    await afterClear.response.text()
    expect((await afterClear.report).anchorRecorded).toBe(false)
    expect(tracker.estimate(body(), "other", fallback)).toBe(fallback(body()))
  })

  test("mismatched body or lane cannot commit another request's tokens", async () => {
    const tracker = new UsageTracker()
    const prompt = body()
    const request = tracker.begin(prompt, lane)
    const wrong = watch(Response.json(final()), { body: prompt, lane: "different", tracker, request })
    await wrong.response.text()
    expect((await wrong.report).anchorRecorded).toBe(false)
    const changedRequest = tracker.begin(prompt, lane)
    prompt.messages[1]!.content = "Mutated after dispatch"
    const changed = watch(Response.json(final()), { body: prompt, lane, tracker, request: changedRequest })
    await changed.response.text()
    expect((await changed.report).anchorRecorded).toBe(false)
  })
})

describe("streaming usage observation", () => {
  test("preserves exact SSE bytes across every byte boundary and drains usage after DONE", async () => {
    const source = ": ping\r\nid: 1\r\n" + event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }, "\r\n") + event({ choices: [{ index: 0, delta: { content: "한😀" }, finish_reason: null }] }, "\r\n") + event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "\r\n") + "data: [DONE]\r\n\r\n" + event({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 9, total_tokens: 330, prompt_tokens_details: { cached_tokens: 250 } } }, "\r\n")
    const bytes = encoder.encode(source)
    const chunks = [...bytes].map((byte) => new Uint8Array([byte]))
    const tracker = new UsageTracker()
    const observed = watch(stream(chunks), { body: body(), lane, tracker, label: "main" })
    expect(new Uint8Array(await observed.response.arrayBuffer())).toEqual(bytes)
    const report = await observed.report
    expect(report).toMatchObject({ label: "main", format: "sse", outcome: "complete", status: 200, promptTokens: 321, completionTokens: 9, totalTokens: 330, cachedTokens: 250, anchorRecorded: true })
    expect(report.firstOutputMs).toBeGreaterThanOrEqual(report.headerMs)
    expect(report.endMs).toBeGreaterThanOrEqual(report.firstOutputMs!)
    expect(report.laneFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(report)).not.toContain("Policy")
    expect(tracker.estimate(body(), lane, fallback)).toBe(321)
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
    const observed = watch(upstream, { body: body(), lane, tracker: new UsageTracker() })
    expect(pulls).toBe(0)
    const reader = observed.response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(chunks[0])
    expect(pulls).toBe(1)
    for (let index = 1; index < chunks.length; index++) expect(new TextDecoder().decode((await reader.read()).value)).toBe(chunks[index])
    expect((await reader.read()).done).toBe(true)
    expect((await observed.report).promptTokens).toBe(400)
  })

  test("metadata-only chunks do not count as first generated output", async () => {
    const source = event({ choices: [{ index: 0, delta: { role: "assistant", content: "", tool_calls: [{ index: 0 }] }, finish_reason: null }] }) + event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0 } }) + "data: [DONE]\n\n"
    const observed = watch(stream([encoder.encode(source)]), { body: body(), lane, tracker: new UsageTracker(), label: "summary" })
    await observed.response.text()
    const report = await observed.report
    expect(report).toMatchObject({ label: "summary", promptTokens: 0, anchorRecorded: true, outcome: "complete" })
    expect(report).not.toHaveProperty("firstOutputMs")
  })

  for (const delta of [{ content: "text" }, { reasoning_content: "reason" }, { reasoning: "reason" }, { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "read", arguments: "" } }] }]) {
    test(`recognizes actual output ${JSON.stringify(delta)}`, async () => {
      const source = event({ choices: [{ index: 0, delta, finish_reason: null }] }) + event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n"
      const observed = watch(stream([encoder.encode(source)]), { body: body(), lane, tracker: new UsageTracker() })
      await observed.response.text()
      expect((await observed.report).firstOutputMs).toBeGreaterThanOrEqual(0)
    })
  }

  for (const alias of ["cached_tokens", "prompt_cache_hit_tokens", "cachedContentTokenCount", "cache_read_input_tokens", "cache_hit_tokens"]) {
    test(`accepts numeric ${alias} without adding it to raw prompt_tokens`, async () => {
      const tracker = new UsageTracker()
      const source = event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 200, [alias]: 150 } }) + event({ choices: [], usage: { prompt_tokens: 200, [alias]: 150 } }) + "data: [DONE]\n\n"
      const observed = watch(stream([encoder.encode(source)]), { body: body(), lane, tracker })
      await observed.response.text()
      expect(await observed.report).toMatchObject({ promptTokens: 200, cachedTokens: 150, anchorRecorded: true })
      expect(tracker.estimate(body(), lane, fallback)).toBe(200)
    })
  }

  test("nested cached tokens take priority and missing or invalid counters stay absent", async () => {
    const observed = watch(Response.json(final({ prompt_tokens: 100, cached_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } })), { body: body(), lane, tracker: new UsageTracker() })
    await observed.response.text()
    expect((await observed.report).cachedTokens).toBe(0)
    const missing = watch(Response.json(final({ prompt_tokens: "100", cached_tokens: "80", completion_tokens: -1, total_tokens: Number.MAX_SAFE_INTEGER + 1 })), { body: body(), lane, tracker: new UsageTracker() })
    await missing.response.text()
    const report = await missing.report
    for (const key of ["promptTokens", "completionTokens", "totalTokens", "cachedTokens"]) expect(report).not.toHaveProperty(key)
    expect(report.anchorRecorded).toBe(false)
  })

  test("accepts single-choice usage and refuses an inconsistent cached count as an anchor", async () => {
    const source = event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40 } }] }) + "data: [DONE]\n\n"
    const observed = watch(stream([encoder.encode(source)]), { body: body(), lane, tracker: new UsageTracker() })
    await observed.response.text()
    expect(await observed.report).toMatchObject({ promptTokens: 100, cachedTokens: 40, anchorRecorded: true })
    const inconsistent = watch(Response.json(final({ prompt_tokens: 100, cached_tokens: 101 })), { body: body(), lane, tracker: new UsageTracker() })
    await inconsistent.response.text()
    expect(await inconsistent.report).toMatchObject({ outcome: "complete", promptTokens: 100, cachedTokens: 101, anchorRecorded: false })
  })

  test("requires successful HTTP status, all final choices, DONE and clean EOF", async () => {
    const tracker = new UsageTracker()
    const cases = [
      { response: new Response(JSON.stringify(final()), { status: 429, statusText: "Rate Limited", headers: { "content-type": "application/json", "x-fixture": "kept" } }), outcome: "error" },
      { response: stream([encoder.encode(event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }))]), outcome: "incomplete" },
      { response: stream([encoder.encode(event({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\n")]), outcome: "incomplete" },
      { response: stream([encoder.encode(event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }, { index: 1, delta: { content: "unfinished" }, finish_reason: null }], usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\n")]), outcome: "incomplete" },
      { response: stream([encoder.encode(event({ error: { message: "provider failure" }, usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\n")]), outcome: "error" },
      { response: stream([encoder.encode("event: error\ndata: {}\n\n")]), outcome: "error" },
      { response: stream([encoder.encode(event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\ndata: {\"truncated\":" )]), outcome: "error" },
      { response: new Response("{incomplete", { headers: { "content-type": "application/json" } }), outcome: "error" },
    ]
    for (const entry of cases) {
      const status = entry.response.status
      const statusText = entry.response.statusText
      const observed = watch(entry.response, { body: body(), lane, tracker })
      expect(observed.response.status).toBe(status)
      expect(observed.response.statusText).toBe(statusText)
      if (status === 429) expect(observed.response.headers.get("x-fixture")).toBe("kept")
      await observed.response.text()
      expect(await observed.report).toMatchObject({ outcome: entry.outcome, anchorRecorded: false })
      expect(tracker.estimate(body(), lane, fallback)).toBe(fallback(body()))
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
    const tracker = new UsageTracker()
    const observed = watch(upstream, { body: body(), lane, tracker })
    const reader = observed.response.body!.getReader()
    await reader.read()
    const reason = new Error("consumer stopped")
    await reader.cancel(reason)
    expect(await cancelled.promise).toBe(reason)
    expect(await observed.report).toMatchObject({ outcome: "cancelled", anchorRecorded: false })
    expect(tracker.estimate(body(), lane, fallback)).toBe(fallback(body()))
  })

  test("abort interrupts a pending read and forwards cancellation to upstream", async () => {
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<unknown>()
    const signal = new AbortController()
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull() { started.resolve() },
      cancel(reason) { cancelled.resolve(reason) },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
    const observed = watch(upstream, { body: body(), lane, tracker: new UsageTracker(), signal: signal.signal })
    const pending = observed.response.body!.getReader().read()
    await started.promise
    const reason = new Error("aborted")
    signal.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(await cancelled.promise).toBe(reason)
    expect(await observed.report).toMatchObject({ outcome: "aborted", anchorRecorded: false })
  })

  test("already-aborted signals cancel immediately, and stream errors remain errors", async () => {
    const cancelled = Promise.withResolvers<unknown>()
    const signal = new AbortController()
    const reason = new Error("already aborted")
    signal.abort(reason)
    const observed = watch(new Response(new ReadableStream({ cancel(value) { cancelled.resolve(value) } })), { body: body(), lane, tracker: new UsageTracker(), signal: signal.signal })
    await expect(observed.response.text()).rejects.toBe(reason)
    expect(await cancelled.promise).toBe(reason)
    expect((await observed.report).outcome).toBe("aborted")
    const failure = new Error("upstream broke")
    const broken = watch(new Response(new ReadableStream({ pull(controller) { controller.error(failure) } }), { headers: { "content-type": "text/event-stream" } }), { body: body(), lane, tracker: new UsageTracker() })
    await expect(broken.response.text()).rejects.toBe(failure)
    expect(await broken.report).toMatchObject({ outcome: "error", anchorRecorded: false })
  })

  test("an error after final usage and DONE still cannot create an anchor", async () => {
    const failure = new Error("connection failed after terminal event")
    let sent = false
    const tracker = new UsageTracker()
    const source = event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }) + "data: [DONE]\n\n"
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(failure)
        else { sent = true; controller.enqueue(encoder.encode(source)) }
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
    const observed = watch(upstream, { body: body(), lane, tracker })
    await expect(observed.response.text()).rejects.toBe(failure)
    expect(await observed.report).toMatchObject({ promptTokens: 100, outcome: "error", anchorRecorded: false })
    expect(tracker.estimate(body(), lane, fallback)).toBe(fallback(body()))
  })

  test("diagnostic throws, rejections and unresolved logging do not hold response EOF", async () => {
    const logged = Promise.withResolvers<void>()
    for (const onReport of [() => { throw new Error("logging failed") }, () => Promise.reject(new Error("logging rejected")), () => { logged.resolve(); return new Promise<void>(() => {}) }]) {
      const observed = observeResponse(Response.json(final()), { body: body(), lane, tracker: new UsageTracker(), onReport })
      expect(await observed.json()).toEqual(final())
    }
    await logged.promise
  })
})

describe("response event normalization", () => {
  test("identity and equal transforms preserve exact SSE/JSON bytes", async () => {
    const source = ": keep\r\nid: 9\r\ndata:  { \"choices\" : [{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}], \"usage\": {\"prompt_tokens\":100} }\r\n\r\ndata: [DONE]\r\n\r\n"
    const json = ` \n ${JSON.stringify(final())} \t`
    for (const transform of [(value: unknown) => value, (value: unknown) => structuredClone(value), (value: unknown) => Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse())]) {
      const observed = watch(stream([...encoder.encode(source)].map((byte) => new Uint8Array([byte]))), { body: body(), lane, tracker: new UsageTracker(), transform })
      expect(await observed.response.text()).toBe(source)
      expect((await observed.report).anchorRecorded).toBe(true)
      const document = watch(stream([encoder.encode(json.slice(0, 5)), encoder.encode(json.slice(5))], { "content-type": "application/json" }), { body: body(), lane, tracker: new UsageTracker(), transform })
      expect(await document.response.text()).toBe(json)
      expect((await document.report).anchorRecorded).toBe(true)
    }
  })

  test("rewrites only changed event JSON and preserves comment/id/event/data framing", async () => {
    const original = { choices: [{ index: 0, delta: { reasoning: "think" }, finish_reason: null }] }
    const normalized = { choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] }
    const prefix = ": comment\r\nid: 7\r\nevent: message\r\n"
    const frame = prefix + 'data: {"choices":[\r\ndata: {"index":0,"delta":{"reasoning":"think"},"finish_reason":null}]}\r\n\r\n'
    const unchanged = event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }, "\r\n") + "data: [DONE]\r\n\r\n"
    let events = 0
    const observed = watch(stream([...encoder.encode(frame + unchanged)].map((byte) => new Uint8Array([byte]))), {
      body: body(), lane, tracker: new UsageTracker(), transform(value) {
        events++
        return JSON.stringify(value) === JSON.stringify(original) ? normalized : value
      },
    })
    expect(await observed.response.text()).toBe(prefix + `data: ${JSON.stringify(normalized)}\r\ndata: \r\n\r\n` + unchanged)
    expect(events).toBe(2)
    expect(await observed.report).toMatchObject({ promptTokens: 100, anchorRecorded: true })
  })

  test("detects in-place JSON changes and observes usage before normalization", async () => {
    const observed = watch(new Response(JSON.stringify(final()), { status: 201, statusText: "Created", headers: { "content-type": "application/json", "content-length": "1", "x-fixture": "kept" } }), {
      body: body(), lane, tracker: new UsageTracker(), transform(value) {
        const document = value as Final
        document.choices[0]!.message.content = "normalized"
        document.usage.prompt_tokens = 999
        return document
      },
    })
    expect(observed.response.status).toBe(201)
    expect(observed.response.statusText).toBe("Created")
    expect(observed.response.headers.get("content-length")).toBeNull()
    expect(observed.response.headers.get("x-fixture")).toBe("kept")
    expect((await observed.response.json() as Final).choices[0]!.message.content).toBe("normalized")
    expect(await observed.report).toMatchObject({ promptTokens: 100, anchorRecorded: true })
  })

  test("transform failures cancel upstream and remain visible to consumers", async () => {
    const cancelled = Promise.withResolvers<unknown>()
    const failure = new Error("normalizer failed")
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(encoder.encode(event({ choices: [{ index: 0, delta: { content: "text" }, finish_reason: null }] }))) },
      cancel(reason) { cancelled.resolve(reason) },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
    const observed = watch(upstream, { body: body(), lane, tracker: new UsageTracker(), transform() { throw failure } })
    await expect(observed.response.text()).rejects.toBe(failure)
    expect(await cancelled.promise).toBe(failure)
    expect(await observed.report).toMatchObject({ outcome: "error", anchorRecorded: false })
  })
})
