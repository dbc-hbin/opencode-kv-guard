import type { Plugin } from "@opencode/plugin"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { overflowPromptTokens, providerError } from "./compaction"
import type { CompactionOptions } from "./compaction-policy"
import { readEvidence, type ReadEvidence } from "./compaction-reads"
import { projectPrompt } from "./prompt-projection"
import { digest, record, type ChatBody } from "./shared"
import { cancellableSDKStream, currentUserMarker, routedSDKFetch, sdkRoute, sessionMarker, wireBody, type SDKActivation, type SDKModel } from "./server-sdk-stream"
import { cancellableResponse, inspectErrorBody, type Fetch } from "./transport"
import { observeResponse, type ObservedCompletion } from "./usage"

export type TransportOptions = {
  readonly providers: readonly string[]
  readonly maxOutputTokens?: number
  readonly usageAccounting: boolean
  readonly compaction?: CompactionOptions
  readonly speculativeCompaction?: boolean
  readonly supersedeReads?: boolean
  readonly compactPrompt?: boolean
  readonly compactTools?: boolean
  readonly compactSkills?: boolean
}

type SessionOwner = {
  readonly sessionID?: string
  readonly agent?: string
  readonly kind?: "primary" | "compaction" | "title" | "generate"
}

export type TransportRequest = SessionOwner & {
  readonly id: string
  readonly providerID: string
  readonly modelID?: string
  /** Digest of the actual endpoint without credentials. */
  readonly endpoint: string
  readonly lane: string
  readonly headScope: string
  readonly body: ChatBody
  readonly signal: AbortSignal
  readonly compaction?: {
    readonly limits: { readonly context: number; readonly input?: number; readonly output: number; readonly wireOutput: number }
    readonly currentUser: ChatBody["messages"][number]
    readonly readEvidence?: ReadEvidence
    readonly completeSummary: (body: ChatBody, signal?: AbortSignal) => Promise<Response>
    readonly backgroundSummary?: (body: ChatBody, signal: AbortSignal) => Promise<Response>
    readonly overflow?: { readonly promptTokens?: number }
  }
}

export type TransportCompletion = ObservedCompletion

export type TransportState = {
  readonly onRequest?: (request: TransportRequest) => ChatBody | Response | void | Promise<ChatBody | Response | void>
  readonly onComplete?: (request: TransportRequest, receipt: TransportCompletion) => void | Promise<void>
}

const compatible = "@ai-sdk/openai-compatible"
const isCompatible = (pkg?: string) => pkg === compatible || pkg?.startsWith(`${compatible}@`) === true
const isCompatibleModel = (pkg?: string) => pkg?.startsWith("aisdk:") === true && isCompatible(pkg.slice("aisdk:".length))
const isFetch = (value: unknown): value is Fetch => typeof value === "function"
const isChatEndpoint = (url: URL, method: string) =>
  (url.protocol === "http:" || url.protocol === "https:") && method.toUpperCase() === "POST"
  && url.pathname.replace(/\/+$/, "").endsWith("/chat/completions")
const isChatBody = (value: unknown): value is ChatBody => record(value) && typeof value.model === "string"
  && Array.isArray(value.messages) && value.messages.every((message: unknown) => record(message) && typeof message.role === "string")
const positiveLimit = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const providerErrorStatus = (status: number) => status === 400 || status === 413 || status === 422

function modelLimits(limits: unknown, body: ChatBody, callOutput?: number) {
  if (!record(limits)) return
  const { context, input, output } = limits
  if (!positiveLimit(context) || !positiveLimit(output) || (input !== undefined && !positiveLimit(input))) return
  const caps = [body.max_completion_tokens, body.max_tokens].filter((cap) => cap !== undefined)
  if (caps.length > 1 && caps[0] !== caps[1]) return
  const wireOutput = caps.length ? caps[0] : callOutput ?? output
  if (positiveLimit(wireOutput) && wireOutput < context) return { context, input, output, wireOutput }
}

const variableHeaders = new Set([
  "content-length", "x-opencode-request", "x-opencode-session-id", "x-opencode-parent-session-id",
  "x-opencode-session", "x-parent-session-id", "x-session-id", "x-session-affinity",
])

function mergeBody(base: Readonly<Record<string, unknown>>, overlay: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries([...Object.entries(base), ...Object.entries(overlay).map(([key, value]) => {
    const previous = base[key]
    return [key, value === undefined ? previous : record(previous) && record(value) ? mergeBody(previous, value) : value]
  })])
}

type Dispatch = {
  readonly model: SDKModel
  readonly prepare: (request: Request, owner?: HttpOwner) => Promise<Request>
  readonly verify: (request: Request) => void
}

type Context = Pick<Plugin.Context, "aisdk" | "app"> & {
  readonly location: Pick<Plugin.Context["location"], "directory" | "workspaceID">
  readonly session: Pick<Plugin.Context["session"], "hook" | "context">
  readonly model: Pick<Plugin.Context["model"], "list">
}
type HttpOwner = Omit<SessionOwner, "sessionID"> & {
  readonly sessionID: Parameters<Context["session"]["context"]>[0]["sessionID"]
}

export async function registerTransport(ctx: Context, options: TransportOptions, state: TransportState = {}) {
  const providers = new Set(options.providers)
  const route = sdkRoute(ctx.app, ctx.location)
  const inFlight = new Set<AbortController>()
  const lifetime = new AbortController()
  const dispatch = new AsyncLocalStorage<Dispatch>()
  // OpenCode's cached SDK fetch reads session HTTP middleware from async
  // context. Auxiliary sends use the same fetch without reentering that hook.
  const outsideRequest = AsyncLocalStorage.snapshot()
  const catalogModel = async (ref: SDKModel) =>
    (await ctx.model.list()).data.find((model) => model.providerID === ref.providerID && model.id === ref.id)

  const promptOptions = {
    compactPrompt: options.compactPrompt === true,
    compactTools: options.compactTools === true,
    compactSkills: options.compactSkills === true,
  }
  const editContext = options.compaction || Object.values(promptOptions).some(Boolean)
  const session = await Promise.all([...providers].flatMap((providerID) => [
    ...(editContext ? [ctx.session.hook("context", async (event) => {
      projectPrompt(event, promptOptions)
      if (!options.compaction) return
      // Provider-facing user roles aren't authority: core lowers tool media
      // and chronological system updates to user messages, and other stored
      // events also project as user. Compare the actual durable user ID.
      const history = await ctx.session.context({ sessionID: event.sessionID }).catch(() => undefined)
      const user = history?.findLast((message) => message.type === "user")
      if (!user) return
      const matching = event.messages.filter((message) => message.id === user.id)
      const [message] = matching
      if (matching.length !== 1 || message?.role !== "user" || !message.content.length) return
      event.messages[event.messages.indexOf(message)] = {
        ...message, content: [...message.content, { type: "text", text: currentUserMarker(route) }],
      }
    }, { providerID })] : []),
    ctx.session.hook("model.request", async (event) => {
      const model = await catalogModel(event.model)
      if (!isCompatibleModel(model?.package)) {
        throw new TypeError(`KV guard: ${providerID}/${event.model.id} must use aisdk:${compatible}`)
      }
      event.headers[sessionMarker] = route.marker
    }, { providerID }),
    ctx.session.hook("http.request", async (event) => {
      const pending = dispatch.getStore()
      // Core skips our SDK factory hook when a model was cached before enable.
      // Reject that session before I/O instead of silently sending unguarded.
      if (pending?.model.providerID !== event.model.providerID || pending.model.id !== event.model.id) {
        throw new TypeError("KV guard: HTTP request has no matching SDK dispatch")
      }
      event.request = await pending.prepare(event.request, {
        sessionID: event.sessionID, agent: event.agent, kind: event.kind,
      })
    }, { providerID }),
    ctx.session.hook("http.response", async (event) => {
      const pending = dispatch.getStore()
      try {
        if (pending?.model.providerID !== event.model.providerID || pending.model.id !== event.model.id) {
          throw new TypeError("KV guard: HTTP response has no matching SDK dispatch")
        }
        pending.verify(event.request)
      } catch (error) {
        await event.response.body?.cancel(error)
        throw error
      }
    }, { providerID }),
  ]))

  const activation: SDKActivation = {
    providers,
    async fetch({ model, inSession, bodyOverlay, sdkUsage, user, send }, input, init) {
      const url = new URL(input instanceof Request ? input.url : input)
      const method = init.method ?? (input instanceof Request ? input.method : "GET")
      if (!isChatEndpoint(url, method)) throw new TypeError("KV guard: expected an SDK Chat Completions endpoint")
      const providerID = model.providerID
      const abort = new AbortController()
      inFlight.add(abort)
      const originalSignal = init.signal ?? (input instanceof Request ? input.signal : undefined)
      const signal = originalSignal ? AbortSignal.any([originalSignal, abort.signal]) : abort.signal
      let mainBinding: string | undefined
      let firstBody: string | undefined

      const attempt = async (overflow?: NonNullable<TransportRequest["compaction"]>["overflow"]): Promise<{
        response: Response; outgoing?: TransportRequest
      }> => {
        const stop = new AbortController()
        const attemptSignal = AbortSignal.any([signal, stop.signal])
        // Do not forward credentials or request state to another endpoint.
        const guardedInit = { ...init, redirect: "error" as const, signal: attemptSignal }
        let outgoing: TransportRequest | undefined
        let prepared: Request | undefined
        let shortCircuit: Response | undefined
        let entered = false
        const localResponse = new Error("KV guard: state supplied an HTTP response without dispatch")

        const prepare: Dispatch["prepare"] = async (request, owner) => {
          const endpoint = new URL(request.url)
          if (!isChatEndpoint(endpoint, request.method)) throw new TypeError("KV guard: HTTP hook changed the SDK chat endpoint to a different protocol")
          if (entered) throw new TypeError("KV guard: duplicate SDK HTTP dispatch")
          entered = true
          const requestSignal = AbortSignal.any([attemptSignal, request.signal])
          requestSignal.throwIfAborted()
          const parsed: unknown = await request.json()
          // The session middleware sees OpenCode's merged body. Stateless
          // callers have no middleware: apply the same overlay before policy.
          const merged = !inSession && bodyOverlay && record(parsed) ? mergeBody(parsed, bodyOverlay) : parsed
          if (!isChatBody(merged)) throw new TypeError("KV guard: expected an OpenAI Chat Completions request")
          const current = merged.stream === true ? await catalogModel(model) : undefined
          const streamUsage = current ? current.compatibility?.streamUsage : model.streamUsage
          const usage = streamUsage === false ? "omit" : options.usageAccounting && sdkUsage ? "request" : "preserve"
          const adjusted = wireBody(merged, options.maxOutputTokens, usage)
          const sentHeaders = new Headers(request.headers)
          sentHeaders.delete(sessionMarker)
          const sessionID = owner?.sessionID ?? sentHeaders.get("x-opencode-session-id") ?? undefined
          const endpointID = digest(endpoint.origin + endpoint.pathname.replace(/\/+$/, "") + endpoint.search)
          const headScope = digest(JSON.stringify([providerID, endpointID, adjusted.model, [...sentHeaders].filter(([name]) => !variableHeaders.has(name))]))
          const lane = digest(JSON.stringify([headScope, sessionID, owner?.agent, owner?.kind]))
          sentHeaders.delete("content-length")

          const currentUser = options.compaction && owner?.kind === "primary" && adjusted.stream === true
            && user && user.messages === digest(JSON.stringify(adjusted.messages)) ? adjusted.messages[user.index] : undefined
          // A provider overlay may change the wire model. A catalog budget is
          // valid only for the SDK model that actually produced this body.
          const served = current && (current.modelID ?? current.id) === adjusted.model && isCompatibleModel(current.package)
            ? current : undefined
          const limits = currentUser && served ? modelLimits(served.limit, adjusted, model.maxOutputTokens) : undefined
          // A workspace may resolve read paths on another filesystem.
          const reads = currentUser && limits && owner && options.supersedeReads && ctx.location.workspaceID === undefined
            ? await ctx.session.context({ sessionID: owner.sessionID }).then(readEvidence, () => undefined)
            : undefined
          const compaction: TransportRequest["compaction"] = currentUser?.role === "user" && limits ? (() => {
            const summarize = async (candidate: ChatBody, signal: AbortSignal, retryWithoutTools: boolean) => {
              if (candidate.model !== adjusted.model || candidate.stream !== false
                || candidate.tools !== undefined && candidate.tool_choice !== "none"
                || candidate.functions !== undefined || candidate.function_call !== undefined) {
                throw new TypeError("KV guard: expected a non-streaming summary with tools disabled on the selected model")
              }
              const summary = wireBody(candidate, limits.output, "omit")
              delete summary.stream_options
              const submit = async (body: ChatBody) => {
                signal.throwIfAborted()
                // Byte bodies prevent host model.body from undoing the
                // summary's message, cap and no-tools policy. The original
                // fetch still runs the host's timeout, TLS and sender setup.
                const response = await outsideRequest(() => send(request.url, {
                  ...guardedInit, method: request.method, headers: sentHeaders,
                  body: new TextEncoder().encode(JSON.stringify(body)), signal,
                }))
                return cancellableResponse(response, signal)
              }
              const response = await submit(summary)
              if (!retryWithoutTools || summary.tool_choice !== "none" || summary.tools === undefined || !providerErrorStatus(response.status) || response.status === 413) return response
              const inspected = await inspectErrorBody(response)
              if (!inspected.bytes) return inspected.response
              const failure = await providerError(inspected.response.clone())
              if (failure?.overflow || !failure || !/\btool[_ ]choice\b/i.test(failure.text)
                || !/\bnone\b/i.test(failure.text) || !/\b(?:invalid|unsupported|not\s+(?:supported|allowed))\b/i.test(failure.text)) return inspected.response
              await inspected.response.body?.cancel()
              const { tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallel, ...withoutTools } = summary
              return submit(withoutTools)
            }
            return {
              limits, currentUser, overflow, readEvidence: reads,
              completeSummary: (candidate, signal) =>
                summarize(candidate, signal ? AbortSignal.any([requestSignal, signal]) : requestSignal, true),
              backgroundSummary: options.speculativeCompaction ? (candidate, signal) =>
                summarize(candidate, AbortSignal.any([lifetime.signal, signal]), false) : undefined,
            } satisfies NonNullable<TransportRequest["compaction"]>
          })() : undefined
          if (compaction) {
            const binding = digest(JSON.stringify([request.url, request.method, lane, [...sentHeaders], adjusted, limits]))
            if (!overflow) mainBinding = binding
            else if (binding !== mainBinding) throw new Error("KV guard: provider overflow recovery changed request binding")
          } else if (overflow) throw new Error("KV guard: provider overflow recovery lost its compaction authority")
          const staged: TransportRequest = {
            ...owner, sessionID, id: randomUUID(), providerID, modelID: served?.id, endpoint: endpointID, lane, headScope,
            body: adjusted, signal: requestSignal, compaction,
          }
          requestSignal.throwIfAborted()
          const result = await state.onRequest?.(staged)
          if (requestSignal.aborted && result instanceof Response) await result.body?.cancel(requestSignal.reason)
          requestSignal.throwIfAborted()
          if (result instanceof Response) {
            shortCircuit = result
            // The public request hook can replace Request but cannot return
            // a Response. Reject the host send and unwrap our local response
            // at the surrounding SDK fetch boundary, with no provider I/O.
            throw localResponse
          }
          const body = result ?? adjusted
          const wire = JSON.stringify(body)
          if (overflow && digest(wire) === firstBody) throw new Error("KV guard: provider overflow recovery made no change")
          if (!overflow && compaction) firstBody = digest(wire)
          outgoing = { ...staged, body, compaction: undefined }
          prepared = new Request(request.url, { method: request.method, headers: sentHeaders, body: wire, signal: requestSignal })
          return prepared
        }

        try {
          attemptSignal.throwIfAborted()
          let response: Response
          if (inSession) {
            response = await dispatch.run({
              model, prepare,
              verify(request) {
                if (request !== prepared) throw new TypeError("KV guard: a later HTTP hook replaced the prepared SDK request")
              },
            }, () => send(input, guardedInit))
          } else {
            const request = await prepare(new Request(input, guardedInit))
            response = await send(request.url, { ...guardedInit, method: request.method, headers: request.headers, body: await request.arrayBuffer() })
          }
          if (!outgoing || !prepared || shortCircuit) {
            await response.body?.cancel()
            throw new TypeError("KV guard: OpenCode did not run the SDK session HTTP hook")
          }
          return { response, outgoing }
        } catch (error) {
          if (shortCircuit && !attemptSignal.aborted) return { response: shortCircuit }
          stop.abort(error)
          await shortCircuit?.body?.cancel(error).catch(() => {})
          throw error
        }
      }

      try {
        let { response, outgoing: final } = await attempt()
        if (state.onRequest && final && firstBody !== undefined && providerErrorStatus(response.status)) {
          const original = await inspectErrorBody(cancellableResponse(response, signal))
          response = original.response
          const failure = original.bytes ? await providerError(response.clone()) : undefined
          if (failure?.overflow) {
            // A bounded detached error has already reached physical EOF.
            // Re-enter the SDK host middleware with the original input; never
            // compact the prior projection or reuse its response stream.
            try {
              const retried = await attempt({ promptTokens: overflowPromptTokens(failure.text) })
              if (retried.outgoing && retried.response.ok) {
                await response.body?.cancel()
                response = retried.response
                final = retried.outgoing
              } else await retried.response.body?.cancel()
            } catch {
              signal.throwIfAborted()
            }
          }
        }
        const completed = final
        if (completed && state.onComplete) response = observeResponse(response, (completion) => {
          if (!signal.aborted) return state.onComplete?.(completed, completion)
        })
        return cancellableResponse(response, signal, () => { inFlight.delete(abort) })
      } catch (error) {
        abort.abort(error)
        inFlight.delete(abort)
        throw error
      }
    },
  }
  const sdk = await ctx.aisdk.hook("sdk", (event) => {
    const { providerID, body: bodyOverlay } = event.model
    if (!providers.has(providerID)) return
    if (!isCompatible(event.package)) throw new TypeError(`KV guard: ${providerID} must use aisdk:${compatible}`)
    // A constructed SDK cannot be retrofitted with a different fetch.
    if (event.sdk !== undefined) throw new TypeError(`KV guard: ${providerID} initialized its SDK before transport registration`)
    const send: unknown = event.options.fetch
    if (!isFetch(send)) throw new TypeError(`KV guard: ${providerID} has no OpenCode SDK fetch`)
    event.options.fetch = routedSDKFetch(route, { providerID, bodyOverlay, options: event.options, send })
  })

  const language = await ctx.aisdk.hook("language", (event) => {
    if (!providers.has(event.model.providerID) || !isCompatibleModel(event.model.package)) return
    const language: LanguageModelV3 = event.language ?? event.sdk.languageModel(event.model.modelID ?? event.model.id)
    const { providerID, id, compatibility } = event.model
    event.language = cancellableSDKStream(language, route, { providerID, id, streamUsage: compatibility?.streamUsage })
  })
  route.active = activation
  return async () => {
    if (route.active === activation) delete route.active
    lifetime.abort()
    for (const request of inFlight) request.abort()
    await Promise.all([language.dispose(), sdk.dispose(), ...session.map((registration) => registration.dispose())])
  }
}
