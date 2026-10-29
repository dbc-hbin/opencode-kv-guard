import { describe, expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createGLMChunkAdapter, normalizeGLMRequest, parseGLMOptions, type GLMOptions } from "../src/glm"
import type { ChatBody } from "../src/compaction"

const profile: GLMOptions = { models: ["deployment-exact"], reasoningEffort: "max", clearThinking: false, cumulativeReasoning: false }
type Chunk = { id: string; model: string; created: number; choices: { index: number; delta: Record<string, unknown>; finish_reason: null }[] }

function body(extra: Record<string, unknown> = {}): ChatBody {
  return { model: "deployment-exact", messages: [{ role: "user", content: "task" }], ...extra }
}

function chunk(delta: Record<string, unknown>, index = 0): Chunk {
  return { id: "response", model: "deployment-exact", created: 1, choices: [{ index, delta, finish_reason: null }] }
}

describe("GLM profile selection and request policy", () => {
  test("requires opt-in exact models and validates only the named options", () => {
    expect(parseGLMOptions(undefined)).toBe(false)
    expect(parseGLMOptions(false)).toBe(false)
    expect(parseGLMOptions({ models: ["deployment-exact"] })).toEqual(profile)
    expect(parseGLMOptions({ models: ["deployment-exact"], reasoningEffort: "low", clearThinking: true, cumulativeReasoning: true })).toEqual({ ...profile, reasoningEffort: "low", clearThinking: true, cumulativeReasoning: true })
    for (const input of [true, null, {}, { models: [] }, { models: [""] }, { models: [" padded "] }, { models: [1] }, { models: ["deployment-exact"], reasoningEffort: "medium" }, { models: ["deployment-exact"], clearThinking: "false" }, { models: ["deployment-exact"], cumulativeReasoning: 1 }, { models: ["deployment-exact"], detectURL: true }]) {
      expect(() => parseGLMOptions(input)).toThrow()
    }
  })

  test("does not infer a family, case variant, model prefix or endpoint", () => {
    for (const model of ["GLM-5.3-NVFP4", "deployment-exact-extra", "Deployment-exact", "nvidia/GLM-5.3-NVFP4"]) {
      const input = body({ model, baseURL: "https://api.example/glm" })
      expect(normalizeGLMRequest(input, profile)).toMatchObject({ body: input, report: { targeted: false, changes: [] } })
      expect(normalizeGLMRequest(input, profile).body).toBe(input)
      expect(createGLMChunkAdapter(model, profile)(chunk({ reasoning_text: "unchanged" }))).toHaveProperty("choices.0.delta.reasoning_text", "unchanged")
    }
    const input = body()
    expect(normalizeGLMRequest(input, false).body).toBe(input)
  })

  test("adds missing max effort and false template clearing without touching history", () => {
    const historical = { role: "assistant", content: "answer", reasoning_content: "reasoning\nwith exact whitespace  ", tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }] }
    const signed = { role: "assistant", content: [{ type: "reasoning", signature: "opaque", text: "do not flatten" }] }
    const input = body({ messages: [historical, signed, { role: "tool", tool_call_id: "call", content: "result" }, { role: "user", content: "next" }] })
    const original = JSON.stringify(input)
    const result = normalizeGLMRequest(input, profile)
    expect(result.body).toMatchObject({ reasoning_effort: "max", chat_template_kwargs: { clear_thinking: false } })
    expect(result.report).toMatchObject({ targeted: true, reasoningEffort: "max", clearThinking: false, effortSource: "profile", clearThinkingSource: "profile", cumulativeReasoning: false })
    expect(result.body.messages).toBe(input.messages)
    expect(result.body.messages[0]).toBe(historical)
    expect(result.body.messages[1]).toBe(signed)
    expect(JSON.stringify(input)).toBe(original)
  })

  test("explicit top-level and nested settings beat profile defaults", () => {
    for (const extra of [
      { reasoning_effort: "low", clear_thinking: true },
      { chat_template_kwargs: { reasoning_effort: "high", clear_thinking: true, other: "keep" } },
    ]) {
      const input = body(extra)
      const result = normalizeGLMRequest(input, profile)
      expect(result.body).toBe(input)
      expect(result.report).toMatchObject({ effortSource: "request", clearThinkingSource: "request", clearThinking: true, changes: [] })
      expect(result.report.reasoningEffort).toBe("reasoning_effort" in extra ? "low" : "high")
    }
  })

  test("canonicalizes camelCase controls and template containers without flattening", () => {
    const input = body({ reasoningEffort: "low", chatTemplateKwargs: { clearThinking: true, untouched: { nested: "value" } } })
    const result = normalizeGLMRequest(input, profile)
    expect(result.body.reasoning_effort).toBe("low")
    expect(result.body.reasoningEffort).toBeUndefined()
    expect(result.body.chatTemplateKwargs).toBeUndefined()
    expect(result.body.chat_template_kwargs).toEqual({ clear_thinking: true, untouched: { nested: "value" } })
    expect(result.report.changes).toContain("chatTemplateKwargs->chat_template_kwargs")
    const nested = normalizeGLMRequest(body({ chat_template_kwargs: { reasoningEffort: "high", clearThinking: false } }), profile)
    expect(nested.body.chat_template_kwargs).toEqual({ reasoning_effort: "high", clear_thinking: false })
    expect(nested.body.reasoning_effort).toBeUndefined()
  })

  test("reports conflicting spellings without selecting or overwriting them", () => {
    const input = body({ reasoning_effort: "low", reasoningEffort: "max", clear_thinking: false, chat_template_kwargs: { reasoning_effort: "high", clearThinking: true } })
    const result = normalizeGLMRequest(input, profile)
    expect(result.body).toBe(input)
    expect(result.report).toMatchObject({ effortSource: "conflict", clearThinkingSource: "conflict", changes: [] })
    expect(result.report.reasoningEffort).toBeUndefined()
    expect(result.report.clearThinking).toBeUndefined()
    expect(result.report.conflicts).toContain("reasoningEffort")
    expect(result.report.conflicts).toContain("chat_template_kwargs.clearThinking")
  })

  test("dual and opaque template containers fail closed and diagnostics contain no request text", () => {
    for (const extra of [
      { chat_template_kwargs: { reasoning_effort: "low" }, chatTemplateKwargs: { clearThinking: true } },
      { chatTemplateKwargs: "PRIVATE_TEMPLATE_CONTENT" },
      { reasoning_effort: "PRIVATE_EFFORT_CONTENT", clear_thinking: false },
    ]) {
      const input = body(extra)
      const result = normalizeGLMRequest(input, profile)
      expect(result.body).toBe(input)
      expect(result.report.conflicts.length).toBeGreaterThan(0)
      expect(JSON.stringify(result.report)).not.toContain("PRIVATE_")
      expect(JSON.stringify(result.report)).not.toContain("task")
    }
  })
})

describe("GLM parsed-response adapter", () => {
  test("moves reasoning_text only when neither supported nonempty alias exists", () => {
    const adapt = createGLMChunkAdapter("deployment-exact", profile)
    const input = chunk({ reasoning_text: " exact\nreasoning  ", content: null })
    expect(adapt(input)).toMatchObject({ choices: [{ delta: { reasoning_content: " exact\nreasoning  ", content: null } }] })
    expect((adapt(input) as Chunk).choices[0]!.delta.reasoning_text).toBeUndefined()
    expect(input.choices[0]!.delta.reasoning_text).toBe(" exact\nreasoning  ")
    for (const delta of [
      { reasoning: "native", reasoning_text: "other" },
      { reasoning_content: "", reasoning: "", reasoning_text: "" },
    ]) {
      const native = chunk(delta)
      expect(adapt(native)).toBe(native)
    }
    // A mirrored copy would make the recorded response look like conflicting reasoning.
    expect((adapt(chunk({ reasoning_content: "native", reasoning_text: "native" })) as Chunk).choices[0]!.delta).toEqual({ reasoning_content: "native" })
  })

  test("repairs SDK empty-primary masking without adding a mirrored fallback", () => {
    const adapt = createGLMChunkAdapter("deployment-exact", profile)
    const input = chunk({ reasoning_content: "", reasoning: "fallback", reasoning_text: "fallback" })
    const result = adapt(input) as Chunk
    expect(result.choices[0]!.delta).toEqual({ reasoning: "fallback" })
    const textOnly = adapt(chunk({ reasoning_content: null, reasoning: "", reasoning_text: "text-only" })) as Chunk
    expect(textOnly.choices[0]!.delta.reasoning_content).toBe("text-only")
    expect(textOnly.choices[0]!.delta.reasoning_text).toBeUndefined()
    expect(textOnly.choices[0]!.delta.reasoning).toBeUndefined()
  })

  test("non-target, signed, opaque, multipart and non-assistant data remain exact", () => {
    const adapt = createGLMChunkAdapter("deployment-exact", profile)
    for (const delta of [
      { reasoning_text: "mirror", thinking_blocks: [{ type: "thinking", signature: "signed", thinking: "mirror" }] },
      { reasoning_text: "mirror", provider_specific_fields: { thinking_blocks: [{ signature: "signed" }] } },
      { reasoning_text: "mirror", reasoning: { signature: "opaque", blob: "bytes" } },
      { reasoning_text: "mirror", content: [{ type: "reasoning", signature: "signed" }] },
      { reasoning_text: "mirror", role: "tool" },
    ]) {
      const input = chunk(delta)
      expect(adapt(input)).toBe(input)
    }
    const input = chunk({ reasoning_text: "not-target" })
    expect(createGLMChunkAdapter("another-model", profile)(input)).toBe(input)
    expect(createGLMChunkAdapter("deployment-exact", false)(input)).toBe(input)
    for (const value of [null, "[DONE]", { usage: { prompt_tokens: 1 } }, { error: { message: "failure" } }]) expect(adapt(value)).toBe(value)
  })

  test("normal streaming deltas are not guessed to be cumulative", () => {
    const adapt = createGLMChunkAdapter("deployment-exact", profile)
    const first = chunk({ reasoning_content: "a" })
    const second = chunk({ reasoning_content: "ab" })
    expect(adapt(first)).toBe(first)
    expect(adapt(second)).toBe(second)
  })

  test("explicit cumulative snapshots are per response and per choice", () => {
    const options = { ...profile, cumulativeReasoning: true }
    const adapt = createGLMChunkAdapter("deployment-exact", options)
    adapt({ choices: [{ index: 0, delta: { reasoning_content: "a" } }, { index: 1, delta: { reasoning_text: "x" } }] })
    expect(adapt({ choices: [{ index: 1, delta: { reasoning_text: "xy" } }, { index: 0, delta: { reasoning_content: "ab", reasoning: "ab", reasoning_text: "ab" } }] })).toEqual({ choices: [{ index: 1, delta: { reasoning_content: "y" } }, { index: 0, delta: { reasoning_content: "b" } }] })
    expect(adapt(chunk({ reasoning_content: "ab" }))).toMatchObject({ choices: [{ delta: { reasoning_content: "" } }] })
    expect(createGLMChunkAdapter("deployment-exact", options)(chunk({ reasoning_content: "ab" }))).toMatchObject({ choices: [{ delta: { reasoning_content: "ab" } }] })
  })

  test("cumulative mode rejects non-append-only snapshots and ambiguous indices", () => {
    const options = { ...profile, cumulativeReasoning: true }
    const adapt = createGLMChunkAdapter("deployment-exact", options)
    adapt(chunk({ reasoning_content: "previous" }))
    expect(() => adapt(chunk({ reasoning_content: "replacement" }))).toThrow("append-only")
    expect(() => createGLMChunkAdapter("deployment-exact", options)({ choices: [{ delta: { reasoning_text: "a" } }, { delta: { reasoning_text: "b" } }] })).toThrow("choice index")
    expect(() => createGLMChunkAdapter("deployment-exact", options)({ choices: [{ index: 0, delta: { reasoning_text: "a" } }, { index: 0, delta: { reasoning_text: "ab" } }] })).toThrow("unique choice indices")
  })

  test("cumulative supported fallback remains visible behind an empty primary", () => {
    const adapt = createGLMChunkAdapter("deployment-exact", { ...profile, cumulativeReasoning: true })
    adapt(chunk({ reasoning_content: "", reasoning: "a" }))
    expect(adapt(chunk({ reasoning_content: "", reasoning: "ab", reasoning_text: "ab" }))).toMatchObject({ choices: [{ delta: { reasoning: "b" } }] })
    expect((adapt(chunk({ reasoning_content: "", reasoning: "ab" })) as Chunk).choices[0]!.delta).toEqual({ reasoning: "" })
  })

  test("the pinned compatible SDK captures fallback reasoning and replays plaintext", async () => {
    const captured: ChatBody[] = []
    const adapt = createGLMChunkAdapter("deployment-exact", profile)
    const provider = createOpenAICompatible({
      name: "fixture", baseURL: "http://127.0.0.1:1/v1",
      fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const wire = await new Request(input, init).json() as ChatBody
        captured.push(normalizeGLMRequest(wire, profile).body)
        return Response.json(adapt({ id: "response", model: "deployment-exact", created: 1, choices: [{ index: 0, message: { role: "assistant", content: "answer", reasoning_text: "new reasoning" }, finish_reason: "stop" }] }))
      }, { preconnect: globalThis.fetch.preconnect }),
    })
    const result = await provider.chatModel("deployment-exact").doGenerate({ prompt: [
      { role: "assistant", content: [{ type: "reasoning", text: "historical\nreasoning  " }, { type: "text", text: "previous" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] })
    expect(result.content.filter((part) => part.type === "reasoning")).toEqual([{ type: "reasoning", text: "new reasoning" }])
    expect(captured[0]?.messages[0]!.reasoning_content).toBe("historical\nreasoning  ")
    expect(captured[0]?.reasoning_effort).toBe("max")
    expect(captured[0]?.chat_template_kwargs).toEqual({ clear_thinking: false })
  })

  test("the pinned SDK consumes cumulative adapted deltas once", async () => {
    const adapt = createGLMChunkAdapter("deployment-exact", { ...profile, cumulativeReasoning: true })
    const events = [
      chunk({ role: "assistant", reasoning_text: "a" }),
      chunk({ reasoning_text: "ab" }),
      chunk({ reasoning_text: "ab" }),
      chunk({ content: "answer" }),
      { ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
    ].map((value) => `data: ${JSON.stringify(adapt(value))}\n\n`).join("")
    const provider = createOpenAICompatible({
      name: "fixture", baseURL: "http://127.0.0.1:1/v1",
      fetch: Object.assign(async () => new Response(events + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }), { preconnect: globalThis.fetch.preconnect }),
    })
    const result = await provider.chatModel("deployment-exact").doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "task" }] }] })
    const reasoning: string[] = []
    const reader = result.stream.getReader()
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        if (part.value.type === "reasoning-delta") reasoning.push(part.value.delta)
      }
    } finally { reader.releaseLock() }
    expect(reasoning.join("")).toBe("ab")
  })
})
