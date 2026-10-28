import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { ChatBody } from "./compaction"
import type { WireMessage } from "./prefix"

export type UsageRequest = { readonly startedAt: number }
export type UsageReport = {
  laneFingerprint: string
  label?: string
  status: number
  format: "sse" | "json" | "other"
  outcome: "complete" | "incomplete" | "aborted" | "cancelled" | "error"
  headerMs: number
  firstOutputMs?: number
  endMs: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
  anchorRecorded: boolean
}
export type ObserveResponseOptions = {
  body: ChatBody
  lane: string
  tracker: UsageTracker
  request?: UsageRequest
  signal?: AbortSignal
  label?: string
  transform?: (value: unknown) => unknown
  onReport?: (report: UsageReport) => void | Promise<void>
}

type Fingerprint = { policy: string; messages: string[] }
type Anchor = Fingerprint & { promptTokens: number }
type Lane = { latest: number; anchor?: Anchor }
type Pending = { lane: string; state: Lane; sequence: number; fingerprint: Fingerprint }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

function fingerprint(body: ChatBody): Fingerprint {
  const { messages, ...policy } = body
  // Include every non-message field: unknown template/provider policy must not
  // inherit an anchor merely because the model name stayed the same.
  return { policy: hash(JSON.stringify(policy)), messages: messages.map((message) => hash(JSON.stringify(message))) }
}

function prefix(anchor: Fingerprint, candidate: Fingerprint) {
  return anchor.policy === candidate.policy && anchor.messages.length <= candidate.messages.length && anchor.messages.every((message, index) => message === candidate.messages[index])
}

function accountable(message: WireMessage) {
  if (!["user", "assistant", "tool"].includes(message.role)) return false
  if (Object.keys(message).some((key) => !["role", "content", "name", "tool_calls", "tool_call_id", "reasoning_content", "reasoning"].includes(key))) return false
  for (const key of ["name", "tool_call_id", "reasoning_content", "reasoning"]) {
    if (message[key] !== undefined && message[key] !== null && typeof message[key] !== "string") return false
  }
  if (message.content !== undefined && message.content !== null && typeof message.content !== "string") {
    if (!Array.isArray(message.content) || !message.content.every((part) => record(part) && part.type === "text" && typeof part.text === "string" && Object.keys(part).every((key) => key === "type" || key === "text"))) return false
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.every((call) => record(call) && call.type === "function" && typeof call.id === "string" && Object.keys(call).every((key) => ["id", "type", "function"].includes(key)) && record(call.function) && typeof call.function.name === "string" && typeof call.function.arguments === "string" && Object.keys(call.function).every((key) => key === "name" || key === "arguments"))) return false
  }
  return true
}

export class UsageTracker {
  private readonly lanes = new Map<string, Lane>()
  private readonly pending = new WeakMap<UsageRequest, Pending>()
  private sequence = 0

  // Call before dispatch/admission, not when response headers arrive. Otherwise
  // an older slow request could appear newer than a request already completed.
  begin(body: ChatBody, lane: string): UsageRequest {
    let state = this.lanes.get(lane)
    if (!state) {
      state = { latest: 0 }
      this.lanes.set(lane, state)
    }
    const current = fingerprint(body)
    if (state.anchor && !prefix(state.anchor, current)) delete state.anchor
    state.latest = ++this.sequence
    const request = { startedAt: performance.now() }
    this.pending.set(request, { lane, state, sequence: state.latest, fingerprint: current })
    return request
  }

  record(request: UsageRequest, body: ChatBody, lane: string, promptTokens: number) {
    const pending = this.pending.get(request)
    this.pending.delete(request)
    if (!pending || !count(promptTokens) || pending.lane !== lane || this.lanes.get(lane) !== pending.state || pending.sequence !== pending.state.latest) return false
    const current = fingerprint(body)
    if (!prefix(pending.fingerprint, current) || current.messages.length !== pending.fingerprint.messages.length) return false
    pending.state.anchor = { ...pending.fingerprint, promptTokens }
    return true
  }

  estimate(body: ChatBody, lane: string, fallbackEstimator: (value: unknown) => number): number {
    const anchor = this.lanes.get(lane)?.anchor
    if (!anchor || !prefix(anchor, fingerprint(body))) return fallbackEstimator(body)
    if (anchor.messages.length === body.messages.length) return anchor.promptTokens
    if (!body.messages.slice(anchor.messages.length).every(accountable)) return fallbackEstimator(body)
    // Subtract estimates of two bodies with identical policy and identical old
    // messages. Only appended text/tool messages and their framing remain. Do
    // not infer image/audio/signed-reasoning token cost from serialized bytes.
    const whole = fallbackEstimator(body)
    const previous = fallbackEstimator({ ...body, messages: body.messages.slice(0, anchor.messages.length) })
    const delta = whole - previous
    return Number.isFinite(delta) && delta >= 0 ? anchor.promptTokens + Math.ceil(delta) : whole
  }

  delete(lane: string) { this.lanes.delete(lane) }
  clear() { this.lanes.clear() }
}

type Counts = Pick<UsageReport, "promptTokens" | "completionTokens" | "totalTokens" | "cachedTokens">
function usage(value: Record<string, unknown>): Counts {
  const result: Counts = {}
  for (const [source, target] of [["prompt_tokens", "promptTokens"], ["completion_tokens", "completionTokens"], ["total_tokens", "totalTokens"]] as const) {
    if (count(value[source])) result[target] = value[source]
  }
  const details = record(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined
  for (const candidate of [details?.cached_tokens, value.cached_tokens, value.prompt_cache_hit_tokens, value.cachedContentTokenCount, value.cache_read_input_tokens, value.cache_hit_tokens]) {
    if (!count(candidate)) continue
    result.cachedTokens = candidate
    break
  }
  // prompt_tokens already includes cached tokens. Cache hit aliases are
  // attribution only, never additions to or subtractions from the anchor.
  return result
}

function output(value: unknown) {
  if (!record(value)) return false
  if ([value.content, value.reasoning_content, value.reasoning, value.reasoning_text].some((part) => typeof part === "string" && part.length > 0)) return true
  if (Array.isArray(value.content) && value.content.some((part) => record(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0)) return true
  const calls = Array.isArray(value.tool_calls) ? value.tool_calls : record(value.function_call) ? [{ function: value.function_call }] : []
  return calls.some((call) => record(call) && (typeof call.id === "string" && call.id.length > 0 || record(call.function) && [call.function.name, call.function.arguments].some((part) => typeof part === "string" && part.length > 0)))
}

// Retain only the unfinished event, never an entire SSE response. Framing is
// scanned as bytes so untouched UTF-8 (and even invalid bytes) stays exact.
class Events {
  pending: Uint8Array = new Uint8Array(0)
  constructor(private readonly event: (frame: Uint8Array) => Uint8Array) {}

  push(chunk: Uint8Array, eof = false) {
    if (chunk.length) this.pending = Buffer.concat([this.pending, chunk])
    const frames: Uint8Array[] = []
    let start = 0
    let line = 0
    for (let index = 0; index < this.pending.length;) {
      const byte = this.pending[index]
      if (byte !== 10 && byte !== 13) { index++; continue }
      if (byte === 13 && index + 1 === this.pending.length && !eof) break
      const end = index + (byte === 13 && this.pending[index + 1] === 10 ? 2 : 1)
      if (index === line) {
        frames.push(this.event(this.pending.subarray(start, end)))
        start = end
      }
      line = end
      index = end
    }
    this.pending = this.pending.slice(start)
    return frames
  }

}

export function observeResponse(response: Response, options: ObserveResponseOptions): Response {
  const { body: prompt, lane, tracker, signal, transform } = options
  const request = options.request ?? tracker.begin(prompt, lane)
  const headerMs = Math.max(0, performance.now() - request.startedAt)
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  const format = contentType === "text/event-stream" ? "sse" : contentType === "application/json" || contentType?.endsWith("+json") ? "json" : "other"
  const counts: Counts = {}
  const choices = new Set<number>()
  const finishedChoices = new Set<number>()
  let firstOutputMs: number | undefined
  let terminal = false
  let invalid = false
  let reported = false
  let stopped = false
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const encoder = new TextEncoder()
  const inspect = (value: unknown) => {
    if (!record(value)) { invalid = true; return }
    if (value.error !== undefined && value.error !== null) invalid = true
    if (value.choices !== undefined && (!Array.isArray(value.choices) || value.choices.some((choice) => !record(choice)))) invalid = true
    const entries = Array.isArray(value.choices) ? value.choices.filter(record) : []
    const rawUsage = record(value.usage) ? value.usage : entries.length === 1 && record(entries[0]!.usage) ? entries[0]!.usage : undefined
    if (rawUsage) Object.assign(counts, usage(rawUsage))
    for (let offset = 0; offset < entries.length; offset++) {
      const choice = entries[offset]!
      const index = count(choice.index) ? choice.index : offset
      choices.add(index)
      if (choice.error !== undefined && choice.error !== null) invalid = true
      if (typeof choice.finish_reason === "string" && choice.finish_reason.length) {
        if (choice.finish_reason === "error") invalid = true
        else finishedChoices.add(index)
      }
      if (firstOutputMs === undefined && (output(choice.delta) || output(choice.message))) firstOutputMs = Math.max(0, performance.now() - request.startedAt)
    }
  }
  const normalize = (value: unknown) => {
    if (!transform) return undefined
    const before = JSON.stringify(value)
    const after = JSON.stringify(transform(value))
    if (after === undefined) throw new TypeError("Response transform must return a JSON value")
    return before === after || isDeepStrictEqual(JSON.parse(before), JSON.parse(after)) ? undefined : after
  }
  const events = new Events((frame) => {
    let text: string
    try { text = decoder.decode(frame) } catch { invalid = true; return frame }
    const lines = text.split(/(\r\n|\r|\n)/)
    const data: number[] = []
    const values: string[] = []
    for (let index = 0; index < lines.length; index += 2) {
      const line = index === 0 ? lines[index]!.replace(/^\uFEFF/, "") : lines[index]!
      const colon = line.indexOf(":")
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
      if (field === "event" && value === "error") invalid = true
      if (field !== "data") continue
      data.push(index)
      values.push(value)
    }
    if (!data.length) return frame
    const raw = values.join("\n")
    if (raw.trim() === "[DONE]") { terminal = true; return frame }
    let value: unknown
    try { value = JSON.parse(raw) } catch { invalid = true; return frame }
    inspect(value)
    const changed = normalize(value)
    if (changed === undefined) return frame
    for (let index = 0; index < data.length; index++) {
      const position = data[index]!
      const original = lines[position]!
      const prefix = original.startsWith("\uFEFF") ? "\uFEFF" : ""
      const space = original.replace(/^\uFEFF/, "").startsWith("data: ") ? " " : ""
      lines[position] = `${prefix}data:${space}${index === 0 ? changed : ""}`
    }
    return encoder.encode(lines.join(""))
  })
  const json: Uint8Array[] = []
  const finish = (outcome: UsageReport["outcome"]) => {
    if (reported) return
    reported = true
    signal?.removeEventListener("abort", abort)
    const anchorRecorded = outcome === "complete" && counts.promptTokens !== undefined && (counts.cachedTokens === undefined || counts.cachedTokens <= counts.promptTokens) && tracker.record(request, prompt, lane, counts.promptTokens)
    const report: UsageReport = {
      laneFingerprint: hash(lane), ...(options.label === undefined ? {} : { label: options.label }),
      status: response.status, format, outcome, headerMs,
      ...(firstOutputMs === undefined ? {} : { firstOutputMs }), endMs: Math.max(0, performance.now() - request.startedAt),
      ...counts, anchorRecorded,
    }
    // Diagnostics must not delay EOF/cancellation, propagate a rejection into
    // the response, or extend the admission gate's generation lifetime.
    if (options.onReport) queueMicrotask(() => {
      try { void Promise.resolve(options.onReport!(report)).catch(() => {}) } catch {}
    })
  }
  let controller: ReadableStreamDefaultController<Uint8Array>
  const reader = response.body?.getReader()
  const abort = () => {
    if (stopped) return
    stopped = true
    controller?.error(signal!.reason)
    void reader?.cancel(signal!.reason).catch(() => {})
    finish("aborted")
  }
  if (!reader) {
    finish(signal?.aborted ? "aborted" : response.ok ? "incomplete" : "error")
    return response
  }
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
    },
    async pull(value) {
      try {
        while (!stopped) {
          const item = await reader.read()
          if (stopped) return
          if (!item.done) {
            if (format === "sse") {
              const frames = events.push(item.value)
              if (transform) {
                for (const frame of frames) value.enqueue(frame)
                if (frames.length) return
                continue
              }
            } else if (format === "json") {
              json.push(item.value.slice())
              if (transform) continue
            }
            value.enqueue(item.value)
            return
          }
          if (format === "sse") {
            const frames = events.push(new Uint8Array(0), true)
            if (transform) for (const frame of frames) value.enqueue(frame)
            const remaining = events.pending
            if (/(?:^|[\r\n])(?:\uFEFF)?data(?::|[\r\n]|$)/.test(new TextDecoder().decode(remaining))) invalid = true
            if (transform && remaining.length) value.enqueue(remaining)
          } else if (format === "json") {
            const bytes = Buffer.concat(json)
            let changed: string | undefined
            let parsed: unknown
            try {
              parsed = JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, ""))
            } catch { invalid = true }
            if (!invalid) {
              inspect(parsed)
              terminal = true
              changed = normalize(parsed)
            }
            if (transform) value.enqueue(changed === undefined ? bytes : encoder.encode(changed))
          }
          const complete = terminal && !invalid && choices.size > 0 && [...choices].every((index) => finishedChoices.has(index))
          stopped = true
          value.close()
          finish(!response.ok || invalid ? "error" : complete ? "complete" : "incomplete")
        }
      } catch (error) {
        if (stopped) return
        stopped = true
        value.error(error)
        void reader.cancel(error).catch(() => {})
        finish(signal?.aborted ? "aborted" : "error")
      }
    },
    async cancel(reason) {
      if (stopped) return
      stopped = true
      try { await reader.cancel(reason) } finally { finish(signal?.aborted ? "aborted" : "cancelled") }
    },
  }, { highWaterMark: 0 })
  const headers = new Headers(response.headers)
  if (transform) headers.delete("content-length")
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}
