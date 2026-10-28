import { describe, expect, test } from "bun:test"
import { RollingCompaction, type ChatBody, type CompactionContext, type CompactionResult } from "../src/compaction"
import { Environments, type WireMessage } from "../src/prefix"

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

function history(turns = 8, size = 450, tag = "history"): ChatBody {
  const messages: WireMessage[] = [{ role: "system", content: "Fixture system constraints" }]
  for (let index = 0; index < turns; index++) {
    messages.push({ role: "user", content: `${tag}-user-${index}:` + "u".repeat(size) })
    messages.push({ role: "assistant", content: `${tag}-assistant-${index}:` + "a".repeat(size) })
  }
  messages.push({ role: "user", content: `${tag}-current-instruction` })
  return {
    model: "fixture-model",
    messages,
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
    response_format: { type: "json_object" },
    max_tokens: 500,
    stream: true,
  }
}

function success(content = "fixture-semantic-summary", finish_reason = "stop"): Response {
  return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason }] })
}

function context(completeSummary: CompactionContext["completeSummary"], overrides: Partial<CompactionContext> = {}): CompactionContext {
  return { session: "session", lane: "provider/endpoint/build", contextWindow: 5000, outputLimit: 500, completeSummary, ...overrides }
}

function forwarded(result: CompactionResult): ChatBody {
  if ("response" in result) throw new Error(`Unexpected upstream status ${result.response.status}`)
  return result.body
}

function payload(body: ChatBody): { previous_summary: string | null; archived_text: string; fragment_offset: number; total_length: number } {
  return JSON.parse(body.messages[1]!.content as string)
}

function archived(requests: ChatBody[]): { source_index: number; message: WireMessage }[] {
  return requests.map((request) => payload(request).archived_text).join("").split("\n").map((line) => JSON.parse(line))
}

function batch(index: number, size = 350): WireMessage[] {
  return [
    { role: "assistant", content: null, tool_calls: [
      { id: `call-${index}-a`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `a-${index}` }) } },
      { id: `call-${index}-b`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `b-${index}` }) } },
    ] },
    { role: "tool", tool_call_id: `call-${index}-b`, content: "b".repeat(size) },
    { role: "tool", tool_call_id: `call-${index}-a`, content: "a".repeat(size) },
  ]
}

describe("rolling semantic compaction", () => {
  test("tool-generated user-role media cannot replace real current-user provenance", async () => {
    const original = history(0)
    const current = original.messages[1]!
    current.content = "CURRENT_USER_CONSTRAINT " + "must retain ".repeat(70)
    for (let index = 0; index < 8; index++) original.messages.push(...batch(index))
    const media: WireMessage = { role: "user", content: [
      { type: "text", text: "Attached media from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } },
    ] }
    original.messages.push(media)
    const result = forwarded(await new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async () => success(), { currentUser: current, contextWindow: 6500 })))
    expect(result.messages).toContainEqual(current)
    expect(result.messages).toContainEqual(media)
    for (const message of batch(7)) expect(result.messages).toContainEqual(message)
  })

  test("trailing assistant step limits cannot make the newest tool batch disposable", async () => {
    const original = history(0)
    const current = original.messages[1]!
    original.messages.push(...batch(0, 3000), { role: "assistant", content: "No further tool calls; give the final response." })
    const copy = structuredClone(original)
    let calls = 0
    await expect(new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async () => { calls++; return success() }, { currentUser: current }))).rejects.toThrow("mandatory")
    expect(calls).toBe(0)
    expect(original).toEqual(copy)
  })

  test("generated environment does not displace the current user or newest tool group", async () => {
    const original = history(0)
    original.messages[0]!.content = "You are powered by the model named fixture. The exact model ID is proxy/fixture\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: /project\n  Workspace root folder: /project\n  Is directory a git repo: yes\n  Platform: linux\n  Today's date: DAY\n</env>"
    const current = original.messages[1]!
    for (let index = 0; index < 8; index++) original.messages.push(...batch(index))
    const newest = original.messages.slice(-3)
    new Environments().apply(original.messages, "session", "lane")
    const environment = original.messages.at(-1)!
    const result = forwarded(await new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async () => success())))
    expect(result.messages).toContainEqual(current)
    expect(result.messages).toContainEqual(environment)
    for (const message of newest) expect(result.messages).toContainEqual(message)
  })

  test("plain historical thinking can compact but generation cap changes reuse the summary", async () => {
    const original = history()
    for (const message of original.messages) {
      if (message.role === "assistant") message.reasoning_content = "historical thought"
    }
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const first = forwarded(await compaction.prepare(original, context(async () => success())))
    let calls = 0
    const next = forwarded(await compaction.prepare({ ...original, max_tokens: 400, temperature: 0.4 }, context(async () => { calls++; return success("unexpected") }, { outputLimit: 400 })))
    expect(calls).toBe(0)
    expect(next.messages).toEqual(first.messages)
  })

  test("preflight triggers below the limit and includes the newest tool result", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const original = history(4, 350)
    const baseSize = bytes(original)
    original.messages.push(...batch(0, 900))
    const requests: ChatBody[] = []
    const finalSize = bytes(original)
    const ctx = context(async (body) => { requests.push(body); return success() }, { contextWindow: Math.ceil(finalSize / 0.9) + 500 })
    const result = await compaction.prepare(original, ctx)
    if ("response" in result) throw new Error("Unexpected summary failure")
    expect(baseSize).toBeLessThan(result.report!.trigger as number)
    expect(finalSize).toBeGreaterThan(result.report!.trigger as number)
    expect(finalSize).toBeLessThan(result.report!.budget as number)
    expect(result.report!.compacted).toBe(true)
    expect(requests.length).toBeGreaterThan(0)
    expect(result.body.messages.slice(-3)).toEqual(original.messages.slice(-3))
    expect(result.body.messages).toContainEqual(original.messages.findLast((message) => message.role === "user")!)
    expect(bytes(result.body)).toBeLessThanOrEqual(result.report!.target as number)
  })

  test("summary bytes stay frozen between compactions while sent history shrinks", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const original = history()
    const copy = structuredClone(original)
    let calls = 0
    const ctx = context(async () => success(`summary-${++calls}`))
    const first = forwarded(await compaction.prepare(original, ctx))
    const firstCalls = calls
    const next = { ...original, messages: [...original.messages, { role: "assistant", content: "Done" }, { role: "user", content: "Continue" }] }
    const second = forwarded(await compaction.prepare(next, ctx))
    expect(calls).toBe(firstCalls)
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(bytes(first)).toBeLessThan(bytes(original))
    expect(original).toEqual(copy)
    expect(second.tools).toEqual(original.tools)
    expect(second.response_format).toEqual(original.response_format)
    expect(second.messages[0]).toEqual(original.messages[0])
  })

  test("subsequent compaction folds only newly uncovered source messages", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const original = history()
    const firstRequests: ChatBody[] = []
    let sequence = 0
    const first = forwarded(await compaction.prepare(original, context(async (body) => { firstRequests.push(body); return success(`summary-${++sequence}`) })))
    const firstIndices = new Set(archived(firstRequests).map((entry) => entry.source_index))
    const extension = history(8, 450, "new").messages.slice(1)
    const extended = { ...original, messages: [...original.messages, ...extension] }
    const nextRequests: ChatBody[] = []
    const next = forwarded(await compaction.prepare(extended, context(async (body) => { nextRequests.push(body); return success(`summary-${++sequence}`) })))
    const entries = archived(nextRequests)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((entry) => !firstIndices.has(entry.source_index))).toBe(true)
    expect(payload(nextRequests[0]!).previous_summary).toBe(`summary-${firstRequests.length}`)
    expect(next.messages).toContainEqual(extended.messages.at(-1)!)
    expect(first.messages).not.toEqual(next.messages)
  })

  test("long current tool loops split only at complete parallel batches and pin the instruction", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const original = history(0)
    const current = structuredClone(original.messages.at(-1)!)
    for (let index = 0; index < 8; index++) original.messages.push(...batch(index))
    const copy = structuredClone(original)
    const requests: ChatBody[] = []
    const result = forwarded(await compaction.prepare(original, context(async (body) => { requests.push(body); return success() })))
    expect(result.messages).toContainEqual(current)
    expect(result.messages.slice(-3)).toEqual(original.messages.slice(-3))
    for (let index = 0; index < 8; index++) {
      const group = batch(index)
      const remaining = result.messages.filter((message) => message.tool_call_id === `call-${index}-a` || message.tool_call_id === `call-${index}-b` || (Array.isArray(message.tool_calls) && message.tool_calls.some((call: { id: string }) => call.id === `call-${index}-a`)))
      expect([0, group.length]).toContain(remaining.length)
      if (remaining.length) expect(remaining).toEqual(group)
    }
    expect(archived(requests).some((entry) => entry.message.role === "tool")).toBe(true)
    for (const request of requests) {
      expect(request.messages.every((message) => message.tool_calls === undefined && message.role !== "tool")).toBe(true)
      expect(request.tools).toBeUndefined()
      expect(request.response_format).toBeUndefined()
      expect(request.stream).toBe(false)
    }
    expect(original).toEqual(copy)
  })

  test("oversized archived text folds through independently budgeted summarizer windows", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1, marginTokens: 100 })
    const original = history(1, 14000)
    original.messages[1]!.content = "다국어🙂".repeat(3500)
    const requests: ChatBody[] = []
    const ctx = context(async (body) => { requests.push(body); return success(`fold-${requests.length}`) }, { inputLimit: 4300 })
    const result = await compaction.prepare(original, ctx)
    expect(requests.length).toBeGreaterThan(2)
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index]!
      const cap = request.max_tokens as number
      expect(cap).toBeLessThanOrEqual(ctx.outputLimit)
      expect(bytes(request)).toBeLessThanOrEqual(Math.min(ctx.inputLimit!, ctx.contextWindow - cap) - 100)
      expect(payload(request).previous_summary).toBe(index ? `fold-${index}` : null)
      if (index) expect(payload(request).fragment_offset).toBe(payload(requests[index - 1]!).fragment_offset + payload(requests[index - 1]!).archived_text.length)
    }
    const entries = archived(requests)
    expect(entries.map((entry) => entry.message)).toEqual(original.messages.slice(1, 3))
    expect(bytes(forwarded(result))).toBeLessThan(3000)
  })

  test("giant mandatory latest input fails before inference instead of truncating", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const original = history(2)
    original.messages.at(-1)!.content = "must-keep".repeat(1500)
    const copy = structuredClone(original)
    let calls = 0
    await expect(compaction.prepare(original, context(async () => { calls++; return success() }))).rejects.toThrow("mandatory current user instruction")
    expect(calls).toBe(0)
    expect(original).toEqual(copy)
  })

  test("summary generation preserves tenant/template settings and removes main output constraints", async () => {
    const original = {
      ...history(),
      cache_salt: "tenant-isolation",
      user: "tenant-user",
      chat_template_kwargs: { enable_thinking: false },
      stream_options: { include_usage: true },
      max_completion_tokens: 500,
      tool_choice: "required",
      stop: ["main-stop"],
      stop_token_ids: [123],
      min_tokens: 400,
      n: 2,
      logit_bias: { "123": -100 },
      structured_outputs: { regex: "main-only" },
      truncate_prompt_tokens: 100,
    }
    const requests: ChatBody[] = []
    const result = forwarded(await new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async (body) => { requests.push(body); return success() })))
    for (const request of requests) {
      expect(request.cache_salt).toBe(original.cache_salt)
      expect(request.user).toBe(original.user)
      expect(request.chat_template_kwargs).toEqual(original.chat_template_kwargs)
      expect(request.max_completion_tokens).toBeGreaterThan(0)
      expect(request.max_completion_tokens as number).toBeLessThanOrEqual(500)
      for (const key of ["tools", "tool_choice", "response_format", "stream_options", "max_tokens", "stop", "stop_token_ids", "min_tokens", "n", "logit_bias", "structured_outputs", "truncate_prompt_tokens"]) expect(request[key]).toBeUndefined()
    }
    for (const [key, value] of Object.entries(original)) if (key !== "messages") expect(result[key]).toEqual(value)
  })

  test("default summary reserve derives from the actual output cap and recovery headroom", async () => {
    const original = { ...history(), max_tokens: 2000 }
    const requests: ChatBody[] = []
    const result = await new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async (body) => { requests.push(body); return success() }, { outputLimit: 2000 }))
    if ("response" in result) throw new Error("Unexpected summary failure")
    const reserve = Math.min(2000, (result.report!.trigger as number) - (result.report!.target as number))
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) expect(request.max_tokens).toBe(reserve)
    expect(bytes(result.body)).toBeLessThanOrEqual(result.report!.target as number)
  })

  test("fixed system and tool schemas that cannot fit fail without inference", async () => {
    for (const field of ["system", "tools"]) {
      const original = history()
      if (field === "system") original.messages[0]!.content = "p".repeat(10000)
      else original.tools = [{ type: "function", function: { name: "read", description: "d".repeat(10000), parameters: { type: "object" } } }]
      let calls = 0
      await expect(new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async () => { calls++; return success() }))).rejects.toThrow("fixed system/tools/format")
      expect(calls).toBe(0)
    }
  })

  test("opaque media and signed reasoning remain exact, or fail if mandatory context is too large", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const original = history()
    const media: WireMessage = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }] }
    const signed: WireMessage = { role: "assistant", content: "opaque", reasoning_content: "signed-state", signature: "fixture" }
    original.messages.splice(3, 0, media, signed)
    const result = forwarded(await compaction.prepare(original, context(async () => success())))
    expect(result.messages).toContainEqual(media)
    expect(result.messages).toContainEqual(signed)
    const giant = history()
    giant.messages.splice(3, 0, { ...signed, reasoning_content: "s".repeat(10000) })
    await expect(compaction.prepare(giant, context(async () => { throw new Error("Unexpected inference") }, { session: "giant" }))).rejects.toThrow("opaque/multimodal")
  })

  test("changed covered prefixes and shortened history invalidate earlier summaries", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const original = history()
    await compaction.prepare(original, context(async () => success("stale-summary")))
    const edited = structuredClone(original)
    edited.messages[1]!.content = "edited-user" + "e".repeat(450)
    const requests: ChatBody[] = []
    await compaction.prepare(edited, context(async (body) => { requests.push(body); return success("new-summary") }))
    expect(payload(requests[0]!).previous_summary).toBeNull()
    expect(archived(requests).find((entry) => entry.source_index === 1)!.message).toEqual(edited.messages[1])
    const short = { ...original, messages: [original.messages[0]!, { role: "user", content: "Replacement" }] }
    expect(forwarded(await compaction.prepare(short, context(async () => { throw new Error("Unexpected inference") })))).toEqual(short)
    const after: ChatBody[] = []
    await compaction.prepare(original, context(async (body) => { after.push(body); return success() }))
    expect(payload(after[0]!).previous_summary).toBeNull()
  })

  test("model, provider/agent lane, system, tool and output schemas separate summary reuse", async () => {
    for (const changed of [
      (body: ChatBody) => { body.model = "other-model" },
      (body: ChatBody) => { body.messages[0]!.content = "Other system policy" },
      (body: ChatBody) => { body.tools = [{ type: "function", function: { name: "write", parameters: { type: "object" } } }] },
      (body: ChatBody) => { body.response_format = { type: "json_schema", json_schema: { name: "result", schema: { type: "object" } } } },
    ]) {
      const compaction = new RollingCompaction({ bytesPerToken: 1 })
      const original = history()
      await compaction.prepare(original, context(async () => success("prior-lane-summary")))
      const updated = structuredClone(original)
      changed(updated)
      const requests: ChatBody[] = []
      const result = forwarded(await compaction.prepare(updated, context(async (body) => { requests.push(body); return success() })))
      expect(payload(requests[0]!).previous_summary).toBeNull()
      expect(result.model).toBe(updated.model)
      expect(result.tools).toEqual(updated.tools)
      expect(result.response_format).toEqual(updated.response_format)
    }
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    await compaction.prepare(history(), context(async () => success("build-summary")))
    const requests: ChatBody[] = []
    await compaction.prepare(history(), context(async (body) => { requests.push(body); return success() }, { lane: "other-provider/endpoint/plan" }))
    expect(payload(requests[0]!).previous_summary).toBeNull()
  })

  test("non-OK summary responses pass through untouched without committing partial folds", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const original = history(1, 9000)
    const failure = new Response("provider-capacity-error", { status: 429, headers: { "retry-after": "9" } })
    let calls = 0
    const result = await compaction.prepare(original, context(async () => ++calls === 1 ? success("partial") : failure))
    expect(calls).toBe(2)
    expect("response" in result && result.response).toBe(failure)
    expect(failure.bodyUsed).toBe(false)
    expect(await failure.text()).toBe("provider-capacity-error")
    const requests: ChatBody[] = []
    await compaction.prepare(original, context(async (body) => { requests.push(body); return success() }))
    expect(payload(requests[0]!).previous_summary).toBeNull()
  })

  test("truncated, malformed, empty and tool-calling summaries never commit partial state", async () => {
    const invalid = [
      () => success("unfinished", "length"),
      () => new Response("{\"choices\":"),
      () => success("  "),
      () => Response.json({ choices: [{ message: { role: "assistant", content: "x", tool_calls: [{ id: "unexpected" }] }, finish_reason: "stop" }] }),
      () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{\"choices\":")); controller.error(new Error("interrupted stream")) } })),
    ]
    for (const response of invalid) {
      const compaction = new RollingCompaction({ bytesPerToken: 1 })
      let calls = 0
      const original = history(1, 9000)
      await expect(compaction.prepare(original, context(async () => ++calls === 1 ? success("partial") : response()))).rejects.toThrow("summary")
      const requests: ChatBody[] = []
      await compaction.prepare(original, context(async (body) => { requests.push(body); return success() }))
      expect(payload(requests[0]!).previous_summary).toBeNull()
    }
  })

  test("failed extension leaves an already committed frozen summary intact", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const original = history()
    const first = forwarded(await compaction.prepare(original, context(async () => success("committed-summary"))))
    const extended = { ...original, messages: [...original.messages, ...history(1, 9000, "extension").messages.slice(1)] }
    let calls = 0
    const failure = new Response("unavailable", { status: 503 })
    const result = await compaction.prepare(extended, context(async () => ++calls === 1 ? success("uncommitted-fold") : failure))
    expect("response" in result && result.response).toBe(failure)
    expect(calls).toBe(2)
    const reused = forwarded(await compaction.prepare(original, context(async () => { throw new Error("Unexpected inference") })))
    expect(reused).toEqual(first)
  })

  test("a summary exceeding the configured reserve is rejected without state", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 20 })
    const original = history()
    await expect(compaction.prepare(original, context(async () => success("s".repeat(100))))).rejects.toThrow("output reserve")
    const requests: ChatBody[] = []
    await compaction.prepare(original, context(async (body) => { requests.push(body); return success("short") }))
    expect(payload(requests[0]!).previous_summary).toBeNull()
    expect(requests[0]!.max_tokens).toBe(20)
  })

  test("abort during summary body consumption cancels the body and leaves no state", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const abort = new AbortController()
    const reading = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<unknown>()
    const original = history()
    const pending = compaction.prepare(original, context(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { reading.resolve() },
      cancel: cancelled.resolve,
    }, { highWaterMark: 0 })), { signal: abort.signal }))
    const rejection = pending.catch((error: unknown) => error)
    await reading.promise
    const reason = new Error("cancel-summary")
    abort.abort(reason)
    expect(await rejection).toBe(reason)
    expect(await cancelled.promise).toBe(reason)
    const requests: ChatBody[] = []
    await compaction.prepare(original, context(async (body) => { requests.push(body); return success() }))
    expect(payload(requests[0]!).previous_summary).toBeNull()
  }, 5000)

  test("same-lane requests serialize and reuse the completed summary", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Response>()
    const original = history()
    let firstCalls = 0
    const first = compaction.prepare(original, context(async () => {
      if (++firstCalls === 1) { entered.resolve(); return release.promise }
      return success()
    }))
    await entered.promise
    let secondCalls = 0
    const second = compaction.prepare(original, context(async () => { secondCalls++; return success("concurrent") }))
    release.resolve(success())
    const [a, b] = await Promise.all([first, second])
    expect(secondCalls).toBe(0)
    expect(forwarded(b)).toEqual(forwarded(a))
  }, 5000)

  test("queued cancellation never enters the summarizer", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Response>()
    let calls = 0
    const first = compaction.prepare(history(), context(async () => {
      if (++calls === 1) { entered.resolve(); return release.promise }
      return success()
    }))
    await entered.promise
    const abort = new AbortController()
    let queuedCalls = 0
    const queued = compaction.prepare(history(), context(async () => { queuedCalls++; return success() }, { signal: abort.signal })).catch((error: unknown) => error)
    const reason = new Error("cancel-queued")
    abort.abort(reason)
    expect(await queued).toBe(reason)
    release.resolve(success())
    await first
    expect(queuedCalls).toBe(0)
  }, 5000)

  test("siblings sharing a lane neither block each other nor share summaries", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Response>()
    let firstCalls = 0
    const first = compaction.prepare(history(8, 450, "sibling-a"), context(async () => {
      if (++firstCalls === 1) { entered.resolve(); return release.promise }
      return success("summary-a")
    }, { session: "sibling-a" }))
    await entered.promise
    const requests: ChatBody[] = []
    const second = forwarded(await compaction.prepare(history(8, 450, "sibling-b"), context(async (body) => { requests.push(body); return success("summary-b") }, { session: "sibling-b" })))
    expect(payload(requests[0]!).previous_summary).toBeNull()
    expect(archived(requests).every((entry) => !JSON.stringify(entry.message).includes("sibling-a"))).toBe(true)
    expect(JSON.stringify(second)).not.toContain("summary-a")
    release.resolve(success("summary-a"))
    expect(JSON.stringify(forwarded(await first))).not.toContain("summary-b")
  }, 5000)

  test("clear and session deletion prevent in-flight state resurrection", async () => {
    for (const clear of [(compaction: RollingCompaction) => compaction.clear(), (compaction: RollingCompaction) => compaction.delete("session")]) {
      const compaction = new RollingCompaction({ bytesPerToken: 1 })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<Response>()
      const pending = compaction.prepare(history(8, 450, "old"), context(async () => { entered.resolve(); return release.promise })).catch((error: unknown) => error)
      await entered.promise
      clear(compaction)
      const fresh = history(8, 450, "fresh")
      const current = forwarded(await compaction.prepare(fresh, context(async () => success("fresh-summary"))))
      release.resolve(success("stale-summary"))
      expect(await pending).toBeInstanceOf(Error)
      let unexpected = 0
      const reused = forwarded(await compaction.prepare(fresh, context(async () => { unexpected++; return success("unexpected") })))
      expect(unexpected).toBe(0)
      expect(reused).toEqual(current)
    }
  }, 5000)

  test("malformed tool boundaries are never summarized or repaired", async () => {
    for (const extra of [
      [{ role: "tool", tool_call_id: "orphan", content: "x" }],
      batch(1).slice(0, 2),
      [batch(1)[0]!, batch(1)[1]!, batch(1)[1]!],
    ] as WireMessage[][]) {
      const original = history()
      original.messages.push(...extra)
      const copy = structuredClone(original)
      const compaction = new RollingCompaction({ bytesPerToken: 1 })
      await expect(compaction.prepare(original, context(async () => { throw new Error("Unexpected inference") }))).rejects.toThrow("tool")
      expect(original).toEqual(copy)
    }
  })

  test("disabled mode is unchanged and summary-disabled lanes perform budget checks only", async () => {
    const original = history()
    const never = context(async () => { throw new Error("Unexpected inference") }, { contextWindow: 1, outputLimit: 1 })
    expect(forwarded(await new RollingCompaction(false).prepare(original, never))).toBe(original)
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    await expect(compaction.prepare(original, { ...never, contextWindow: 5000, outputLimit: 500, allowSummary: false })).rejects.toThrow("Summary-disabled")
    const small = history(0)
    expect(forwarded(await compaction.prepare(small, { ...never, contextWindow: 5000, outputLimit: 500, allowSummary: false }))).toBe(small)
  })

  test("option and actual-limit validation never guesses missing model budgets", async () => {
    for (const input of [true, null, { unknown: 1 }, { bytesPerToken: 0 }, { triggerRatio: 1 }, { targetRatio: "0.8" }, { summaryOutputTokens: 0 }, { keepRecentTurns: 0 }, { marginTokens: -1 }, { marginTokens: Infinity }]) {
      expect(() => new RollingCompaction(input)).toThrow("compaction")
    }
    const compaction = new RollingCompaction()
    for (const limits of [{ contextWindow: 0 }, { outputLimit: NaN }, { inputLimit: -1 }]) {
      await expect(compaction.prepare(history(0), context(async () => { throw new Error("Unexpected inference") }, limits))).rejects.toThrow("actual positive integer")
    }
  })
})
