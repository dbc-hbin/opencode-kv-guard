import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Gate, admittedFetch } from "../src/transport"
import { canonical, Environments, ModeReminders, PrefixAudit, stripEnvironmentDate, UserTurns, type WireMessage } from "../src/prefix"
import createPlugin from "../src/index"
import { CheckpointConflictError, CheckpointStore } from "../src/checkpoints"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
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

test("stable agent tools apply only when enabled and only to top-level primary sessions", async () => {
  const read = { type: "function", function: { name: "read", parameters: { type: "object" } } }
  const write = { type: "function", function: { name: "write", parameters: { type: "object" } } }
  const run = async (options: Record<string, unknown>, agents: string[], parent?: string) => {
    const captured: { tools?: unknown[]; messages: WireMessage[] }[] = []
    const config = { provider: { local: { npm: "@ai-sdk/openai-compatible", options: {
      baseURL: "http://stable-tools.test/v1",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push(await new Request(input, init).json() as { tools?: unknown[]; messages: WireMessage[] })
        return new Response("ok")
      },
    } } } }
    const hooks = await plugin({} as PluginInput, { providers: ["local"], compaction: false, persistence: false, ...options })
    await hooks.config!(config)
    const messages: WireMessage[] = [{ role: "system", content: "Policy" }, { role: "user", content: "one" }]
    for (const [index, agent] of agents.entries()) {
      if (index) messages.push({ role: "assistant", content: `answer ${index}` }, { role: "user", content: `turn ${index}` })
      const tools = agent === "primary" || agent === "build" ? [read, write] : agent === "bare" ? undefined : [read]
      await (await config.provider.local.options.fetch("http://stable-tools.test/v1/chat/completions", {
        method: "POST",
        headers: { "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": agent, ...(parent ? { "x-opencode-parent-session-id": parent } : {}) },
        body: JSON.stringify({ model: "fixture", messages, ...(tools ? { tools } : {}) }),
      })).text()
    }
    await hooks.dispose!()
    return captured
  }
  const names = (body: { tools?: unknown[] }) => (body.tools as { function: { name: string } }[] | undefined)?.map((item) => item.function.name)
  // An agent literally named "primary" gets no stable catalog unless opted in.
  const disabled = await run({}, ["primary", "primary-ask"])
  expect(names(disabled[1]!)).toEqual(["read"])
  const named = await run({}, ["build", "primary"])
  expect(names(named[1]!)).toEqual(["read", "write"])
  // Child sessions keep per-agent lanes and the live catalog.
  const child = await run({ stableAgentTools: true }, ["build", "ask"], "parent")
  expect(names(child[1]!)).toEqual(["read"])
  // An omitted live tool list is a complete withdrawal, not a reset.
  const enabled = await run({ stableAgentTools: true }, ["build", "bare", "build"])
  expect(enabled.map(names)).toEqual([["read", "write"], ["read", "write"], ["read", "write"]])
  for (let index = 1; index < enabled.length; index++) {
    expect(enabled[index]!.messages.slice(0, enabled[index - 1]!.messages.length)).toEqual(enabled[index - 1]!.messages)
  }
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
  expect(handoff.tool_choice).toBe("none")
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

test("a summary handoff overflow recovers by folding once; a rejected tool_choice none is remembered", async () => {
  const sent: Record<string, unknown>[] = []
  let handoffs = 0
  const overflow = () => Response.json({ object: "error", message: "This model's maximum context length is 8000 tokens. However, you requested 9000 tokens (8500 in the messages, 500 in the completion)." }, { status: 400 })
  const summary = () => Response.json({ id: "summary", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "FOLDED" }, finish_reason: "stop" }] })
  let mode: "overflow" | "reject-none" = "overflow"
  const fetch: Fetch = async (input, init) => {
    const body = await new Request(input, init).json() as Record<string, unknown>
    sent.push(body)
    if (body.stream === false) {
      if (body.tools === undefined) return summary()
      handoffs++
      if (mode === "overflow") return overflow()
      return body.tool_choice === "none" ? Response.json({ error: { message: "tool_choice none unsupported" } }, { status: 400 }) : summary()
    }
    return new Response(`data: ${JSON.stringify({ id: "main", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
  const client = { app: { log: async () => {} }, session: { get: async () => ({ data: {} }) }, tui: { showToast: async () => ({}) } }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://recover.test/v1", fetch } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"], compaction: { bytesPerToken: 1, summaryOutputTokens: 200 } })
  await hooks.config!(config)
  const post = async (session: string, userID: string, history: Record<string, unknown>[]) => {
    const turn: Messages = [{ ...user(userID, "Task"), info: { ...user(userID, "Task").info, sessionID: session } }]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
    const marked = turn[0]!.parts[0]!
    if (marked.type !== "text") throw new Error("Expected text fixture")
    const body = { model: "fixture", stream: true, max_tokens: 500, tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }], messages: [{ role: "system", content: "Policy" }, ...history, { role: "user", content: marked.text }] }
    const headers = { "x-opencode-session-id": session, "x-opencode-kv-guard-agent": "build", "x-opencode-kv-guard-limits": JSON.stringify({ context: 12000, output: 500 }), "x-opencode-kv-guard-user": userID }
    return config.provider.proxy.options.fetch("http://recover.test/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) })
  }
  // About 10,300 bytes: over the 9,775 trigger while the handoff still fits its summary budget.
  const history = Array.from({ length: 14 }, (_, index) => [{ role: "user", content: `old ${index} ` + "x".repeat(320) }, { role: "assistant", content: `reply ${index} ` + "y".repeat(320) }]).flat()

  const recovered = await post("overflow-session", "msg_a", history)
  expect(await recovered.text()).toContain("Answer")
  const summaries = sent.filter((body) => body.stream === false)
  expect(handoffs).toBe(1)
  expect(summaries.at(-1)!.tools).toBeUndefined()
  const main = sent.filter((body) => body.stream === true)
  expect(main).toHaveLength(1)
  expect(JSON.stringify(main[0]!.messages)).toContain("FOLDED")

  mode = "reject-none"
  sent.length = 0
  handoffs = 0
  await (await post("none-a", "msg_b", history)).text()
  expect(sent.filter((body) => body.stream === false).map((body) => body.tool_choice)).toEqual(["none", "auto"])
  sent.length = 0
  await (await post("none-b", "msg_c", history)).text()
  expect(sent.filter((body) => body.stream === false).map((body) => body.tool_choice)).toEqual(["auto"])
  await hooks.dispose!()
})

test("a discarded speculative error response releases the endpoint slot", async () => {
  let summaries = 0
  const summarySent = Promise.withResolvers<void>()
  const fetch: Fetch = async (input, init) => {
    const body = await new Request(input, init).json() as Record<string, unknown>
    if (body.stream === false) {
      summaries++
      summarySent.resolve()
      // A 503 body that is never read keeps the admission slot unless cancelled.
      return new Response(new ReadableStream({ pull() {} }), { status: 503, headers: { "content-type": "application/json" } })
    }
    const size = Buffer.byteLength(JSON.stringify(body))
    return new Response(`data: ${JSON.stringify({ id: "main", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ id: "main", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: size, completion_tokens: 1, total_tokens: size + 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
  const client = { app: { log: async () => {} }, session: { get: async () => ({ data: {} }) }, tui: { showToast: async () => ({}) } }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://speculate.test/v1", fetch } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"], speculativeCompaction: true, compaction: { bytesPerToken: 1 } })
  await hooks.config!(config)
  const history = Array.from({ length: 6 }, (_, index) => [{ role: "user", content: `old ${index} ` + "x".repeat(300) }, { role: "assistant", content: `reply ${index} ` + "y".repeat(300) }]).flat()
  const post = async (userID: string) => {
    const turn: Messages = [user(userID, "Task")]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
    const marked = turn[0]!.parts[0]!
    if (marked.type !== "text") throw new Error("Expected text fixture")
    const body = { model: "fixture", stream: true, max_tokens: 500, messages: [{ role: "system", content: "Policy" }, ...history, { role: "user", content: marked.text }] }
    // Place the request at 95% of the trigger, inside the speculation band.
    const context = Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 0.95 / 0.85) + 500
    const headers = { "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": "build", "x-opencode-kv-guard-limits": JSON.stringify({ context, output: 500 }), "x-opencode-kv-guard-user": userID }
    return config.provider.proxy.options.fetch("http://speculate.test/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) })
  }
  await (await post("msg_a")).text()
  // The completed response starts the background summary, which gets 503.
  const bounded = <T>(pending: Promise<T>, fallback: T) => Promise.race([pending, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 2000))])
  await bounded(summarySent.promise, undefined)
  expect(summaries).toBe(1)
  // With maxConcurrent 1, the next main request must still be admitted.
  const next = await bounded(post("msg_b").then((response) => response.text()), "admission blocked")
  expect(next).toContain("Answer")
  await hooks.dispose!()
})

test("a checkpoint publication conflict cancels an unread summary before admitting the next request", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "kv-guard-publication-"))
  let conflict = false
  let cancelled = false
  let mainRequests = 0
  const original = CheckpointStore.prototype.save
  const save = spyOn(CheckpointStore.prototype, "save").mockImplementation(async function (this: CheckpointStore, ...args) {
    if (conflict) {
      conflict = false
      // A competing writer commits after preparation loaded its CAS revision.
      await original.call(this, ...args)
    }
    return original.call(this, ...args)
  })
  const fetch: Fetch = async (input, init) => {
    const body = await new Request(input, init).json() as Record<string, unknown>
    if (body.stream === false) {
      conflict = true
      return new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true } }), { status: 503 })
    }
    mainRequests++
    return new Response("admitted")
  }
  const client = { app: { log: async () => {} }, session: { get: async () => ({ data: {} }) }, tui: { showToast: async () => ({}) } }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://publication.test/v1", fetch } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"], persistence: true, stateDirectory, compaction: { bytesPerToken: 1, summaryOutputTokens: 200 } })
  try {
    await hooks.config!(config)
    const turn: Messages = [user("msg_user", "Task")]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
    const marked = turn[0]!.parts[0]!
    if (marked.type !== "text") throw new Error("Expected text fixture")
    const history = Array.from({ length: 14 }, (_, index) => [{ role: "user", content: `old ${index} ` + "x".repeat(320) }, { role: "assistant", content: `reply ${index} ` + "y".repeat(320) }]).flat()
    const headers = { "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": "build", "x-opencode-kv-guard-user": "msg_user", "x-opencode-kv-guard-limits": JSON.stringify({ context: 12000, output: 500 }) }
    await expect(config.provider.proxy.options.fetch("http://publication.test/v1/chat/completions", {
      method: "POST", headers, body: JSON.stringify({ model: "fixture", stream: true, max_tokens: 500, messages: [{ role: "system", content: "Policy" }, ...history, { role: "user", content: marked.text }] }),
    })).rejects.toBeInstanceOf(CheckpointConflictError)
    expect(cancelled).toBe(true)
    const next = await config.provider.proxy.options.fetch("http://publication.test/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(2000), headers: { "x-opencode-session-id": "next", "x-opencode-kv-guard-agent": "build" },
      body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Next" }] }),
    })
    expect(await next.text()).toBe("admitted")
    expect(mainRequests).toBe(1)
  } finally {
    save.mockRestore()
    await hooks.dispose!()
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test.each([
  { timeout: 25, headerTimeout: 1000 },
  { timeout: false, headerTimeout: 25 },
  { timeout: 1000, headerTimeout: 25 },
])("a detached speculative summary observes provider deadlines %j", async ({ timeout, headerTimeout }) => {
  const summarySent = Promise.withResolvers<void>()
  const summaryAborted = Promise.withResolvers<unknown>()
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = await request.json() as Record<string, unknown>
    if (body.stream === false) {
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => { summaryAborted.resolve(request.signal.reason); reject(request.signal.reason) }, { once: true })
        summarySent.resolve()
      })
    }
    const size = Buffer.byteLength(JSON.stringify(body))
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: size, completion_tokens: 1, total_tokens: size + 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
  const client = { app: { log: async () => {} }, session: { get: async () => ({ data: {} }) }, tui: { showToast: async () => ({}) } }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://speculation-deadline.test/v1", fetch, timeout, headerTimeout } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"], speculativeCompaction: true, compaction: { bytesPerToken: 1 } })
  try {
    await hooks.config!(config)
    const turn: Messages = [user("msg_user", "Task")]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
    const marked = turn[0]!.parts[0]!
    if (marked.type !== "text") throw new Error("Expected text fixture")
    const history = Array.from({ length: 6 }, (_, index) => [{ role: "user", content: `old ${index} ` + "x".repeat(300) }, { role: "assistant", content: `reply ${index} ` + "y".repeat(300) }]).flat()
    const body = { model: "fixture", stream: true, max_tokens: 500, messages: [{ role: "system", content: "Policy" }, ...history, { role: "user", content: marked.text }] }
    const context = Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 0.95 / 0.85) + 500
    const headers = { "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": "build", "x-opencode-kv-guard-limits": JSON.stringify({ context, output: 500 }), "x-opencode-kv-guard-user": "msg_user" }
    await (await config.provider.proxy.options.fetch("http://speculation-deadline.test/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) })).text()
    await summarySent.promise
    // Another session must get the same endpoint slot without cancelling speculation itself.
    const next = await config.provider.proxy.options.fetch("http://speculation-deadline.test/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(2000), headers: { "x-opencode-session-id": "next", "x-opencode-kv-guard-agent": "build" },
      body: JSON.stringify({ model: "fixture", stream: true, messages: [{ role: "user", content: "Next" }] }),
    })
    expect(await next.text()).toContain("Answer")
    expect(await summaryAborted.promise).toBeInstanceOf(DOMException)
  } finally { await hooks.dispose!() }
})

test("a detached speculative summary keeps upstream header vs total timeout semantics", async () => {
  // headerTimeout covers only the wait for headers; a slower body is allowed
  // up to the total timeout, which each request gets afresh.
  const bodyStarted = Promise.withResolvers<void>()
  const finishBody = Promise.withResolvers<void>()
  const summaryDone = Promise.withResolvers<string>()
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = await request.json() as Record<string, unknown>
    if (body.stream === false) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          bodyStarted.resolve()
          request.signal.addEventListener("abort", () => { summaryDone.resolve("aborted"); controller.error(request.signal.reason) }, { once: true })
          await finishBody.promise
          controller.enqueue(encoder.encode(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "SLOW_BODY_SUMMARY" }, finish_reason: "stop" }] })))
          controller.close()
          summaryDone.resolve("completed")
        },
      })
      return new Response(stream, { headers: { "content-type": "application/json" } })
    }
    const size = Buffer.byteLength(JSON.stringify(body))
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: size, completion_tokens: 1, total_tokens: size + 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
  const client = { app: { log: async () => {} }, session: { get: async () => ({ data: {} }) }, tui: { showToast: async () => ({}) } }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://speculation-semantics.test/v1", fetch, timeout: 5000, headerTimeout: 25 } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"], speculativeCompaction: true, compaction: { bytesPerToken: 1 } })
  try {
    await hooks.config!(config)
    const turn: Messages = [user("msg_user", "Task")]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
    const marked = turn[0]!.parts[0]!
    if (marked.type !== "text") throw new Error("Expected text fixture")
    const history = Array.from({ length: 6 }, (_, index) => [{ role: "user", content: `old ${index} ` + "x".repeat(300) }, { role: "assistant", content: `reply ${index} ` + "y".repeat(300) }]).flat()
    const body = { model: "fixture", stream: true, max_tokens: 500, messages: [{ role: "system", content: "Policy" }, ...history, { role: "user", content: marked.text }] }
    const context = Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 0.95 / 0.85) + 500
    const headers = { "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": "build", "x-opencode-kv-guard-limits": JSON.stringify({ context, output: 500 }), "x-opencode-kv-guard-user": "msg_user" }
    await (await config.provider.proxy.options.fetch("http://speculation-semantics.test/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) })).text()
    await bodyStarted.promise
    // Elapsed real time is the behavior under test: outlive the 25 ms header
    // deadline after headers arrived, then end the body. Fake timers cannot
    // drive the AbortSignal.timeout these deadlines use.
    await new Promise((resolve) => setTimeout(resolve, 100))
    finishBody.resolve()
    expect(await summaryDone.promise).toBe("completed")
  } finally { await hooks.dispose!() }
})

test("a detached tool_choice none rejection gives its auto retry fresh deadlines", async () => {
  // The rejected response's slow error body and the retry's header wait must
  // not share one header deadline.
  const choices: unknown[] = []
  const errorBodyStarted = Promise.withResolvers<void>()
  const finishErrorBody = Promise.withResolvers<void>()
  const retried = Promise.withResolvers<string>()
  const encoder = new TextEncoder()
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = await request.json() as Record<string, unknown>
    if (body.stream === false) {
      choices.push(body.tool_choice)
      if (body.tool_choice === "none") {
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            errorBodyStarted.resolve()
            request.signal.addEventListener("abort", () => controller.error(request.signal.reason), { once: true })
            await finishErrorBody.promise
            controller.enqueue(encoder.encode(JSON.stringify({ error: { message: "tool_choice none is not supported" } })))
            controller.close()
          },
        }), { status: 400, headers: { "content-type": "application/json" } })
      }
      request.signal.addEventListener("abort", () => retried.resolve("aborted"), { once: true })
      queueMicrotask(() => retried.resolve("sent"))
      return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "AUTO_SUMMARY" }, finish_reason: "stop" }] })
    }
    const size = Buffer.byteLength(JSON.stringify(body))
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: size, completion_tokens: 1, total_tokens: size + 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
  const client = { app: { log: async () => {} }, session: { get: async () => ({ data: {} }) }, tui: { showToast: async () => ({}) } }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://speculation-fallback.test/v1", fetch, timeout: 5000, headerTimeout: 25 } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"], speculativeCompaction: true, compaction: { bytesPerToken: 1 } })
  try {
    await hooks.config!(config)
    const turn: Messages = [user("msg_user", "Task")]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
    const marked = turn[0]!.parts[0]!
    if (marked.type !== "text") throw new Error("Expected text fixture")
    const history = Array.from({ length: 6 }, (_, index) => [{ role: "user", content: `old ${index} ` + "x".repeat(300) }, { role: "assistant", content: `reply ${index} ` + "y".repeat(300) }]).flat()
    const body = { model: "fixture", stream: true, max_tokens: 500, tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }], messages: [{ role: "system", content: "Policy" }, ...history, { role: "user", content: marked.text }] }
    const context = Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 0.95 / 0.85) + 500
    const headers = { "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": "build", "x-opencode-kv-guard-limits": JSON.stringify({ context, output: 500 }), "x-opencode-kv-guard-user": "msg_user" }
    await (await config.provider.proxy.options.fetch("http://speculation-fallback.test/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) })).text()
    await errorBodyStarted.promise
    // Elapsed real time is the behavior under test: the error body outlives the
    // 25 ms header deadline. Fake timers cannot drive AbortSignal.timeout.
    await new Promise((resolve) => setTimeout(resolve, 100))
    finishErrorBody.resolve()
    expect(await retried.promise).toBe("sent")
    expect(choices).toEqual(["none", "auto"])
  } finally { await hooks.dispose!() }
})

test("manual compaction rejects a tool-call exchange superseded by a length-finished step", async () => {
  const sent: Record<string, unknown>[] = []
  const toolCall = { id: "call_read", type: "function", function: { name: "read", arguments: "{}" } }
  const fetch: Fetch = async (input, init) => {
    const body = await new Request(input, init).json() as Record<string, unknown>
    sent.push(body)
    const first = sent.length === 1
    return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: first ? null : "Partial", ...(first ? { tool_calls: [toolCall] } : {}) }, finish_reason: first ? "tool_calls" : "length" }] })
  }
  const stored = [
    { info: { role: "user", id: "msg_user" }, parts: [] },
    { info: { role: "assistant", id: "msg_tools", finish: "tool-calls", time: { completed: 1 } }, parts: [] },
    { info: { role: "assistant", id: "msg_partial", finish: "length", time: { completed: 2 } }, parts: [] },
    { info: { role: "user", id: "msg_compact" }, parts: [{ type: "compaction" }] },
  ]
  const client = { session: { messages: async () => ({ data: stored }) }, app: { log: async () => {} } }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://stale-exchange.test/v1", fetch } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"] })
  try {
    await hooks.config!(config)
    const turn: Messages = [user("msg_user", "Task")]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
    const marked = turn[0]!.parts[0]!
    if (marked.type !== "text") throw new Error("Expected text fixture")
    const post = (agent: string, messages: WireMessage[]) => config.provider.proxy.options.fetch("http://stale-exchange.test/v1/chat/completions", {
      method: "POST", headers: { "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": agent, "x-opencode-kv-guard-user": agent === "build" ? "msg_user" : "msg_compact", "x-opencode-kv-guard-limits": JSON.stringify({ context: 100_000, output: 1000 }) },
      body: JSON.stringify({ model: "fixture", max_tokens: 1000, messages }),
    })
    const messages = [{ role: "system", content: "Policy" }, { role: "user", content: marked.text }]
    await (await post("build", messages)).text()
    await (await post("build", [...messages, { role: "assistant", content: null, tool_calls: [toolCall] }, { role: "tool", tool_call_id: "call_read", content: "Result" }])).text()
    const native = [{ role: "system", content: "Summarizer" }, { role: "user", content: "Here is the conversation so far:\n\n<conversation>\n[User]: Task\n</conversation>\n\nSummarize." }]
    await (await post("compaction", native)).text()
    expect(sent).toHaveLength(3)
    expect(sent[2]!.messages).toEqual(native)
  } finally { await hooks.dispose!() }
})

test("manual compaction preserves custom compaction-agent system instructions", async () => {
  const sent: Record<string, unknown>[] = []
  const fetch: Fetch = async (input, init) => {
    const body = await new Request(input, init).json() as Record<string, unknown>
    sent.push(body)
    return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "Answer" }, finish_reason: "stop" }] })
  }
  const stored = [
    { info: { role: "user", id: "msg_user" }, parts: [] },
    { info: { role: "assistant", id: "msg_answer", finish: "stop" }, parts: [] },
    { info: { role: "user", id: "msg_compact" }, parts: [{ type: "compaction" }] },
  ]
  const client = { session: { messages: async () => ({ data: stored }) }, app: { log: async () => {} } }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://custom-compaction.test/v1", fetch } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"] })
  try {
    await hooks.config!(config)
    const turn: Messages = [user("msg_user", "Task")]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
    const marked = turn[0]!.parts[0]!
    if (marked.type !== "text") throw new Error("Expected text fixture")
    const post = (agent: string, messages: WireMessage[]) => config.provider.proxy.options.fetch("http://custom-compaction.test/v1/chat/completions", {
      method: "POST", headers: { "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": agent, "x-opencode-kv-guard-user": agent === "build" ? "msg_user" : "msg_compact", "x-opencode-kv-guard-limits": JSON.stringify({ context: 100_000, output: 1000 }) },
      body: JSON.stringify({ model: "fixture", max_tokens: 1000, messages }),
    })
    await (await post("build", [{ role: "system", content: "Policy" }, { role: "user", content: marked.text }])).text()
    const customSystem = "Preserve every deployment approval and write the summary in Korean."
    await (await post("compaction", [{ role: "system", content: customSystem }, { role: "user", content: "Here is the conversation so far:\n\n<conversation>\n[User]: Task\n</conversation>\n\nSummarize." }])).text()
    expect(JSON.stringify(sent[1]!.messages)).toContain(customSystem)
  } finally { await hooks.dispose!() }
})

test("native compaction history is cleaned without injecting private user provenance", async () => {
  const hooks = await plugin({} as PluginInput, { providers: ["proxy"] })
  await hooks.config!({ provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://native-transform.test/v1" } } } })
  try {
    const live: Messages = [user("msg_user", "Task")]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: live })
    expect(JSON.stringify(live)).toContain("kv-guard-user:")
    // v1.19.4 removes the compaction marker and selects history before this hook.
    const history = structuredClone(live)
    await hooks["experimental.session.compacting"]?.({ sessionID: "session" }, { context: [] })
    await hooks["experimental.chat.messages.transform"]!({}, { messages: history })
    expect(history).toEqual([user("msg_user", "Task")])
  } finally { await hooks.dispose!() }
})

test("a native compaction cancelled before its transform does not strip the next turn's provenance", async () => {
  const hooks = await plugin({ client: { app: { log: async () => {} }, session: { messages: async () => ({ data: [] }) } } } as unknown as PluginInput, { providers: ["proxy"], continueTruncated: false })
  await hooks.config!({ provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://native-cancel.test/v1" } } } })
  try {
    // compacting fired, then the compaction was cancelled; the session goes idle.
    await hooks["experimental.session.compacting"]?.({ sessionID: "session" }, { context: [] })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session" } } as never })
    const next: Messages = [user("msg_next", "Next task")]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: next })
    expect(JSON.stringify(next)).toContain("kv-guard-user:")
  } finally { await hooks.dispose!() }
})

test("an output-limit finish is continued only once its step completed", async () => {
  const prompts: unknown[] = []
  let stored: unknown[] = []
  const assistant = (time: Record<string, number>) => ({ info: { id: "msg_answer", role: "assistant", parentID: "msg_user", finish: "length", time, providerID: "proxy", modelID: "fixture", mode: "build" }, parts: [] })
  const client = {
    app: { log: async () => {} },
    session: { messages: async () => ({ data: stored }), get: async () => ({ data: {} }), promptAsync: async (input: unknown) => { prompts.push(input); return {} } },
    tui: { showToast: async () => ({}) },
  }
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://idle.test/v1", fetch: (async () => new Response()) as Fetch } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"] })
  await hooks.config!(config)
  const idle = () => hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session" } } as never })
  const userTurn = { info: { id: "msg_user", role: "user", agent: "build", model: { providerID: "proxy", modelID: "fixture" } }, parts: [{ type: "text", text: "Task" }] }
  // A cancelled step can publish idle after storing finish but before its
  // error and completion time.
  stored = [userTurn, assistant({ created: 1 })]
  await idle()
  expect(prompts).toHaveLength(0)
  stored = [userTurn, { ...assistant({ created: 1, completed: 2 }), info: { ...assistant({}).info, time: { created: 1, completed: 2 }, error: { name: "MessageAbortedError", data: {} } } }]
  await idle()
  expect(prompts).toHaveLength(0)
  stored = [userTurn, assistant({ created: 1, completed: 2 })]
  await idle()
  expect(prompts).toHaveLength(1)
  await hooks.dispose!()
})

test("/kv-compact compacts only the command's own user message and is cleared when its turn ends", async () => {
  const sent: Record<string, unknown>[] = []
  const fetch: Fetch = async (input, init) => {
    const body = await new Request(input, init).json() as Record<string, unknown>
    sent.push(body)
    if (body.stream === false) return Response.json({ id: "summary", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "FOLDED" }, finish_reason: "stop" }] })
    return new Response(`data: ${JSON.stringify({ id: "main", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
  const client = { app: { log: async () => {} }, session: { get: async () => ({ data: {} }) }, tui: { showToast: async () => ({}) } }
  const config: Record<string, any> = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://kv-compact.test/v1", fetch } } } }
  const hooks = await plugin({ client } as unknown as PluginInput, { providers: ["proxy"], compaction: { bytesPerToken: 1 } })
  await hooks.config!(config as never)
  const registered = config.command["kv-compact"]
  expect(registered.subtask).toBe(false)
  const history = Array.from({ length: 6 }, (_, index) => [{ role: "user", content: `old ${index} ` + "x".repeat(300) }, { role: "assistant", content: `reply ${index} ` + "y".repeat(300) }]).flat()
  const summaries = () => sent.filter((body) => body.stream === false).length
  const post = async (userID: string, text = "Task") => {
    const turn: Messages = [user(userID, text)]
    await hooks["experimental.chat.messages.transform"]!({}, { messages: turn })
    const marked = turn[0]!.parts[0]!
    if (marked.type !== "text") throw new Error("Expected text fixture")
    const body = { model: "fixture", stream: true, max_tokens: 500, messages: [{ role: "system", content: "Policy" }, ...history, { role: "user", content: marked.text }] }
    const headers = { "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": "build", "x-opencode-kv-guard-limits": JSON.stringify({ context: 100_000, output: 500 }), "x-opencode-kv-guard-user": userID }
    await (await config.provider.proxy.options.fetch("http://kv-compact.test/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) })).text()
  }
  // OpenCode runs command.execute.before on the resolved template parts, then
  // creates the user message and calls chat.message with those parts.
  const command = async () => {
    const parts = [{ type: "text", text: registered.template }] as never as Part[]
    await hooks["command.execute.before"]!({ command: "kv-compact", sessionID: "session", arguments: "" }, { parts })
    return parts
  }
  const message = async (messageID: string, parts: Part[]) => {
    await hooks["chat.message"]!({ sessionID: "session" }, { message: { id: messageID } as never, parts })
    return parts
  }
  const plainParts = () => [{ type: "text", text: "ordinary prompt" }] as never as Part[]

  // A concurrent ordinary prompt between the command hook and its message is not authorized.
  const commandParts = await command()
  expect((await message("msg_other", plainParts()))[0]).toMatchObject({ text: "ordinary prompt" })
  const stored = await message("msg_command", commandParts)
  expect(stored[0]).toMatchObject({ text: registered.template })
  await post("msg_other")
  expect(summaries()).toBe(0)
  await post("msg_command", registered.template)
  expect(summaries()).toBe(1)
  expect(JSON.stringify(sent.at(-1)!.messages)).toContain("FOLDED")
  // A command turn that never reached a selected provider is cleared on idle.
  await message("msg_elsewhere", await command())
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session" } } as never })
  await post("msg_elsewhere")
  expect(summaries()).toBe(1)
  await hooks.dispose!()
})
