import { describe, expect, test } from "bun:test"
import { Gate, admittedFetch } from "../src/transport"
import { canonical, Environments, ModeReminders, PrefixAudit, stripEnvironmentDate, UserTurns, type WireMessage } from "../src/prefix"
import createPlugin from "../src/index"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { Fetch } from "../src/transport"

const plugin: typeof createPlugin = (input, options) => createPlugin(input, { persistence: false, crossProcess: false, ...options })

test.each([false, true, undefined])("streaming usage respects provider includeUsage=%s", async (includeUsage) => {
  const requests: { stream_options?: { include_usage?: boolean } }[] = []
  const hooks = await plugin({} as PluginInput, { providers: ["proxy"], compaction: false })
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: {
    name: "fixture", baseURL: "http://usage-setting.test/v1", includeUsage,
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response(`data: ${JSON.stringify({
        id: "fixture", model: "fixture", created: 1,
        choices: [{ index: 0, delta: { content: "Answer" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  } } } }
  await hooks.config!(config)
  const provider = createOpenAICompatible({
    ...config.provider.proxy.options, fetch: Object.assign(config.provider.proxy.options.fetch, { preconnect: globalThis.fetch.preconnect }),
  })
  const response = await provider.chatModel("fixture").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Task" }] }],
  })
  const reader = response.stream.getReader()
  try { while (!(await reader.read()).done) { /* Consume the real SDK stream to EOF. */ } }
  finally { reader.releaseLock() }
  expect(requests[0]!.stream_options?.include_usage).toBe(includeUsage === false ? undefined : true)
  const explicit = await config.provider.proxy.options.fetch("http://usage-setting.test/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "fixture", messages: [], stream: true, stream_options: { include_usage: false } }),
  })
  await explicit.text()
  expect(requests[1]!.stream_options?.include_usage).toBe(false)
  await hooks.dispose!()
})

function system(date: string, cwd = "/project") {
  return `Stable policy.\nYou are powered by the model named fixture. The exact model ID is proxy/fixture\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: ${cwd}\n  Workspace root folder: /project\n  Is directory a git repo: yes\n  Platform: linux\n  Today's date: ${date}\n</env>\nProject instructions: obey the current policy.`
}
function history(date: string, extra: WireMessage[] = [], cwd?: string): WireMessage[] {
  return [{ role: "system", content: system(date, cwd) }, { role: "user", content: "Task" }, ...extra]
}

describe("prompt prefixes", () => {
  test("date removal preserves user-authored dates and project instructions", () => {
    const generated = [system("DAY_A"), "User policy: Today's date: KEEP_ME"]
    stripEnvironmentDate(generated)
    expect(generated[0]).toBe(system("DAY_A").replace("\n  Today's date: DAY_A", ""))
    expect(generated[1]).toBe("User policy: Today's date: KEEP_ME")
  })

  test("a day change does not change any previous messages or introduce a date reminder", () => {
    const environments = new Environments()
    const first = history("DAY_A")
    environments.apply(first, "session", "build")
    const second = history("DAY_B", [{ role: "assistant", content: "Answer" }, { role: "user", content: "Next" }])
    environments.apply(second, "session", "build")
    expect(second.slice(0, first.length)).toEqual(first)
    expect(JSON.stringify(second)).not.toContain("DAY_")
    expect(JSON.stringify(second)).not.toContain("Today's date")
    expect(second[0]!.content).toContain("Project instructions: obey the current policy.")
  })

  test("workspace changes append current context without rewriting past context", () => {
    const environments = new Environments()
    const first = history("DAY_A")
    environments.apply(first, "session", "build")
    const raw = history("DAY_A", [{ role: "assistant", content: "Answer" }, { role: "user", content: "Next" }], "/new-worktree")
    const second = structuredClone(raw)
    environments.apply(second, "session", "build")
    expect(second.slice(0, first.length)).toEqual(first)
    expect(second.at(-1)!.content).toContain("Working directory: /new-worktree")
    const retry = structuredClone(raw)
    environments.apply(retry, "session", "build")
    expect(retry).toEqual(second)
  })

  test("compaction, edited history, and separate lanes never resurrect unmatched context", () => {
    const environments = new Environments()
    environments.apply(history("DAY_A"), "session", "build")
    const edited = history("DAY_B", [], "/new")
    edited[1]!.content = "Replaced task"
    environments.apply(edited, "session", "build")
    expect(edited.filter((message) => message.role === "user")).toHaveLength(2)
    expect(JSON.stringify(edited)).not.toContain("Working directory: /project")
    const separate = history("DAY_B", [], "/other")
    environments.apply(separate, "other-session", "plan")
    expect(JSON.stringify(separate)).not.toContain("Working directory: /new")
    const policy = history("DAY_A")
    policy.push({ role: "system", content: "Later policy" })
    const original = structuredClone(policy)
    environments.apply(policy, "session", "policy")
    expect(policy).toEqual(original)
  })

  test("changed project policy and changed tools remain visible, not frozen", () => {
    const environments = new Environments()
    const first = history("DAY_A")
    environments.apply(first, "session", "build")
    const second = history("DAY_A")
    second[0]!.content = (second[0]!.content as string).replace("obey the current policy", "new policy")
    environments.apply(second, "session", "build")
    const audit = new PrefixAudit()
    audit.observe({ messages: first, tools: [{ name: "read" }] }, "session", "build")
    expect(audit.observe({ messages: second, tools: [{ name: "write" }] }, "session", "build")).toMatchObject({ systemChanged: true, toolsChanged: true })
    expect(second[0]!.content).toContain("new policy")
  })

  test("schema canonicalization removes key-order differences but preserves ordered values", () => {
    const first = { parameters: { required: ["b", "a"], properties: { b: { type: "string" }, a: { enum: ["z", "a"] } } }, name: "tool" }
    const second = { name: "tool", parameters: { properties: { a: { enum: ["z", "a"] }, b: { type: "string" } }, required: ["b", "a"] } }
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second))
    expect(JSON.stringify(canonical(first))).toBe(JSON.stringify(canonical(second)))
    expect(canonical(first)).toEqual(first)
  })
})

type Messages = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]["messages"]
function user(id: string, text: string, extra: Messages[number]["parts"] = []): Messages[number] {
  return {
    info: { id, sessionID: "session", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "proxy", modelID: "fixture" } },
    parts: [{ type: "text", id: `text-${id}`, sessionID: "session", messageID: id, text }, ...extra],
  }
}

test("real user identity survives compatible conversion and private markers never remain in wire text", async () => {
  const turns = new UserTurns()
  const stored: Messages = [user("real-user", "Keep the current constraint")]
  turns.mark(stored, new Set(["proxy"]))
  const part = stored[0]!.parts[0]!
  if (part.type !== "text") throw new Error("Expected text fixture")
  const provider = createOpenAICompatible({
    name: "fixture", baseURL: "http://127.0.0.1:1/v1",
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Request(input, init).json() as { messages: WireMessage[] }
      body.messages.push({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }] })
      const current = turns.consume(body.messages, turns.marker("session", "real-user"))
      expect(current).toBe(body.messages[0])
      expect(current?.content).toBe("Keep the current constraint")
      expect(JSON.stringify(body)).not.toContain("kv-guard-user:")
      return Response.json({ id: "fixture", model: "fixture", created: 1, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })
    }, { preconnect: globalThis.fetch.preconnect }),
  })
  await provider.chatModel("fixture").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: part.text }] }] })
  turns.clean(stored)
  expect(stored).toEqual([user("real-user", "Keep the current constraint")])
})

test("marker-only parts preserve image-only users and restore one-text lowering", () => {
  const turns = new UserTurns()
  const marker = turns.marker("session", "image-user")
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }
  const messages: WireMessage[] = [
    { role: "user", content: [image, { type: "text", text: marker }] },
    { role: "user", content: [{ type: "text", text: "Synthetic attachment" }, image] },
  ]
  expect(turns.consume(messages, marker)).toBe(messages[0])
  expect(messages[0]!.content).toEqual([image])
  const generated: WireMessage[] = [{ role: "user", content: [{ type: "text", text: "Core generated request" }, { type: "text", text: marker }] }]
  expect(turns.consume(generated, marker)).toBe(generated[0])
  expect(generated[0]!.content).toBe("Core generated request")
})

test("transient mode instruction remains attached to its old turn, never revives on current mode change", async () => {
  const text = await Bun.file(new URL("./fixtures/build-switch.txt", import.meta.url)).text()
  const reminder = { type: "text" as const, synthetic: true, id: "transient", sessionID: "session", messageID: "one", text }
  const tracker = new ModeReminders()
  const providers = new Set(["proxy"])
  const first: Messages = [user("one", "Task", [reminder])]
  tracker.apply(first, providers)
  const next: Messages = [user("one", "Task"), user("two", "Next")]
  tracker.apply(next, providers)
  expect(next[0]!.parts).toEqual(first[0]!.parts)
  expect(next[1]!.parts).toEqual(user("two", "Next").parts)

  const edited: Messages = [user("one", "Edited task"), user("two", "Next")]
  tracker.apply(edited, providers)
  expect(edited[0]!.parts).toEqual(user("one", "Edited task").parts)

  tracker.apply([user("one", "Task", [reminder])], providers)
  tracker.apply([user("one", "Task")], providers)
  const afterModeChange: Messages = [user("one", "Task"), user("two", "Next")]
  tracker.apply(afterModeChange, providers)
  expect(afterModeChange[0]!.parts).toEqual(user("one", "Task").parts)
})

describe("stream admission", () => {
  test("FIFO admission, queued abort, and idempotent release", async () => {
    const gate = new Gate(1)
    const release = await gate.acquire()
    const order: string[] = []
    const abort = new AbortController()
    const cancelled = gate.acquire(abort.signal)
    const rejected = cancelled.then(
      () => { throw new Error("Cancelled waiter was admitted") },
      (error: unknown) => error,
    )
    const second = gate.acquire().then((done) => { order.push("second"); return done })
    const third = gate.acquire().then((done) => { order.push("third"); return done })
    abort.abort(new Error("cancel queued"))
    expect(await rejected).toEqual(new Error("cancel queued"))
    release()
    release()
    const releaseSecond = await second
    expect(order).toEqual(["second"])
    releaseSecond()
    const releaseThird = await third
    expect(order).toEqual(["second", "third"])
    releaseThird()
  })

  test("headers do not release capacity; EOF releases it and preserves the response", async () => {
    const gate = new Gate(1)
    const stream = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const response = await admittedFetch(async () => new Response(new ReadableStream({ start: stream.resolve }), { headers: { "content-type": "text/event-stream", "x-proof": "kept" } }), gate, "http://local/chat/completions")
    let entered = false
    const second = admittedFetch(async () => { entered = true; return new Response("second") }, gate, "http://local/chat/completions")
    const controller = await stream.promise
    const reader = response.body!.getReader()
    controller.enqueue(new TextEncoder().encode("data: first\n\n"))
    expect((await reader.read()).value).toEqual(new TextEncoder().encode("data: first\n\n"))
    expect(entered).toBe(false)
    expect(response.headers.get("x-proof")).toBe("kept")
    controller.close()
    expect((await reader.read()).done).toBe(true)
    expect(await (await second).text()).toBe("second")
  })

  test("consumer cancellation reaches upstream before admitting another request", async () => {
    const gate = new Gate(1)
    const cancelled = Promise.withResolvers<unknown>()
    const response = await admittedFetch(async () => new Response(new ReadableStream({ cancel: cancelled.resolve })), gate, "http://local/chat/completions")
    const second = admittedFetch(async () => new Response("next"), gate, "http://local/chat/completions")
    await response.body!.cancel("stop")
    expect(await cancelled.promise).toBe("stop")
    expect(await (await second).text()).toBe("next")
  })

  test("abort without consuming a response releases the lease", async () => {
    const gate = new Gate(1)
    const abort = new AbortController()
    const response = await admittedFetch(async () => new Response(new ReadableStream()), gate, "http://local/chat/completions", { signal: abort.signal })
    const second = admittedFetch(async () => new Response("next"), gate, "http://local/chat/completions")
    abort.abort(new Error("stop active"))
    await expect(response.text()).rejects.toThrow("stop active")
    expect(await (await second).text()).toBe("next")
  })

  test("fetch and body errors release capacity; HTTP errors remain unchanged", async () => {
    const gate = new Gate(1)
    await expect(admittedFetch(async () => { throw new Error("network") }, gate, "http://local/chat/completions")).rejects.toThrow("network")
    const broken = await admittedFetch(async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error("body")) } })), gate, "http://local/chat/completions")
    await expect(broken.text()).rejects.toThrow("body")
    const body = JSON.stringify({ error: { message: "kv cache capacity exhausted" } })
    const error = await admittedFetch(async () => new Response(body, { status: 503, headers: { "retry-after": "3" } }), gate, "http://local/chat/completions")
    expect(error.status).toBe(503)
    expect(error.headers.get("retry-after")).toBe("3")
    expect(await error.text()).toBe(body)
    const release = await gate.acquire()
    release()
  })
})

test("invalid target options fail before activation", async () => {
  await expect(plugin({} as PluginInput, {})).rejects.toThrow("providers")
  await expect(plugin({} as PluginInput, { providers: ["proxy"], maxConcurrent: 0 })).rejects.toThrow("maxConcurrent")
})

test("per-turn OpenCode request IDs preserve the previous environment prefix", async () => {
  const captured: { body: { messages: WireMessage[] }; requestID: string | null }[] = []
  const config = { provider: { "opencode-local": { npm: "@ai-sdk/openai-compatible", options: {
    baseURL: "http://request-identity.test/v1",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      captured.push({ body: await request.json() as { messages: WireMessage[] }, requestID: request.headers.get("x-opencode-request") })
      return new Response("ok")
    },
  } } } }
  const hooks = await plugin({} as PluginInput, { providers: ["opencode-local"], compaction: false })
  await hooks.config!(config)
  for (const [id, messages] of [
    ["turn-one", history("DAY_A")],
    ["turn-two", history("DAY_A", [{ role: "assistant", content: "Done" }, { role: "user", content: "Next" }])],
  ] as const) {
    const response = await config.provider["opencode-local"].options.fetch("http://request-identity.test/v1/chat/completions", {
      method: "POST",
      headers: { "x-opencode-session-id": "request-id-session", "x-opencode-kv-guard-agent": "build", "x-opencode-request": id },
      body: JSON.stringify({ model: "fixture", messages }),
    })
    await response.text()
  }
  expect(captured.map((capture) => capture.requestID)).toEqual(["turn-one", "turn-two"])
  const previous = captured[0]!.body.messages
  expect(captured[1]!.body.messages.slice(0, previous.length)).toEqual(previous)
  await hooks.dispose!()
})

test("URL templates bind to the resolved endpoint and unresolved targets do not activate hooks", async () => {
  const key = "KV_GUARD_TEST_TENANT"
  const previous = process.env[key]
  process.env[key] = "tenant-fixture"
  try {
    let captured: Request | undefined
    let body: Record<string, unknown> | undefined
    const fetch: Fetch = async (input, init) => {
      captured = new Request(input, init)
      body = await captured.json() as Record<string, unknown>
      return new Response("ok")
    }
    const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:1/\${${key}}/v1`, fetch } } } }
    const hooks = await plugin({} as PluginInput, { providers: ["proxy"], maxOutputTokens: 16 })
    await hooks.config!(config)
    expect(config.provider.proxy.options.baseURL).toBe("http://127.0.0.1:1/tenant-fixture/v1")
    const response = await config.provider.proxy.options.fetch("http://127.0.0.1:1/tenant-fixture/v1/chat/completions", {
      method: "POST", headers: { "x-opencode-kv-guard-agent": "build" },
      body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Task" }], max_tokens: 999 }),
    })
    expect(await response.text()).toBe("ok")
    expect(body?.max_tokens).toBe(16)
    expect(captured?.headers.has("x-opencode-kv-guard-agent")).toBe(false)

    delete process.env[key]
    const inactive = await plugin({} as PluginInput, { providers: ["proxy"] })
    await expect(inactive.config!({ provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:1/\${${key}}/v1` } } } })).rejects.toThrow("unresolved baseURL")
    const messages = [user("one", "Untouched")]
    await inactive["experimental.chat.messages.transform"]!({}, { messages })
    expect(messages).toEqual([user("one", "Untouched")])
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

test("real compatible SDK passthrough keys are normalized without losing tenant salt or parent affinity", async () => {
  const captured: { body: Record<string, unknown>; headers: Headers }[] = []
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init)
    captured.push({ body: await request.json() as Record<string, unknown>, headers: request.headers })
    return Response.json({
      id: "fixture", object: "chat.completion", created: 1, model: "fixture",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }
  const config = {
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1/v1", fetch } } },
  }
  const before = createOpenAICompatible({ name: "fixture", ...config.provider.fixture.options, fetch: Object.assign(config.provider.fixture.options.fetch, { preconnect: globalThis.fetch.preconnect }) }).chatModel("fixture")
  await before.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "task" }] }],
    providerOptions: { fixture: { promptCacheKey: "stable", max_tokens: 999 } },
    maxOutputTokens: 512,
  })
  expect(captured[0]!.body.promptCacheKey).toBe("stable")
  expect(captured[0]!.body.prompt_cache_key).toBeUndefined()
  expect(captured[0]!.body.max_tokens).toBe(999)

  const hooks = await plugin({} as PluginInput, { providers: ["fixture"], maxOutputTokens: 64 })
  await hooks.config!(config)
  const after = createOpenAICompatible({ name: "fixture", ...config.provider.fixture.options, fetch: Object.assign(config.provider.fixture.options.fetch, { preconnect: globalThis.fetch.preconnect }) }).chatModel("fixture")
  await after.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "task" }] }],
    providerOptions: { fixture: { promptCacheKey: "stable", max_tokens: 999, cache_salt: "tenant-boundary" } },
    headers: { "x-opencode-session-id": "child-session", "x-parent-session-id": "parent-session", "x-opencode-kv-guard-agent": "build" },
    maxOutputTokens: 512,
  })
  expect(captured[1]!.body.promptCacheKey).toBeUndefined()
  expect(captured[1]!.body.prompt_cache_key).toBe("stable")
  expect(captured[1]!.body.cache_salt).toBe("tenant-boundary")
  expect(captured[1]!.body.max_tokens).toBe(64)
  expect(captured[1]!.headers.get("x-litellm-session-id")).toBe("parent-session")
  expect(captured[1]!.headers.has("x-opencode-kv-guard-agent")).toBe(false)
  await after.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "task" }] }],
    providerOptions: { fixture: {
      promptCacheKey: "generated", prompt_cache_key: "explicit",
      chatTemplateKwargs: { preserve_thinking: true, enable_thinking: false },
      maxCompletionTokens: 999, cacheSalt: "kept-isolation",
    } },
    maxOutputTokens: 512,
  })
  expect(captured[2]!.body.prompt_cache_key).toBe("explicit")
  expect(captured[2]!.body.chat_template_kwargs).toEqual({ preserve_thinking: true, enable_thinking: false })
  expect(captured[2]!.body.chatTemplateKwargs).toBeUndefined()
  expect(captured[2]!.body.cache_salt).toBe("kept-isolation")
  expect(captured[2]!.body.max_completion_tokens).toBe(64)
  expect(captured[2]!.body.max_tokens).toBeUndefined()
  await after.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "task" }] }],
    providerOptions: { fixture: { maxTokens: 32 } },
    maxOutputTokens: 512,
  })
  expect(captured[3]!.body.max_tokens).toBe(32)
  expect(captured[3]!.body.maxTokens).toBeUndefined()
})

test("manual compaction reuses the cached main prefix only when history still matches it", async () => {
  const sent: Record<string, unknown>[] = []
  const fetch: Fetch = async (input, init) => {
    const body = await new Request(input, init).json() as Record<string, unknown>
    sent.push(body)
    if (body.stream === false) return Response.json({ id: "handoff", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "HANDOFF" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })
    return new Response(`data: ${JSON.stringify({ id: "main", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
  let stored: unknown[] = []
  const client = { session: { messages: async () => ({ data: stored }) }, app: { log: async () => {} } }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://manual.test/v1", fetch } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"] })
  await hooks.config!(config)
  const headers = (agent: string, user: string) => ({ "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": agent, "x-opencode-kv-guard-limits": JSON.stringify({ context: 100_000, output: 1000 }), "x-opencode-kv-guard-user": user })
  const post = (agent: string, user: string, body: Record<string, unknown>) => config.provider.proxy.options.fetch("http://manual.test/v1/chat/completions", { method: "POST", headers: headers(agent, user), body: JSON.stringify(body) })
  // The real messages.transform hook adds the current-user provenance marker.
  const turn: Messages = [user("msg_user", "Task")]
  await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
  const marked = turn[0]!.parts[0]!
  if (marked.type !== "text") throw new Error("Expected text fixture")
  const main = { model: "fixture", stream: true, max_tokens: 1000, messages: [{ role: "system", content: "Policy" }, { role: "user", content: marked.text }], tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }
  await (await post("build", "msg_user", main)).text()
  const native = { model: "fixture", stream: true, max_tokens: 1000, messages: [{ role: "system", content: "Summarizer" }, { role: "user", content: "Here is the conversation so far:\n\n<conversation>\n[User]: Task\n</conversation>\n\nCreate a new anchored summary." }] }
  const history = (assistant: Record<string, unknown>) => [
    { info: { role: "user", id: "msg_user" }, parts: [] },
    { info: { role: "assistant", id: "msg_answer", finish: "stop", ...assistant }, parts: [] },
    { info: { role: "user", id: "msg_compact" }, parts: [{ type: "compaction" }] },
  ]

  // A failed last step is not the recorded exchange: send the native request.
  stored = history({ error: { name: "APIError" } })
  await (await post("compaction", "msg_compact", native)).text()
  expect(sent).toHaveLength(2)
  expect(sent[1]!.messages).toEqual(native.messages)

  stored = history({})
  const answered = await (await post("compaction", "msg_compact", native)).text()
  expect(sent).toHaveLength(3)
  const handoff = sent[2]!
  expect(handoff.stream).toBe(false)
  expect((handoff.messages as unknown[]).slice(0, 2)).toEqual(sent[0]!.messages as unknown[])
  expect(handoff.tools).toEqual(sent[0]!.tools)
  expect(handoff.tool_choice).toBe("auto")
  const instruction = String((handoff.messages as { content: unknown }[]).at(-1)!.content)
  expect(instruction).toContain("Create a new anchored summary.")
  expect(instruction).not.toContain("[User]: Task")
  expect(answered).toContain('"content":"HANDOFF"')
  expect(answered).toContain("data: [DONE]")

  // The exchange is consumed: a repeated /compact falls back to native.
  await (await post("compaction", "msg_compact", native)).text()
  expect(sent).toHaveLength(4)
  expect(sent[3]!.messages).toEqual(native.messages)
  await hooks.dispose!()
})
