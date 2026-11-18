import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from "@ai-sdk/provider"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { digest, record, type ChatBody } from "./shared"
import type { Fetch } from "./transport"

export const sessionMarker = "x-opencode-kv-guard-sdk-session"
const userMarker = "x-opencode-kv-guard-current-user"

export type SDKModel = {
  readonly providerID: string
  readonly id: string
  readonly streamUsage?: boolean
  readonly maxOutputTokens?: number
  readonly marksUser?: boolean
}
export type SDKRequest = {
  readonly model: SDKModel
  readonly bodyOverlay?: Readonly<Record<string, unknown>>
  readonly sdkUsage: boolean
  readonly inSession: boolean
  readonly user?: { readonly index: number; readonly messages: string }
  readonly send: Fetch
}
export type SDKActivation = {
  readonly providers: ReadonlySet<string>
  readonly fetch: (sdk: SDKRequest, input: RequestInfo | URL, init: RequestInit) => Promise<Response>
}
type SDKRoute = {
  readonly marker: string
  readonly call: AsyncLocalStorage<SDKModel>
  active?: SDKActivation
}

// Core caches SDKs and languages per location, not per plugin evaluation.
const routesKey = Symbol.for("opencode-kv-guard.sdk-routes")
const shared: typeof globalThis & { [routesKey]?: WeakMap<object, Map<string, SDKRoute>> } = globalThis
const routes = shared[routesKey] ??= new WeakMap<object, Map<string, SDKRoute>>()

export function sdkRoute(app: object, location: { readonly directory: string; readonly workspaceID?: string }) {
  const key = JSON.stringify([location.directory, location.workspaceID])
  const locations = routes.get(app) ?? new Map<string, SDKRoute>()
  routes.set(app, locations)
  const route: SDKRoute = locations.get(key) ?? { marker: randomUUID(), call: new AsyncLocalStorage<SDKModel>() }
  locations.set(key, route)
  return route
}

export function currentUserMarker(route: SDKRoute) {
  return `${userMarker}:${route.marker}`
}

export function routedSDKFetch(
  route: SDKRoute,
  sdk: Pick<SDKRequest, "bodyOverlay" | "send"> & {
    readonly providerID: string
    readonly options: Readonly<Record<string, unknown>>
  },
): Fetch {
  return async (input, init) => {
    const { providerID, bodyOverlay, options, send } = sdk
    const active = route.active
    const model = route.call.getStore()
    // Cached guarded SDKs must not fall through during the unload/reload gap.
    if (!active?.providers.has(providerID) || model?.providerID !== providerID) {
      throw new TypeError(`KV guard: ${providerID} has no matching active SDK transport`)
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const marker = headers.get(sessionMarker)
    if (marker !== null && marker !== route.marker) throw new TypeError("KV guard: SDK request does not match its session location")
    headers.delete(sessionMarker)
    let body = init?.body
    let user: SDKRequest["user"]
    if (model.marksUser) {
      // The SDK puts compatible provider metadata on the final wire
      // message. Consume it before even the host middleware can see it.
      if (typeof body !== "string") throw new TypeError("KV guard: cannot remove current-user attestation from an opaque SDK body")
      const value: unknown = JSON.parse(body)
      if (!record(value) || !Array.isArray(value.messages)) throw new TypeError("KV guard: cannot attest current user in an opaque SDK body")
      const indices: number[] = []
      for (const [index, message] of value.messages.entries()) {
        if (record(message) && Object.hasOwn(message, userMarker)) {
          if (message.role === "user" && message[userMarker] === route.marker) indices.push(index)
          delete message[userMarker]
        }
      }
      if (indices.length === 1) user = { index: indices[0]!, messages: digest(JSON.stringify(value.messages)) }
      body = JSON.stringify(value)
    }
    if (typeof body === "string" && body.includes(currentUserMarker(route))) {
      throw new TypeError("KV guard: a prompt rewrite made current-user attestation unsafe to forward")
    }
    return active.fetch(
      { model, bodyOverlay, user, inSession: marker === route.marker, sdkUsage: options.includeUsage !== false, send },
      input,
      { ...init, headers, body },
    )
  }
}

export function cancellableSDKStream(
  language: LanguageModelV3,
  route: SDKRoute,
  model: SDKModel,
): LanguageModelV3 {
  const runCall = <T>(options: LanguageModelV3CallOptions, operation: (call: LanguageModelV3CallOptions) => T) => {
    const attestation = currentUserMarker(route)
    const marked = options.prompt.flatMap((message) =>
      message.role === "user" ? message.content.filter((part) => part.type === "text" && part.text === attestation) : [])
    const marksUser = marked.length === 1 && options.headers?.[sessionMarker] === route.marker
    const prompt = marked.length === 0 ? options.prompt : options.prompt.map((message) => {
      if (message.role !== "user" || !message.content.some((part) => marked.includes(part))) return message
      const content = message.content.filter((part) => !marked.includes(part))
      if (!marksUser) return { ...message, content }
      const tag = { [userMarker]: route.marker }
      // OpenAI Compatible uses text-part metadata for its compact single
      // text representation, and message metadata for multipart users.
      const [part] = content
      if (content.length === 1 && part?.type === "text") {
        return { ...message, content: [{ ...part, providerOptions: {
          ...part.providerOptions, openaiCompatible: { ...part.providerOptions?.openaiCompatible, ...tag },
        } }] }
      }
      return { ...message, content, providerOptions: {
        ...message.providerOptions, openaiCompatible: { ...message.providerOptions?.openaiCompatible, ...tag },
      } }
    })
    return route.call.run({ ...model, marksUser, maxOutputTokens: options.maxOutputTokens }, () =>
      operation(prompt === options.prompt ? options : { ...options, prompt }))
  }
  return {
    specificationVersion: language.specificationVersion,
    provider: language.provider,
    modelId: language.modelId,
    get supportedUrls() { return language.supportedUrls },
    doGenerate: (options) => runCall(options, (call) => language.doGenerate(call)),
    async doStream(options) {
      if (options.abortSignal) return runCall(options, (call) => language.doStream(call))
      const abort = new AbortController()
      // OpenCode interrupts the returned stream, but the v2.3.0 bridge does
      // not pass its Effect's abort signal to doStream or await its headers
      // inside that stream. Return a cancellable stream before starting I/O.
      // Re-enter the host's per-request HTTP middleware context on first pull.
      const run = AsyncLocalStorage.snapshot()
      let source: Promise<ReadableStreamDefaultReader<LanguageModelV3StreamPart>> | undefined
      let metadata: Pick<LanguageModelV3StreamResult, "request" | "response"> | undefined
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          source ??= Promise.resolve(run(() => runCall({ ...options, abortSignal: abort.signal }, (call) => language.doStream(call))))
            .then(({ stream, request, response }) => {
              metadata = { request, response }
              return stream.getReader()
            })
          const reader = await source
          if (abort.signal.aborted) return
          const next = await reader.read()
          if (abort.signal.aborted) return
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        },
        async cancel(reason) {
          abort.abort(reason)
          // A pre-header abort rejects the SDK call; there is no reader to
          // cancel in that case. If headers won the race, cancel the reader.
          await source?.then((reader) => reader.cancel(reason), () => undefined)
        },
      }, { highWaterMark: 0 })
      return {
        stream,
        get request() { return metadata?.request },
        get response() { return metadata?.response },
      }
    },
  }
}

export function wireBody(
  body: ChatBody,
  maxOutputTokens: number | undefined,
  usage: "request" | "preserve" | "omit",
): ChatBody {
  const result = { ...body }
  for (const [camel, wire] of [
    ["promptCacheKey", "prompt_cache_key"], ["cacheSalt", "cache_salt"],
    ["chatTemplateKwargs", "chat_template_kwargs"], ["enableThinking", "enable_thinking"],
    ["preserveThinking", "preserve_thinking"], ["maxTokens", "max_tokens"],
    ["maxCompletionTokens", "max_completion_tokens"],
  ] as const) {
    if (!Object.hasOwn(result, camel)) continue
    const alias = result[camel]
    const standard = result[wire]
    if ((camel === "maxTokens" || camel === "maxCompletionTokens") && typeof alias === "number" && typeof standard === "number") {
      result[wire] = Math.min(alias, standard)
    } else if (!Object.hasOwn(result, wire)) result[wire] = alias
    delete result[camel]
  }
  if (result.stream === true) {
    if (usage === "request" && (result.stream_options === undefined || record(result.stream_options))) {
      result.stream_options = { include_usage: true, ...result.stream_options }
    } else if (usage === "omit" && record(result.stream_options)) {
      const { include_usage: _includeUsage, ...rest } = result.stream_options
      if (Object.keys(rest).length === 0) delete result.stream_options
      else result.stream_options = rest
    }
  }
  if (maxOutputTokens !== undefined) {
    const legacy = typeof result.max_tokens === "number" ? result.max_tokens : maxOutputTokens
    if (typeof result.max_completion_tokens === "number") {
      result.max_completion_tokens = Math.min(result.max_completion_tokens, legacy, maxOutputTokens)
      delete result.max_tokens
    } else {
      result.max_tokens = Math.min(legacy, maxOutputTokens)
    }
  }
  return result
}
