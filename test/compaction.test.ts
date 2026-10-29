import { describe, expect, test } from "bun:test"
import { RollingCompaction, isCompactionSnapshot, type ChatBody, type CompactionContext, type CompactionResult } from "../src/compaction"
import { Environments, type WireMessage } from "../src/prefix"
import { UsageTracker } from "../src/usage"

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

function readOutput(size = 300) {
  return `<path>/project/file.ts</path>\n<type>file</type>\n<content>\n${Array.from({ length: 5 }, (_, index) => `${index + 1}: ${"x".repeat(size)}`).join("\n")}\n\n(End of file - total 5 lines)\n</content>`
}

function readBatch(id: string, content = readOutput(), args = JSON.stringify({ filePath: "/project/file.ts" })): WireMessage[] {
  return [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read", arguments: args } }] },
    { role: "tool", tool_call_id: id, content },
  ]
}

function repeatedReads(): ChatBody {
  const original = history(0)
  original.messages.splice(1, 0, { role: "user", content: "Inspect the file" }, ...readBatch("earlier"))
  original.messages.push(...readBatch("later"))
  return original
}

describe("staged pressure reductions", () => {
  test("removing tiny measured reasoning cannot masquerade as a large token reduction", async () => {
    const original: ChatBody = {
      model: "fixture", max_tokens: 1000, stream: true,
      messages: [
        { role: "system", content: "Policy" },
        { role: "user", content: "0123456789abcdef".repeat(1125) },
        { role: "assistant", content: "Earlier answer", reasoning_content: "x" },
        { role: "user", content: "Second question" },
      ],
    }
    const tracker = new UsageTracker()
    tracker.record(tracker.begin(original, "budget"), original, "budget", 8000)
    const current = { role: "user", content: "Continue" }
    const next = { ...original, messages: [...original.messages, { role: "assistant", content: "Done" }, current] }
    let calls = 0
    const result = await new RollingCompaction().prepare(next, {
      session: "budget", lane: "budget", contextWindow: 10000, outputLimit: 1000, currentUser: current,
      estimate: (candidate, fallback) => tracker.estimate(candidate, "budget", fallback),
      completeSummary: async () => { calls++; return success("Retained goals") },
    })
    expect(calls).toBeGreaterThan(0)
    expect(forwarded(result).messages).toContain(current)
    expect("report" in result && result.report?.compacted).toBe(true)
    expect(forwarded(result).messages.some((message) => message.content === original.messages[1]!.content)).toBe(false)
  })

  test("recovered reasoning in the current tool batch remains protected under pressure", async () => {
    const original = history()
    const currentUser = original.messages.at(-1)!
    const tools = batch(9, 50)
    original.messages.push(...tools)
    const reasoning = "recovered current reasoning ".repeat(15)
    const result = await new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async () => success(), {
      currentUser,
      restoreReasoning: (body) => ({ ...body, messages: body.messages.map((message) => message === tools[0] ? { ...message, reasoning_content: reasoning } : message) }),
    }))
    const outgoing = forwarded(result)
    expect(outgoing.messages.find((message) => message.tool_calls === tools[0]!.tool_calls)?.reasoning_content).toBe(reasoning)
    expect(outgoing.messages).toContain(currentUser)
    expect(bytes(outgoing)).toBeLessThanOrEqual("report" in result ? Number(result.report?.target) : 0)
  })

  test("plaintext reasoning is removed only from prior turns, before semantic inference", async () => {
    const original = history(1, 60)
    const prior = original.messages[2]!
    prior.reasoning_content = "historical thought ".repeat(500)
    prior.reasoning = "other historical thought"
    const signed: WireMessage = { role: "assistant", content: "signed", reasoning_content: "signed thought", signature: "signature" }
    const opaque: WireMessage = { role: "assistant", content: "opaque", reasoning: [{ type: "reasoning", signature: "opaque" }] }
    original.messages.splice(3, 0, signed, opaque)
    const current = original.messages.at(-1)!
    const assistant: WireMessage = { role: "assistant", content: "working", reasoning_content: "current thought" }
    original.messages.push(assistant, ...batch(0, 50))
    const copy = structuredClone(original)
    const result = await new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async () => { throw new Error("Unexpected summary") }, { currentUser: current }))
    const body = forwarded(result)
    expect(body.messages[2]!.reasoning_content).toBeUndefined()
    expect(body.messages[2]!.reasoning).toBeUndefined()
    expect(body.messages[2]!.content).toBe(prior.content)
    expect(body.messages).toContain(signed)
    expect(body.messages).toContain(opaque)
    expect(body.messages).toContain(current)
    expect(body.messages).toContain(assistant)
    expect(body.messages.slice(-3)).toEqual(original.messages.slice(-3))
    expect("report" in result && result.report?.reducedReasoning).toBe(1)
    expect("report" in result && result.report?.summaryRequests).toBe(0)
    expect(original).toEqual(copy)
  })

  test("reductions freeze below pressure and survive a validated snapshot restart", async () => {
    const original = history(1, 50)
    original.messages[2]!.reasoning_content = "r".repeat(6000)
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const first = forwarded(await compaction.prepare(original, context(async () => { throw new Error("Unexpected summary") })))
    const snapshot = compaction.snapshot("session")
    expect(isCompactionSnapshot(snapshot)).toBe(true)
    expect(snapshot.lanes[0]!.state.segments).toEqual([])
    const restored = new RollingCompaction({ bytesPerToken: 1 })
    expect(await restored.restore("session", snapshot)).toBe(true)
    const extension = { ...original, messages: [...original.messages, { role: "assistant", content: "Done", reasoning_content: "newly historical, not yet reduced" }, { role: "user", content: "Continue" }] }
    const next = forwarded(await restored.prepare(extension, context(async () => { throw new Error("Unexpected summary") }, { contextWindow: 50000 })))
    expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(next.messages.at(-2)!.reasoning_content).toBe("newly historical, not yet reduced")
    expect(next.messages.at(-1)).toBe(extension.messages.at(-1))
    const edited = structuredClone(original)
    edited.messages[2]!.reasoning_content = "edited, no longer under pressure"
    const invalidated = forwarded(await restored.prepare(edited, context(async () => { throw new Error("Unexpected summary") }, { contextWindow: 50000 })))
    expect(invalidated).toEqual(edited)
  })

  test("only identical complete successful read results can supersede an older result", async () => {
    const original = repeatedReads()
    const current = original.messages[4]!
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const result = await compaction.prepare(original, context(async () => { throw new Error("Unexpected summary") }, { currentUser: current }))
    const body = forwarded(result)
    expect(body.messages[3]!.tool_call_id).toBe("earlier")
    expect(body.messages[3]!.content).toContain("later")
    expect(body.messages[3]!.content).not.toBe(original.messages[3]!.content)
    expect(body.messages[2]).toBe(original.messages[2])
    expect(body.messages.slice(4)).toEqual(original.messages.slice(4))
    expect(body.messages[4]).toBe(current)
    expect("report" in result && result.report?.supersededReads).toBe(1)
    expect("report" in result && result.report?.summaryRequests).toBe(0)
    const restored = new RollingCompaction({ bytesPerToken: 1 })
    expect(await restored.restore("session", compaction.snapshot("session"))).toBe(true)
    expect(forwarded(await restored.prepare(original, context(async () => { throw new Error("Unexpected summary") }, { contextWindow: 50000 })))).toEqual(body)
    const changed = structuredClone(original)
    changed.messages[6]!.content = readOutput(250)
    expect(forwarded(await restored.prepare(changed, context(async () => { throw new Error("Unexpected summary") }, { contextWindow: 50000 })))).toEqual(changed)
  })

  test("reasoning reduction precedes duplicate reads and the combined checkpoint restarts exactly", async () => {
    const original = repeatedReads()
    original.messages.splice(2, 0, { role: "assistant", content: "Earlier plan", reasoning_content: "r".repeat(6000) })
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const result = await compaction.prepare(original, context(async () => { throw new Error("Unexpected summary") }))
    expect("report" in result && result.report?.reducedReasoning).toBe(1)
    expect("report" in result && result.report?.supersededReads).toBe(1)
    const restored = new RollingCompaction({ bytesPerToken: 1 })
    const snapshot = compaction.snapshot("session")
    expect(isCompactionSnapshot(snapshot)).toBe(true)
    expect(await restored.restore("session", snapshot)).toBe(true)
    const extended = { ...original, messages: [...original.messages, { role: "assistant", content: "Done" }, { role: "user", content: "Read it again" }, ...readBatch("newest")] }
    const next = forwarded(await restored.prepare(extended, context(async () => { throw new Error("Unexpected summary") }, { contextWindow: 50000 })))
    expect(next.messages.slice(0, original.messages.length)).toEqual(forwarded(result).messages)
    expect(next.messages.at(-1)).toBe(extended.messages.at(-1))
  })

  test("identical text without complete coverage, matching calls or prior-turn provenance is retained", async () => {
    const variants: ((body: ChatBody) => void)[] = [
      (body) => { body.messages[6]!.content = readOutput(299) },
      (body) => { (body.messages[5]!.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments = JSON.stringify({ filePath: "/project/other.ts" }) },
      (body) => { for (const index of [3, 6]) body.messages[index]!.content = "Error: Permission denied " + "x".repeat(1500) },
      (body) => { for (const index of [3, 6]) body.messages[index]!.content = readOutput().replace("(End of file - total 5 lines)", "(Showing lines 1-5 of 10. Use offset=6 to continue.)") },
      (body) => { for (const index of [3, 6]) body.messages[index]!.content = readOutput().replace("1: ", "2: ") },
      (body) => { for (const index of [3, 6]) body.messages[index]!.content = readOutput().replace("1: ", "1: ... (line truncated to 2000 chars)") },
      (body) => { for (const index of [3, 6]) body.messages[index]!.content = readOutput() + "\n\n<system-reminder>\nKeep this instruction\n</system-reminder>" },
    ]
    for (const change of variants) {
      const original = repeatedReads()
      change(original)
      let calls = 0
      const copy = structuredClone(original)
      await expect(new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async () => { calls++; throw new Error("Rejected reduction needs semantic folding") }, {
        currentUser: original.messages[4]!,
      }))).rejects.toThrow("needs semantic folding")
      expect(calls).toBe(1)
      expect(original).toEqual(copy)
    }
    const sameTurn = repeatedReads()
    sameTurn.messages.splice(4, 1)
    const result = await new RollingCompaction({ bytesPerToken: 1 }).prepare(sameTurn, context(async () => success(), { contextWindow: 50000 }))
    expect(forwarded(result)).toBe(sameTurn)
  })

  test("under-pressure-only reductions preserve current-turn thoughts and read batches", async () => {
    const original = repeatedReads()
    const current = original.messages[1]!
    original.messages[2]!.reasoning_content = "current thought ".repeat(500)
    const result = await new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async () => success(), { currentUser: current }))
    expect("report" in result && result.report?.reducedReasoning).toBe(0)
    expect("report" in result && result.report?.supersededReads).toBe(0)
    const small = history(1, 20)
    small.messages[2]!.reasoning_content = "not under pressure"
    expect(forwarded(await new RollingCompaction({ bytesPerToken: 1 }).prepare(small, context(async () => { throw new Error("Unexpected summary") })))).toBe(small)
  })

  test("snapshot validators reject malformed reductions and replay checks signed reasoning", async () => {
    const original = history(1, 50)
    original.messages[2]!.reasoning_content = "r".repeat(6000)
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    await compaction.prepare(original, context(async () => { throw new Error("Unexpected summary") }))
    for (const reductions of [
      [], [{ index: -1, kind: "reasoning" }], [{ index: 2, kind: "unknown" }],
      [{ index: 2, kind: "read", proof: 1 }], [{ index: 2, kind: "read", proof: 999 }],
      [{ index: 2, kind: "reasoning", proof: 3 }], [{ index: 2, kind: "reasoning" }, { index: 2, kind: "reasoning" }],
      [{ index: 0, kind: "read", proof: 1 }, { index: 1, kind: "read", proof: 2 }],
    ]) {
      const snapshot = compaction.snapshot("session")
      Object.assign(snapshot.lanes[0]!.state, { reductions })
      expect(isCompactionSnapshot(snapshot)).toBe(false)
    }
    const signed = structuredClone(original)
    signed.messages[2]!.signature = "signed"
    const restored = new RollingCompaction({ bytesPerToken: 1 })
    expect(await restored.restore("session", compaction.snapshot("session"))).toBe(true)
    expect(forwarded(await restored.prepare(signed, context(async () => { throw new Error("Unexpected summary") }, { contextWindow: 50000 })))).toEqual(signed)
    await expect(restored.prepare(original, context(async () => success(), { currentUser: structuredClone(original.messages.at(-1)!) }))).rejects.toThrow("exact current user")
  })
})

describe("prefix-sharing summary handoff", () => {
  function fixture() {
    const original = history(6, 220)
    delete original.response_format
    original.max_tokens = 4000
    original.cache_salt = "tenant"
    original.stream_options = { include_usage: true }
    original.messages[2]!.reasoning_content = "unreduced historical reasoning ".repeat(70)
    return original
  }

  function handoffContext(original: ChatBody, completeSummary: CompactionContext["completeSummary"], overrides: Partial<CompactionContext> = {}) {
    return context(completeSummary, { prefixHandoff: true, contextWindow: bytes(original) + 2500, outputLimit: 4000, currentUser: original.messages.at(-1), ...overrides })
  }

  test("handoff appends to the exact outgoing prefix with the same tools and system", async () => {
    const original = fixture()
    const copy = structuredClone(original)
    const requests: ChatBody[] = []
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    const result = await compaction.prepare(original, handoffContext(original, async (body) => { requests.push(body); return success("handoff-summary") }))
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.messages.slice(0, -1)).toEqual(original.messages)
    expect(request.messages[2]!.reasoning_content).toBe(original.messages[2]!.reasoning_content)
    expect(request.messages.at(-2)).toBe(original.messages.at(-1))
    expect(request.tools).toBe(original.tools)
    expect(request.messages[0]).toBe(original.messages[0])
    expect(request.messages.at(-1)!.role).toBe("user")
    expect(request.tool_choice).toBe("auto")
    expect(request.stream).toBe(false)
    expect(request.stream_options).toBeUndefined()
    expect(request.max_tokens).toBe(100)
    expect(request.cache_salt).toBe("tenant")
    expect(bytes(request)).toBeLessThanOrEqual(bytes(original) + 2500 - 100)
    const body = forwarded(result)
    expect(body.messages).toContain(original.messages.at(-1)!)
    expect("report" in result && result.report?.prefixHandoff).toBe(true)
    expect("report" in result && result.report?.summaryRequests).toBe(1)
    expect(bytes(body)).toBeLessThanOrEqual("report" in result ? result.report!.target as number : 0)
    expect(original).toEqual(copy)
    const restored = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    expect(await restored.restore("session", compaction.snapshot("session"))).toBe(true)
    expect(forwarded(await restored.prepare(original, handoffContext(original, async () => { throw new Error("Unexpected inference") })))).toEqual(body)
  })

  test("tool-free handoff omits tool_choice, which servers reject without tools", async () => {
    const original = fixture()
    delete original.tools
    const requests: ChatBody[] = []
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    const result = await compaction.prepare(original, handoffContext(original, async (body) => { requests.push(body); return success("handoff-summary") }))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.messages.slice(0, -1)).toEqual(original.messages)
    expect(requests[0]!.tools).toBeUndefined()
    expect(requests[0]!.tool_choice).toBeUndefined()
    expect("report" in result && result.report?.prefixHandoff).toBe(true)
  })

  test("handoff preserves the previous frozen effective prefix when extending a checkpoint", async () => {
    const original = fixture()
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    const first = forwarded(await compaction.prepare(original, handoffContext(original, async () => success("first-summary"))))
    const extension = history(6, 220, "extension").messages.slice(1)
    const extended = { ...original, messages: [...original.messages, ...extension] }
    const expectedPrefix = [...first.messages, ...extension]
    const effectiveSize = bytes({ ...extended, messages: expectedPrefix })
    const requests: ChatBody[] = []
    const result = await compaction.prepare(extended, handoffContext(extended, async (body) => { requests.push(body); return success("extended-summary") }, {
      contextWindow: effectiveSize + 2500,
    }))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.messages.slice(0, -1)).toEqual(expectedPrefix)
    expect(requests[0]!.tools).toBe(original.tools)
    expect(forwarded(result).messages).toContain(extended.messages.at(-1)!)
    expect("report" in result && result.report?.prefixHandoff).toBe(true)
  })

  test("oversized exact prefix falls back to bounded fragments without shortening a handoff", async () => {
    const original = history(8, 450)
    delete original.response_format
    const requests: ChatBody[] = []
    const result = await new RollingCompaction({ bytesPerToken: 1 }).prepare(original, context(async (body) => { requests.push(body); return success() }, { prefixHandoff: true }))
    expect(requests.length).toBeGreaterThan(1)
    for (const request of requests) {
      expect(request.messages).toHaveLength(2)
      expect(request.tools).toBeUndefined()
      expect(bytes(request)).toBeLessThanOrEqual(4500)
    }
    expect(archived(requests).length).toBeGreaterThan(0)
    expect("report" in result && result.report?.prefixHandoff).toBe(false)
  })

  test("handoff keeps measured prefix usage when stream controls invalidate the exact usage anchor", async () => {
    const original = fixture()
    const requests: ChatBody[] = []
    const limits = handoffContext(original, async (body) => { requests.push(body); return success("folded-summary") })
    const measured = limits.contextWindow
    const result = await new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 }).prepare(original, {
      ...limits,
      estimate: (body, fallback) => body === original ? measured : fallback(body),
    })
    expect("report" in result && result.report?.prefixHandoff).toBe(false)
    expect(requests.every((body) => body.tools === undefined && body.messages.length === 2)).toBe(true)
  })

  test("constrained tool choice and output modes use existing fragment folding", async () => {
    for (const constraint of [
      { tool_choice: "required" }, { tool_choice: "none" },
      { tool_choice: { type: "function", function: { name: "read" } } },
      { response_format: { type: "json_object" } }, { guided_json: { type: "object" } },
      { structured_outputs: { regex: "constrained" } }, { modalities: ["text", "audio"] },
    ]) {
      const original = { ...fixture(), ...constraint }
      const requests: ChatBody[] = []
      const result = await new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 }).prepare(original, handoffContext(original, async (body) => { requests.push(body); return success("folded-summary") }))
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) {
        expect(request.messages).toHaveLength(2)
        expect(request.tools).toBeUndefined()
        expect(request.tool_choice).toBeUndefined()
        expect(request.response_format).toBeUndefined()
      }
      expect(payload(requests[0]!).previous_summary).toBeNull()
      expect("report" in result && result.report?.prefixHandoff).toBe(false)
    }
  })

  test("handoff rejects non-stop, empty and tool-call responses without committing reductions", async () => {
    for (const invalid of [
      () => success("truncated", "length"),
      () => success(" "),
      () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "bad", tool_calls: [{ id: "call" }] } }] }),
      () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "bad", function_call: { name: "read" } } }] }),
    ]) {
      const original = fixture()
      const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
      let calls = 0
      await expect(compaction.prepare(original, handoffContext(original, async () => { calls++; return invalid() }))).rejects.toThrow("summary")
      expect(calls).toBe(1)
      expect(compaction.snapshot("session")).toEqual({ lanes: [] })
    }
  })

  test("handoff HTTP errors propagate untouched without a fragment retry or new state", async () => {
    const original = fixture()
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    const response = new Response("capacity exhausted", { status: 429, headers: { "retry-after": "7" } })
    let calls = 0
    const result = await compaction.prepare(original, handoffContext(original, async () => { calls++; return response }))
    expect(calls).toBe(1)
    expect("response" in result && result.response).toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(compaction.snapshot("session")).toEqual({ lanes: [] })
  })

  test("deleting an in-flight handoff cancels its returned body and prevents state resurrection", async () => {
    const original = fixture()
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Response>()
    const cancelled = Promise.withResolvers<unknown>()
    const pending = compaction.prepare(original, handoffContext(original, async () => { entered.resolve(); return release.promise })).catch((error: unknown) => error)
    await entered.promise
    compaction.delete("session")
    release.resolve(new Response(new ReadableStream({ cancel: cancelled.resolve })))
    expect(await pending).toBeInstanceOf(Error)
    expect(await cancelled.promise).toBeInstanceOf(Error)
    expect(compaction.snapshot("session")).toEqual({ lanes: [] })
  }, 5000)
})

describe("policy-local summary segments", () => {
  function fixture(size = 1600): ChatBody {
    const original = history(0)
    original.messages.splice(1, 0,
      { role: "user", content: "first-user:" + "a".repeat(size) },
      { role: "assistant", content: "first-answer:" + "b".repeat(size) },
      { role: "developer", content: "Policy for the second interval" },
      { role: "user", content: "second-user:" + "c".repeat(size) },
      { role: "assistant", content: "second-answer:" + "d".repeat(size) },
    )
    return original
  }

  test("pressure can archive history after later system and developer policies", async () => {
    for (const role of ["system", "developer"]) {
      const original = history(0)
      const policy = { role, content: "SessionHeads policy notice" }
      original.messages.splice(1, 0,
        { role: "user", content: "Small earlier question" },
        { role: "assistant", content: "Small earlier answer" },
        policy,
        ...history(4, 600, "later").messages.slice(1, -1),
      )
      const current = original.messages.at(-1)!
      const newest = batch(19, 20)
      original.messages.push(...newest)
      const requests: ChatBody[] = []
      const result = await new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 }).prepare(original, context(async (body) => {
        requests.push(body)
        return success("later-summary")
      }, { currentUser: current }))
      const body = forwarded(result)
      expect(archived(requests).every((entry) => entry.source_index > original.messages.indexOf(policy))).toBe(true)
      expect(body.messages).toContain(policy)
      expect(body.messages).toContain(current)
      for (const message of newest) expect(body.messages).toContain(message)
      expect(body.messages.indexOf(policy)).toBeLessThan(body.messages.findIndex((message) => !original.messages.includes(message)))
      expect(bytes(body)).toBeLessThanOrEqual("report" in result ? Number(result.report?.target) : 0)
    }
  })

  test("two intervals fold independently with one output reserve each", async () => {
    const original = fixture()
    const opaque: WireMessage = { role: "assistant", content: "opaque", signature: "signed" }
    original.messages.splice(2, 0, opaque)
    const policy = original.messages[4]!
    const requests: ChatBody[] = []
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    const result = await compaction.prepare(original, context(async (body) => {
      requests.push(body)
      return success(`independent-${requests.length}`)
    }))
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(payload(request).previous_summary).toBeNull()
      expect(payload(request).fragment_offset).toBe(0)
      expect(payload(request).total_length).toBe(payload(request).archived_text.length)
    }
    expect(archived([requests[0]!]).every((entry) => entry.source_index < original.messages.indexOf(policy))).toBe(true)
    expect(archived([requests[1]!]).every((entry) => entry.source_index > original.messages.indexOf(policy))).toBe(true)
    const snapshot = compaction.snapshot("session")
    const segments = snapshot.lanes[0]!.state.segments
    expect(segments.map((segment) => segment.summary)).toEqual(["independent-1", "independent-2"])
    const planning = forwarded(result)
    const wrappers = planning.messages.filter((message) => !original.messages.includes(message))
    expect(wrappers).toHaveLength(2)
    expect(planning.messages).toContain(opaque)
    expect(planning.messages).toContain(original.messages.at(-1)!)
    expect(planning.messages.indexOf(wrappers[0]!)).toBeLessThan(planning.messages.indexOf(policy))
    expect(planning.messages.indexOf(wrappers[1]!)).toBeGreaterThan(planning.messages.indexOf(policy))
    const reserved = { ...planning, messages: planning.messages.map((message) => wrappers.includes(message) ? { ...message, content: (message.content as string).slice(0, -(segments[wrappers.indexOf(message)]!.summary.length)) } : message) }
    expect(bytes(reserved) + 200).toBeLessThanOrEqual("report" in result ? Number(result.report?.target) : 0)
    expect(isCompactionSnapshot(snapshot)).toBe(true)
  })

  test("appended policy preserves frozen segments on restart and pure reconstruction", async () => {
    const original = fixture()
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    let calls = 0
    const first = forwarded(await compaction.prepare(original, context(async () => success(`frozen-${++calls}`))))
    const snapshot = compaction.snapshot("session")
    expect(snapshot.lanes[0]!.state.segments).toHaveLength(2)
    const restored = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    expect(await restored.restore("session", snapshot)).toBe(true)
    const policy = { role: "system", content: "Appended policy outside prior coverage" }
    const current = { role: "user", content: "Continue under the appended policy" }
    const extension = [policy, { role: "assistant", content: "Ready" }, current]
    const next = { ...original, messages: [...original.messages, ...extension] }
    const expected = { ...next, messages: [...first.messages, ...extension] }
    const replay = restored.reconstruct(next, { session: "session", lane: "provider/endpoint/build", currentUser: current })
    expect(replay).toEqual(expected)
    expect(replay.messages.at(-1)).toBe(current)
    expect(replay.messages).toContain(policy)
    expect(restored.snapshot("session")).toEqual(snapshot)
    const prepared = forwarded(await restored.prepare(next, context(async () => { throw new Error("Unexpected inference") }, { contextWindow: 50000, currentUser: current })))
    expect(prepared).toEqual(expected)
    expect(restored.snapshot("session")).toEqual(snapshot)
    const edited = structuredClone(next)
    edited.messages[3]!.content = "Edited covered policy"
    expect(restored.reconstruct(edited, { session: "session", lane: "provider/endpoint/build" })).toBe(edited)
    expect(restored.snapshot("session")).toEqual(snapshot)
  })

  test("tiny earlier intervals do not consume reserves needed by a later interval", async () => {
    const original = history(0)
    const small: WireMessage[] = []
    for (let index = 0; index < 10; index++) small.push(
      { role: "user", content: `tiny-${index}` },
      { role: "assistant", content: "ok" },
      { role: index % 2 ? "system" : "developer", content: `policy-${index}` },
    )
    original.messages.splice(1, 0, ...small, ...history(5, 800, "profitable").messages.slice(1, -1))
    const requests: ChatBody[] = []
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    const result = await compaction.prepare(original, context(async (body) => { requests.push(body); return success("profitable") }))
    expect(archived(requests).every((entry) => entry.source_index > small.length)).toBe(true)
    for (const message of small) expect(forwarded(result).messages).toContain(message)
    expect(compaction.snapshot("session").lanes[0]!.state.segments).toHaveLength(1)
    expect(bytes(forwarded(result))).toBeLessThanOrEqual("report" in result ? Number(result.report?.target) : 0)
  })

  test("handoffs share one frozen prefix and select only their own collapsed summary", async () => {
    const original = fixture()
    delete original.response_format
    original.max_tokens = 4000
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    const requests: ChatBody[] = []
    const first = forwarded(await compaction.prepare(original, context(async (body) => {
      requests.push(body)
      return success(`handoff-${requests.length}`)
    }, { prefixHandoff: true, outputLimit: 4000, contextWindow: bytes(original) + 2500 })))
    expect(requests).toHaveLength(2)
    for (const request of requests) expect(request.messages.slice(0, -1)).toEqual(original.messages)
    const snapshot = compaction.snapshot("session")
    expect(snapshot.lanes[0]!.state.segments).toHaveLength(2)
    const firstSelected = requests.map((request) => JSON.parse((request.messages.at(-1)!.content as string).match(/\[[0-9,]*\]/)![0]) as number[])
    expect(firstSelected[0]!.every((position) => position < 3)).toBe(true)
    expect(firstSelected[1]!.every((position) => position > 3)).toBe(true)

    const extension = [
      { role: "assistant", content: "extension:" + "e".repeat(2500) },
      { role: "user", content: "Continue" },
    ]
    const extended = { ...original, messages: [...original.messages, ...extension] }
    const expectedPrefix = [...first.messages, ...extension]
    const nextRequests: ChatBody[] = []
    const result = await compaction.prepare(extended, context(async (body) => {
      nextRequests.push(body)
      return success("updated-second")
    }, { prefixHandoff: true, outputLimit: 4000, contextWindow: bytes({ ...extended, messages: expectedPrefix }) + 2500 }))
    expect(nextRequests).toHaveLength(1)
    expect(nextRequests[0]!.messages.slice(0, -1)).toEqual(expectedPrefix)
    const nextSegments = compaction.snapshot("session").lanes[0]!.state.segments
    expect(nextSegments[0]).toEqual(snapshot.lanes[0]!.state.segments[0])
    expect(nextSegments[1]!.summary).toBe("updated-second")
    const oldSecond = new Set(snapshot.lanes[0]!.state.segments[1]!.archived)
    const additions = nextSegments[1]!.archived.filter((index) => !oldSecond.has(index))
    const expectedPositions = [3, ...additions.map((index) => expectedPrefix.indexOf(extended.messages[index]!))].sort((a, b) => a - b)
    expect(expectedPositions.every((position) => position >= 3)).toBe(true)
    const selected = JSON.parse((nextRequests[0]!.messages.at(-1)!.content as string).match(/\[[0-9,]*\]/)![0])
    expect(selected).toEqual(expectedPositions)
    expect(selected).not.toContain(1)
    expect("report" in result && result.report?.prefixHandoff).toBe(true)
  })

  test("second-interval failure leaves all committed segments and reductions intact", async () => {
    const original = fixture()
    original.messages[2]!.reasoning_content = "r".repeat(5000)
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    await compaction.prepare(original, context(async () => success("committed")))
    const snapshot = compaction.snapshot("session")
    expect(snapshot.lanes[0]!.state.reductions).toContainEqual({ index: 2, kind: "reasoning" })
    expect(snapshot.lanes[0]!.state.segments).toHaveLength(2)
    const extended = { ...original, messages: [
      ...original.messages,
      { role: "assistant", content: "New history in second interval " + "x".repeat(6500), reasoning_content: "new reasoning" },
      { role: "system", content: "Third interval" },
      { role: "user", content: "Third question " + "y".repeat(6500) },
      { role: "assistant", content: "Third answer " + "z".repeat(2000) },
      { role: "user", content: "Continue" },
    ] }
    const failure = new Response("second segment unavailable", { status: 429, headers: { "retry-after": "3" } })
    const requests: ChatBody[] = []
    let interval = 0
    const result = await compaction.prepare(extended, context(async (body) => {
      requests.push(body)
      if (payload(body).fragment_offset === 0) interval++
      return interval === 2 ? failure : success("uncommitted")
    }))
    expect(interval).toBe(2)
    expect("response" in result && result.response).toBe(failure)
    expect(failure.bodyUsed).toBe(false)
    expect(compaction.snapshot("session")).toEqual(snapshot)
    expect(payload(requests[0]!).previous_summary).toBe(snapshot.lanes[0]!.state.segments[1]!.summary)
    expect(payload(requests.at(-1)!).previous_summary).toBeNull()
  })

  test("snapshot shape rejects singleton, malformed, overlapping and interleaved archives", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    await compaction.prepare(fixture(), context(async () => success("valid")))
    const snapshot = compaction.snapshot("session")
    const old = { lanes: snapshot.lanes.map(({ key, state }) => {
      const { segments, ...metadata } = state
      return { key, state: { ...metadata, summary: "legacy", archived: segments.flatMap((segment) => segment.archived) } }
    }) }
    expect(isCompactionSnapshot(old)).toBe(false)
    for (const segments of [
      [{ summary: " ", archived: [1] }],
      [{ summary: "valid", archived: [] }],
      [{ summary: "valid", archived: [-1] }],
      [{ summary: "valid", archived: [1.5] }],
      [{ summary: "valid", archived: [1, 1] }],
      [{ summary: "valid", archived: [2, 1] }],
      [{ summary: "valid", archived: [1, 4] }, { summary: "other", archived: [2, 5] }],
      [{ summary: "valid", archived: [1, 2] }, { summary: "other", archived: [2, 4] }],
      [{ summary: "valid", archived: [1], extra: true }],
      [{ summary: "valid", archived: [snapshot.lanes[0]!.state.covered] }],
    ]) {
      const invalid = structuredClone(snapshot)
      Object.assign(invalid.lanes[0]!.state, { segments })
      expect(isCompactionSnapshot(invalid)).toBe(false)
      expect(await new RollingCompaction().restore("session", invalid)).toBe(false)
    }
  })

  test("replay rejects cross-policy, partial-batch and duplicate-interval segments", async () => {
    const original = fixture()
    original.messages.splice(2, 0, ...batch(31, 20))
    const compaction = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    await compaction.prepare(original, context(async () => success("valid")))
    const snapshot = compaction.snapshot("session")
    const covered = snapshot.lanes[0]!.state.covered
    for (const segments of [
      [{ summary: "cross-policy", archived: [1, covered - 1] }],
      [{ summary: "partial-batch", archived: [2] }, { summary: "later", archived: [covered - 1] }],
      [{ summary: "first", archived: [1] }, { summary: "same-interval", archived: [2, 3, 4] }, { summary: "later", archived: [covered - 1] }],
    ]) {
      const invalid = structuredClone(snapshot)
      Object.assign(invalid.lanes[0]!.state, { segments })
      expect(isCompactionSnapshot(invalid)).toBe(true)
      const restored = new RollingCompaction({ bytesPerToken: 1 })
      expect(await restored.restore("session", invalid)).toBe(true)
      expect(restored.reconstruct(original, { session: "session", lane: "provider/endpoint/build" })).toBe(original)
      expect(forwarded(await restored.prepare(original, context(async () => { throw new Error("Unexpected inference") }, { contextWindow: 50000 })))).toBe(original)
    }
  })

  test("read supersession and replay proofs cannot cross a policy boundary", async () => {
    const original = repeatedReads()
    original.messages.splice(4, 0, { role: "developer", content: "New read policy" })
    const requests: ChatBody[] = []
    const result = await new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 }).prepare(original, context(async (body) => {
      requests.push(body)
      return success("read-summary")
    }, { currentUser: original.messages[5]! }))
    expect("report" in result && result.report?.supersededReads).toBe(0)
    expect(archived(requests).find((entry) => entry.source_index === 3)!.message.content).toBe(original.messages[3]!.content)
    expect(forwarded(result).messages.at(-1)).toBe(original.messages.at(-1))
    const sameInterval = repeatedReads()
    const reductions = new RollingCompaction({ bytesPerToken: 1 })
    await reductions.prepare(sameInterval, context(async () => { throw new Error("Unexpected inference") }, { currentUser: sameInterval.messages[4]! }))
    expect(reductions.snapshot("session").lanes[0]!.state.reductions).toContainEqual({ index: 3, kind: "read", proof: 6 })
    const forged = repeatedReads()
    forged.messages.splice(4, 0, { role: "developer", content: "New read policy" })
    forged.messages[2]!.reasoning_content = "r".repeat(6000)
    forged.messages.push({ role: "user", content: "Continue" })
    const committed = new RollingCompaction({ bytesPerToken: 1, summaryOutputTokens: 100 })
    await committed.prepare(forged, context(async () => success("valid")))
    const snapshot = committed.snapshot("session")
    snapshot.lanes[0]!.state.reductions = [{ index: 3, kind: "read", proof: 7 }]
    expect(isCompactionSnapshot(snapshot)).toBe(true)
    const restored = new RollingCompaction({ bytesPerToken: 1 })
    expect(await restored.restore("session", snapshot)).toBe(true)
    expect(restored.reconstruct(forged, { session: "session", lane: "provider/endpoint/build" })).toBe(forged)
  })
})

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
