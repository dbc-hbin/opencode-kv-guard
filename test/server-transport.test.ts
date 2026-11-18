import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Message } from "@opencode/ai/effect"
import { Agent, Model, Provider } from "@opencode/plugin"
import type { AISDKHooks } from "@opencode/plugin/promise/aisdk"
import type { ModelHooks } from "@opencode/plugin/promise/registration"
import type { SessionContext, SessionDomain, SessionHooks, SessionModelRequest } from "@opencode/plugin/promise/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CheckpointConflictError, CheckpointStore } from "../src/checkpoints"
import { registerTransport, type TransportCompletion, type TransportOptions, type TransportRequest, type TransportState } from "../src/server-transport"
import { digest, record } from "../src/shared"
import type { Fetch } from "../src/transport"

type Hook<Event> = { providerID?: string; callback: (event: Event) => Promise<void> | void }

function hooks<Spec>() {
  const registrations: { [Name in keyof Spec]?: Hook<Spec[Name]>[] } = {}
  const hook: ModelHooks<Spec> = async (name, callback, options) => {
    const entry = { callback, providerID: options?.providerID }
    const entries = registrations[name] ??= []
    entries.push(entry)
    return { async dispose() { registrations[name] = registrations[name]?.filter((item) => item !== entry) } }
  }
  return {
    hook,
    async fire<Name extends keyof Spec>(name: Name, event: Spec[Name], providerID: string) {
      for (const { providerID: scope, callback } of registrations[name] ?? []) {
        if (scope === undefined || scope === providerID) await callback(event)
      }
    },
  }
}

const packageName = "@ai-sdk/openai-compatible"
const modelID = Model.ID.make("fixture-chat")
const sessionID = Session.ID.make(`ses_${"a".repeat(64)}`)
const otherSession = Session.ID.make(`ses_${"d".repeat(64)}`)
const userID = `msg_${"c".repeat(64)}`
const affinity = `ses_${"b".repeat(64)}`
const prompt = [{ role: "user", content: [{ type: "text", text: "ticket" }] }] satisfies Parameters<LanguageModelV3["doStream"]>[0]["prompt"]
const isFetch = (value: unknown): value is Fetch => typeof value === "function"

type Route = {
  readonly provider: string
  readonly path: string
  readonly query?: string
  readonly model?: string
  readonly streamUsage?: boolean
  readonly sdkUsage?: boolean
  readonly package?: string
  readonly headers?: Record<string, string>
  readonly kind?: SessionModelRequest["kind"]
  readonly limit?: Model.Info["limit"]
  readonly attestation?: "match" | "missing" | "duplicate"
  readonly overlay?: (body: Record<string, unknown>) => Record<string, unknown>
  readonly send: (request: Request, init?: RequestInit) => Response | Promise<Response>
}

const app = { name: "transport-test", version: "2.3.0", channel: "test" }

async function harness(routes: readonly Route[], state?: TransportState, compaction?: TransportOptions["compaction"]) {
  const directory = await mkdtemp(join(tmpdir(), "kv-v2-transport-"))
  const host = `https://${randomUUID()}.example`
  const hostMiddleware = new AsyncLocalStorage<{ readonly route: Route; readonly owner: SessionModelRequest }>()
  const session = hooks<SessionHooks>()
  const aisdk = hooks<AISDKHooks>()
  const catalog = new Map(routes.map((route) => [route, {
    ...Model.Info.default(Provider.ID.make(route.provider), Model.ID.make(route.model ?? modelID)),
    modelID,
    ...(route.limit === undefined ? {} : { limit: route.limit }),
    compatibility: { streamUsage: route.streamUsage },
    // The actual Model.list API returns the inherited provider package
    // on each model even when no package was set on its raw definition.
    package: route.package ?? `aisdk:${packageName}`,
  }]))
  const options: TransportOptions = {
    providers: routes.map((route) => route.provider),
    maxOutputTokens: 137, usageAccounting: true,
    compaction,
  }
  const location = { directory: AbsolutePath.make(directory) }
  const history: SessionDomain["context"] = async () => [
    { id: userID, type: "user", time: { created: 1 }, text: "ticket" },
    { id: "synthetic-notice", type: "synthetic", time: { created: 2 }, text: "Synthetic notice" },
  ]
  const context = {
    app, location, aisdk, session: { ...session, context: history },
    model: { list: async () => ({ location, data: [...catalog.values()] }) },
  }
  let dispose = await registerTransport(context, options, state)
  const sdks = new Map<string, ReturnType<typeof createOpenAICompatible>>()
  const languages = new Map<Route, LanguageModelV3>()
  const resolve = async (route: Route, model: Model.Info) => {
    const cached = languages.get(route)
    if (cached) return cached
    let provider = sdks.get(route.provider)
    if (!provider) {
      const fetch: Fetch = async (input, init) => {
        const middleware = hostMiddleware.getStore()
        if (!middleware) return route.send(new Request(input, init), init)
        const { route: selected, owner } = middleware
        const sdk = new Request(input, init)
        const body: unknown = await sdk.json()
        if (!record(body)) throw new Error("Expected SDK body")
        const request = new Request(`${host}/${selected.path}/chat/completions${new URL(sdk.url).search}`, {
          method: sdk.method,
          headers: sdk.headers,
          body: JSON.stringify(selected.overlay?.(body) ?? { ...body, max_completion_tokens: 999 }),
          signal: sdk.signal,
        })
        const before = { ...owner, request }
        await session.fire("http.request", before, owner.model.providerID)
        const response = await selected.send(before.request, init)
        const after = { ...before, response }
        await session.fire("http.response", after, owner.model.providerID)
        return after.response
      }
      const sdk: AISDKHooks["sdk"] = { model, package: packageName, options: { fetch, includeUsage: route.sdkUsage } }
      await aisdk.fire("sdk", sdk, route.provider)
      const intercepted: unknown = sdk.options.fetch
      if (!isFetch(intercepted)) throw new Error("Missing SDK fetch")
      provider = createOpenAICompatible({
        name: route.provider, baseURL: `${host}/${route.provider}/v1`, includeUsage: route.sdkUsage,
        queryParams: route.query ? { tenant: route.query } : undefined,
        fetch: Object.assign(intercepted, { preconnect: globalThis.fetch.preconnect }),
      })
      sdks.set(route.provider, provider)
    }
    const language: AISDKHooks["language"] = { model, options: {}, sdk: provider }
    await aisdk.fire("language", language, route.provider)
    const initialized = language.language ?? provider.languageModel(model.modelID)
    languages.set(route, initialized)
    return initialized
  }
  return {
    directory,
    async model(route: Route, stateless = false, ownerID = sessionID) {
      const model = catalog.get(route)
      if (!model) throw new Error("Route not in fixture catalog")
      // Core resolves the cached language before running the session hooks.
      const language = await resolve(route, model)
      if (stateless) return (await language.doStream({ prompt })).stream.getReader()
      const owner: SessionModelRequest = {
        sessionID: ownerID, model: { providerID: model.providerID, id: model.id }, kind: route.kind ?? "primary", agent: Agent.ID.make("build"),
        headers: { "x-opencode-session-id": ownerID, "x-session-affinity": affinity, ...route.headers },
      }
      let selectedPrompt: Parameters<LanguageModelV3["doStream"]>[0]["prompt"] = prompt
      if (route.attestation) {
        const user = Message.make({ role: "user", id: route.attestation === "missing" ? "other-user" : userID, content: "ticket" })
        const event: SessionContext = {
          sessionID: ownerID, model: owner.model, agent: owner.agent, options: {}, system: [],
          messages: [user, ...(route.attestation === "duplicate" ? [user] : [])], tools: {},
        }
        if (owner.kind === "primary") await session.fire("context", event, route.provider)
        // Core's AISDK bridge can append user roles that did not come from a
        // durable human user, including the wrapper and tool media below.
        selectedPrompt = [
          ...event.messages.flatMap((message) => message.role === "user"
            ? [{ role: "user" as const, content: message.content.flatMap((part) => part.type === "text"
              ? [{ type: "text" as const, text: part.text }] : []) }] : []),
          { role: "user", content: [{ type: "text", text: "<system-update>\npolicy\n</system-update>" }] },
          { role: "user", content: [{ type: "text", text: "Attached media from tool result:" }, {
            type: "file", mediaType: "image/png", data: new URL("https://example.invalid/tool.png"),
          }] },
          { role: "user", content: [{ type: "text", text: "Synthetic notice" }] },
        ]
      }
      await session.fire("model.request", owner, route.provider)
      return (await hostMiddleware.run({ route, owner }, () => language.doStream({ prompt: selectedPrompt, headers: owner.headers }))).stream.getReader()
    },
    async disable() {
      await dispose()
    },
    async enable(register: typeof registerTransport, policy: TransportState) {
      dispose = await register(context, { ...options, maxOutputTokens: 71 }, policy)
    },
    async close() {
      await dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function collect(reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

async function withinOverlapDeadline<T>(work: Promise<T>, message: string) {
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => deadline.reject(new Error(message)), 3000)
  try {
    return await Promise.race([work, deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

const chunks = [
  { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "a" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning_content: "b" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: { cached_tokens: 6 } } },
].map((part) => `data: ${JSON.stringify({ id: "reply", model: modelID, created: 1, ...part })}\n\n`).join("") + "data: [DONE]\n\n"
const sse = { "content-type": "text/event-stream" }

test("sessions stream concurrently at the exact same endpoint and publish separate replay receipts", async () => {
  const open = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const arrivals: Request[] = []
  const completed: Array<{ request: TransportRequest; receipt: TransportCompletion }> = []
  const first: Route = { provider: "first", path: "same", query: "a", send(request) {
    arrivals.push(request)
    return new Response(new ReadableStream({ start: open.resolve }), { headers: sse })
  } }
  const second: Route = { provider: "second", path: "same", query: "a", headers: { "x-litellm-session-id": "explicit" }, send(request) {
    arrivals.push(request)
    return new Response(chunks, { headers: sse })
  }, overlay: (body) => ({ ...body, reasoning_effort: "low", chat_template_kwargs: { clear_thinking: true } }) }
  const distinct: Route = { provider: "distinct", path: "other", query: "b", send(request) {
    arrivals.push(request)
    return new Response(chunks.replace("data: [DONE]\n\n", ""), { headers: sse })
  } }
  const host = await harness([first, second, distinct], { onComplete: (request, receipt) => { completed.push({ request, receipt }) } })
  try {
    const draining = host.model(first).then(collect)
    const overlapping = (async () => {
      const stream = await open.promise
      stream.enqueue(new TextEncoder().encode(chunks))
      await collect(await host.model(second, false, otherSession))
      await collect(await host.model(distinct))
      expect(completed.map(({ request }) => request.sessionID)).toEqual([otherSession])
      stream.close()
    })()
    const [parts] = await withinOverlapDeadline(
      Promise.all([draining, overlapping]), "Second session did not stream while the first response was open",
    )
    expect(parts.flatMap((part) => part.type === "reasoning-delta" ? [part.delta] : []).join("")).toBe("ab")
    expect(arrivals.map((request) => new URL(request.url).pathname)).toEqual(["/same/chat/completions", "/same/chat/completions", "/other/chat/completions"])
    expect(arrivals.map((request) => new URL(request.url).search)).toEqual(["?tenant=a", "?tenant=a", "?tenant=b"])
    expect(arrivals[0]?.url).toBe(arrivals[1]?.url)
    expect(arrivals.map(({ headers }) => headers.get("x-opencode-session-id"))).toEqual([sessionID, otherSession, sessionID])
    expect(arrivals.map(({ headers }) => headers.get("x-session-affinity"))).toEqual([affinity, affinity, affinity])
    expect(arrivals[0]?.headers.has("x-litellm-session-id")).toBe(false)
    expect(arrivals[1]?.headers.get("x-litellm-session-id")).toBe("explicit")
    expect(arrivals.flatMap((request) => [...request.headers.keys()].filter((name) => name.startsWith("x-opencode-kv-guard-")))).toEqual([])
    const wire = await arrivals[0]?.json()
    expect(wire).toMatchObject({ max_completion_tokens: 137, stream_options: { include_usage: true } })
    expect(wire).not.toHaveProperty("reasoning_effort")
    expect(wire).not.toHaveProperty("chat_template_kwargs")
    expect(await arrivals[1]?.json()).toMatchObject({
      reasoning_effort: "low", chat_template_kwargs: { clear_thinking: true },
    })
    expect(completed.map(({ request, receipt }) => [request.sessionID, request.providerID, receipt.promptTokens, receipt.cachedTokens])).toEqual([
      [otherSession, "second", 8, 6], [sessionID, "first", 8, 6],
    ])
    expect(completed[1]?.request.body).toEqual(wire)
    expect(completed[1]?.receipt).toMatchObject({ finishReason: "stop", assistant: { role: "assistant", content: "ok", reasoning_content: "ab" } })
    expect(completed[0]?.request.endpoint).toBe(completed[1]?.request.endpoint)
    expect(completed[0]?.request.lane).not.toBe(completed[1]?.request.lane)
  } finally {
    await host.close()
  }
})

test("interrupting the AI SDK stream aborts the provider request before headers", async () => {
  const active = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const routes: readonly [Route, Route] = [
    { provider: "active", path: "same", send: (_request, init) => {
      const signal = init?.signal
      if (!signal) throw new Error("Missing SDK abort signal")
      active.resolve()
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        stopped.resolve()
        reject(signal.reason)
      }, { once: true }))
    } },
    { provider: "after", path: "same", send: () => new Response(chunks, { headers: sse }) },
  ]
  const host = await harness(routes)
  try {
    const owner = await host.model(routes[0])
    const ownerRead = owner.read()
    await active.promise
    await owner.cancel("active interruption")
    await stopped.promise
    expect((await ownerRead).done).toBe(true)
    expect(await collect(await host.model(routes[1]))).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "ok" }))
  } finally {
    await host.close()
  }
})

test("a selected native package is rejected before its session request", async () => {
  const native: Route = {
    provider: "native", path: "native", package: "@opencode/ai/providers/openai-compatible",
    send: () => { throw new Error("Native request unexpectedly reached gateway") },
  }
  const host = await harness([native])
  try {
    await expect(host.model(native)).rejects.toThrow("must use aisdk:@ai-sdk/openai-compatible")
  } finally {
    await host.close()
  }
})

test("shared SDKs apply stream usage per selected catalog model", async () => {
  for (const sdkUsage of [undefined, true]) {
    const bodies: unknown[] = []
    const send: Route["send"] = async (request) => {
      bodies.push(await request.json())
      return new Response(chunks, { headers: sse })
    }
    const disabled: Route = { provider: "shared", path: "chat", model: "without-usage", streamUsage: false, sdkUsage, send }
    const enabled: Route = { ...disabled, model: "with-usage", streamUsage: true }
    const host = await harness([disabled, enabled])
    try {
      // The two catalog IDs even share the same upstream model name.
      await collect(await host.model(disabled))
      await collect(await host.model(enabled, true))
      expect(bodies.map((body) => record(body) ? body.stream_options : body)).toEqual([undefined, { include_usage: true }])
    } finally {
      await host.close()
    }
  }
})

test("cached languages use the new registration after module re-evaluation, without cancelling another location", async () => {
  const started = Promise.withResolvers<void>()
  const foreignStarted = Promise.withResolvers<AbortSignal>()
  const foreignBody = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const old: TransportRequest[] = []
  const current: TransportRequest[] = []
  const foreign: TransportRequest[] = []
  const bodies: unknown[] = []
  const route: Route = { provider: "reloaded", path: "chat", async send(request) {
    bodies.push(await request.json())
    if (bodies.length !== 2) return new Response(chunks, { headers: sse })
    started.resolve()
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
    })
  } }
  const otherRoute: Route = { ...route, send(request) {
    foreignStarted.resolve(request.signal)
    return new Response(new ReadableStream({ start: foreignBody.resolve }), { headers: sse })
  } }
  const host = await harness([route], { onRequest: (request) => { old.push(request) } })
  const other = await harness([otherRoute], { onRequest: (request) => { foreign.push(request) } })
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../src/server-transport.ts", import.meta.url))],
      target: "bun", outdir: host.directory, naming: "reload-[name].js",
    })
    const [artifact] = build.outputs
    if (!artifact) throw new Error("Missing independently bundled plugin module")
    const reloaded: typeof import("../src/server-transport") = await import(artifact.path)
    expect(reloaded.registerTransport).not.toBe(registerTransport)

    await collect(await host.model(route))
    const [completed] = old
    const pending = (await host.model(route)).read().catch((error: unknown) => error)
    const unstarted = await host.model(route)
    const foreignResult = collect(await other.model(otherRoute))
    const foreignSignal = await foreignStarted.promise
    await started.promise
    await host.disable()
    expect(await pending).toBeInstanceOf(Error)
    expect(completed?.signal.aborted).toBe(false)
    expect(foreignSignal.aborted).toBe(false)
    await host.enable(reloaded.registerTransport, { onRequest: (request) => { current.push(request) } })
    await collect(unstarted)
    await collect(await host.model(route, true))
    const stream = await foreignBody.promise
    stream.enqueue(new TextEncoder().encode(chunks))
    stream.close()
    await foreignResult
    expect(old.map(({ body }) => body.max_completion_tokens)).toEqual([137, 137])
    expect(current.map(({ body, kind }) => [body.max_completion_tokens ?? body.max_tokens, kind])).toEqual([[71, "primary"], [71, undefined]])
    expect(bodies.map((body) => record(body) ? body.max_completion_tokens ?? body.max_tokens : body)).toEqual([137, 137, 71, 71])
    expect(foreign.map(({ body }) => body.max_completion_tokens)).toEqual([137])
  } finally {
    await Promise.all([host.close(), other.close()])
  }
})

test("an unwrapped cached SDK cannot bypass active session transport", async () => {
  const arrivals: Request[] = []
  const route: Route = { provider: "warmed", path: "chat", send(request) {
    arrivals.push(request)
    return new Response(chunks, { headers: sse })
  } }
  const host = await harness([route])
  try {
    await host.disable()
    await collect(await host.model(route, true))
    await host.enable(registerTransport, {})
    await expect(host.model(route).then(collect)).rejects.toThrow("no matching SDK dispatch")
    expect(arrivals).toHaveLength(1)
  } finally {
    await host.close()
  }
})

const compactionLimit = { context: 16384, input: 12000, output: 4096 }

test("primary compaction sees the exact user, overlay and caps; summary reuses the native endpoint and credentials", async () => {
  const arrivals: Array<{ request: Request; body: unknown; init?: RequestInit }> = []
  const tools = [{ type: "function", function: { name: "never_execute", parameters: { type: "object" } } }]
  const route: Route = {
    provider: "attested", path: "effective", query: "tenant", limit: compactionLimit, attestation: "match",
    headers: { authorization: "Bearer fixture", "x-tenant-id": "tenant" },
    overlay: (body) => ({ ...body, max_completion_tokens: 999, cache_salt: "isolated", reasoning_effort: "high", tools }),
    async send(request, init) {
      const body: unknown = await request.json()
      arrivals.push({ request, body, init })
      if (record(body) && body.stream === false) {
        if (body.tool_choice === "none") return Response.json({ error: { message: "tool_choice none is not supported" } }, { status: 400 })
        return Response.json({ choices: [{ message: { role: "assistant", content: "history" }, finish_reason: "stop" }] })
      }
      return new Response(chunks, { headers: sse })
    },
  }
  let callbacks = 0
  let receipts = 0
  const host = await harness([route], {
    async onRequest(request) {
      callbacks++
      const capability = request.compaction
      expect(capability?.limits).toEqual({ ...compactionLimit, wireOutput: 137 })
      expect(capability?.currentUser).toBe(request.body.messages[0])
      expect(capability?.currentUser).toEqual({ role: "user", content: "ticket" })
      expect(request.body.messages.at(-1)).toEqual({ role: "user", content: "Synthetic notice" })
      const summary = await capability?.completeSummary({
        ...request.body, stream: false, tool_choice: "none", max_completion_tokens: 911,
      })
      expect(await summary?.json()).toMatchObject({ choices: [{ message: { content: "history" } }] })
      return { ...request.body, messages: [{ role: "system", content: "checkpoint" }, ...request.body.messages] }
    },
    onComplete() { receipts++ },
  }, {})
  try {
    await collect(await host.model(route))
    expect(callbacks).toBe(1)
    expect(receipts).toBe(1)
    expect(arrivals).toHaveLength(3)
    for (const { request, body, init } of arrivals) {
      expect(new URL(request.url).pathname).toBe("/effective/chat/completions")
      expect(new URL(request.url).search).toBe("?tenant=tenant")
      expect(request.headers.get("authorization")).toBe("Bearer fixture")
      expect(request.headers.get("x-tenant-id")).toBe("tenant")
      expect(request.headers.get("x-opencode-session-id")).toBe(sessionID)
      expect(request.headers.get("x-session-affinity")).toBe(affinity)
      expect(request.headers.has("x-litellm-session-id")).toBe(false)
      expect(init?.redirect).toBe("error")
      expect(JSON.stringify(body)).not.toContain("x-opencode-kv-guard-")
      expect(body).toMatchObject({ cache_salt: "isolated", reasoning_effort: "high" })
    }
    expect(arrivals.map(({ body }) => body)).toEqual([
      expect.objectContaining({ stream: false, tool_choice: "none", tools, max_completion_tokens: 911 }),
      expect.objectContaining({ stream: false, max_completion_tokens: 911 }),
      expect.objectContaining({ stream: true, tools, max_completion_tokens: 137, messages: expect.arrayContaining([{ role: "system", content: "checkpoint" }]) }),
    ])
    expect(arrivals[1]?.body).not.toHaveProperty("tools")
    expect(arrivals[1]?.body).not.toHaveProperty("stream_options")
  } finally {
    await host.close()
  }
})

test("unknown limits, unattested users, rewritten messages and auxiliary work do not activate compaction", async () => {
  const seen: TransportRequest[] = []
  const send: Route["send"] = () => new Response(chunks, { headers: sse })
  const routes: Route[] = [
    { provider: "default", path: "chat", limit: { context: 0, output: 0 }, attestation: "match", send },
    { provider: "missing", path: "chat", limit: compactionLimit, attestation: "missing", send },
    { provider: "duplicate", path: "chat", limit: compactionLimit, attestation: "duplicate", send },
    { provider: "invalid", path: "chat", limit: { ...compactionLimit, input: 0 }, attestation: "match", send },
    {
      provider: "rewritten", path: "chat", limit: compactionLimit, attestation: "match", send,
      overlay: (body) => ({ ...body, messages: [{ role: "user", content: "rewritten" }] }),
    },
    ...(["compaction", "title", "generate"] as const).map((kind): Route => ({
      provider: kind, kind, path: "chat", limit: compactionLimit, attestation: "match", send,
    })),
  ]
  const host = await harness(routes, { onRequest: (request) => { seen.push(request) } }, {})
  try {
    for (const route of routes) await collect(await host.model(route))
    await collect(await host.model(routes[0]!, true))
    expect(seen.map(({ providerID, kind, compaction }) => [providerID, kind, compaction])).toEqual([
      ...routes.map((route) => [route.provider, route.kind ?? "primary", undefined]),
      ["default", undefined, undefined],
    ])
  } finally {
    await host.close()
  }
})

test("provider overflow invokes one recovery against the original source and never substitutes a second error", async () => {
  const originalFailure = '\n{"error":{"message":"prompt has 19,000 tokens, but the configured context size is 16384 tokens","code":"context_length_exceeded"}}\n'
  for (const recover of [true, false]) {
    const seen: TransportRequest[] = []
    const wires: unknown[] = []
    const route: Route = {
      provider: "overflow", path: "chat", query: "same", limit: compactionLimit, attestation: "match",
      async send(request) {
        wires.push(await request.json())
        if (wires.length === 1) return new Response(originalFailure, { status: 400, headers: { "content-type": "application/json" } })
        if (!recover) return Response.json({ error: { message: "prompt is too long, second failure" } }, { status: 400 })
        return new Response(chunks, { headers: sse })
      },
    }
    const host = await harness([route], {
      onRequest(request) {
        seen.push(request)
        const text = request.compaction?.overflow ? "recovered" : "first projection"
        return { ...request.body, messages: [{ role: "system", content: text }, ...request.body.messages] }
      },
    }, {})
    try {
      const result = host.model(route).then(collect)
      if (recover) await expect(result).resolves.toContainEqual(expect.objectContaining({ type: "text-delta", delta: "ok" }))
      else await expect(result).rejects.toMatchObject({ statusCode: 400, responseBody: originalFailure })
      expect(seen).toHaveLength(2)
      expect(seen[0]?.compaction?.overflow).toBeUndefined()
      expect(seen[1]?.compaction?.overflow).toEqual({ promptTokens: 19000 })
      expect(seen[1]?.body).toEqual(seen[0]?.body)
      expect(seen[1]?.lane).toBe(seen[0]?.lane)
      expect(seen[1]?.id).not.toBe(seen[0]?.id)
      expect(wires).toEqual([
        expect.objectContaining({ messages: expect.arrayContaining([{ role: "system", content: "first projection" }]) }),
        expect.objectContaining({ messages: expect.arrayContaining([{ role: "system", content: "recovered" }]) }),
      ])
    } finally {
      await host.close()
    }
  }
})

test("a concurrent stale checkpoint is rejected before its primary provider send", async () => {
  const session = "overlapping-sessions"
  const checkpoint = { prefix: { version: 2 as const, session: digest(session), lanes: [] }, usage: { lanes: [] } }
  const arrivals: string[] = []
  const pending = Promise.withResolvers<void>()
  const winner = Promise.withResolvers<void>()
  const route: Route = {
    provider: "concurrent", path: "chat", limit: compactionLimit, attestation: "match",
    send(request) {
      arrivals.push(request.headers.get("x-kv-fixture") ?? "")
      return new Response(chunks, { headers: sse })
    },
  }
  const competing: Route = { ...route, provider: "competitor", headers: { "x-kv-fixture": "winner" } }
  let store: CheckpointStore
  const host = await harness([route, competing], {
    async onRequest(request) {
      const loaded = await store.load(session)
      if (request.providerID === route.provider) {
        pending.resolve()
        await winner.promise
      }
      await store.save(session, checkpoint, loaded.revision)
    },
  }, {})
  try {
    store = new CheckpointStore(join(host.directory, "checkpoints"), "fixture", "shared")
    const stale = host.model(route).then(collect).catch((error: unknown) => error)
    await pending.promise
    await collect(await host.model(competing))
    winner.resolve()
    expect(await stale).toBeInstanceOf(CheckpointConflictError)
    expect(arrivals).toEqual(["winner"])
  } finally {
    winner.resolve()
    await host.close()
  }
})

test("a summary can reach the same endpoint while another primary response is open", async () => {
  const open = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const sends: Array<{ readonly url: string; readonly streaming: boolean }> = []
  const completed: Array<TransportRequest["sessionID"]> = []
  const route: Route = {
    provider: "summarized", path: "chat", limit: compactionLimit, attestation: "match",
    async send(request) {
      const body: unknown = await request.json()
      if (!record(body) || typeof body.stream !== "boolean") throw new Error("Expected a provider request with a stream mode")
      sends.push({ url: request.url, streaming: body.stream })
      if (sends.length === 1) return new Response(new ReadableStream({ start: open.resolve }), { headers: sse })
      if (body.stream === false) return new Response("checkpoint")
      return new Response(chunks, { headers: sse })
    },
  }
  const host = await harness([route], {
    async onRequest(request) {
      if (request.sessionID !== otherSession) return
      const result = await request.compaction?.completeSummary({ ...request.body, stream: false })
      expect(await result?.text()).toBe("checkpoint")
    },
    onComplete(request) { completed.push(request.sessionID) },
  }, {})
  try {
    const first = host.model(route).then(collect)
    const overlapping = (async () => {
      const source = await open.promise
      await collect(await host.model(route, false, otherSession))
      expect(completed).toEqual([otherSession])
      source.enqueue(new TextEncoder().encode(chunks))
      source.close()
    })()
    await withinOverlapDeadline(
      Promise.all([first, overlapping]), "Summary did not finish while the first response was open",
    )
    expect(sends.map(({ streaming }) => streaming)).toEqual([true, false, true])
    expect(new Set(sends.map(({ url }) => url)).size).toBe(1)
    expect(completed).toEqual([otherSession, sessionID])
  } finally {
    await host.close()
  }
})

test("a local summary error stops the main request before any provider send or completion", async () => {
  let sends = 0
  let completions = 0
  const error = '{"error":{"message":"summary unavailable"}}'
  const route: Route = {
    provider: "state-error", path: "chat", limit: compactionLimit, attestation: "match",
    send() { sends++; return new Response(chunks, { headers: sse }) },
  }
  const host = await harness([route], {
    onRequest() { return new Response(error, { status: 503, headers: { "content-type": "application/json" } }) },
    onComplete() { completions++ },
  }, {})
  try {
    await expect(host.model(route).then(collect)).rejects.toMatchObject({ statusCode: 503, responseBody: error })
    expect(sends).toBe(0)
    expect(completions).toBe(0)
  } finally {
    await host.close()
  }
})
