import { randomUUID } from "node:crypto"
import type { WireMessage } from "./prefix"
import { digest as hash, isSha256, record, uuidV4, type ChatBody } from "./shared"

type Counts = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

export type ObservedCompletion = Readonly<Counts & { assistant?: WireMessage; finishReason?: string }>

type Fingerprint = { policy: string; messages: string[] }
type Anchor = Fingerprint & { promptTokens: number }
type Lane = { latest: number; anchor?: Anchor; receipt?: string }
type Pending = { lane: string; state: Lane; sequence: number; receipt?: string; fingerprint: Fingerprint }
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

export type UsageSnapshot = { readonly lanes: readonly { readonly lane: string; readonly anchor?: Anchor; readonly receipt?: string }[] }

export function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!record(value) || Object.keys(value).some((key) => key !== "lanes") || !Array.isArray(value.lanes)) return false
  const lanes = new Set<string>()
  return value.lanes.every((entry) => {
    if (!record(entry) || Object.keys(entry).some((key) => !["lane", "anchor", "receipt"].includes(key)) || !isSha256(entry.lane) || lanes.has(entry.lane)) return false
    lanes.add(entry.lane)
    if (entry.receipt !== undefined && (typeof entry.receipt !== "string" || !uuidV4.test(entry.receipt))) return false
    const anchor = entry.anchor
    if (anchor === undefined) return entry.receipt !== undefined
    return record(anchor) && Object.keys(anchor).every((key) => ["policy", "messages", "promptTokens"].includes(key))
      && isSha256(anchor.policy) && Array.isArray(anchor.messages) && anchor.messages.every(isSha256) && count(anchor.promptTokens)
  })
}

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
    if (!Array.isArray(message.content)) return false
    if (!message.content.every((part) => {
      if (!record(part) || part.type !== "text") return false
      if (typeof part.text !== "string") return false
      return Object.keys(part).every((key) => key === "type" || key === "text")
    })) return false
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) return false
    if (!message.tool_calls.every((call) => {
      if (!record(call) || call.type !== "function" || typeof call.id !== "string") return false
      if (Object.keys(call).some((key) => !["id", "type", "function"].includes(key))) return false
      if (!record(call.function)) return false
      if (typeof call.function.name !== "string" || typeof call.function.arguments !== "string") return false
      return Object.keys(call.function).every((key) => key === "name" || key === "arguments")
    })) return false
  }
  return true
}

export class UsageTracker {
  private readonly lanes = new Map<string, Lane>()
  private readonly pending = new WeakMap<object, Pending>()
  private sequence = 0

  snapshot(lanes: Iterable<string>): UsageSnapshot {
    return { lanes: [...lanes].sort().flatMap((lane) => {
      const state = this.lanes.get(lane)
      return state && (state.anchor || state.receipt) ? [{
        lane, ...(state.anchor ? { anchor: structuredClone(state.anchor) } : {}),
        ...(state.receipt ? { receipt: state.receipt } : {}),
      }] : []
    }) }
  }

  prepare(lane: string, receipt: string = randomUUID()) {
    const state = this.lanes.get(lane) ?? { latest: 0 }
    state.receipt = receipt
    this.lanes.set(lane, state)
    return state.receipt
  }

  restore(snapshot: UsageSnapshot, replace: Iterable<string> = []) {
    // Restore only this session's anchors. Keep lane objects and dispatch
    // sequences intact so in-flight responses still obey newest-dispatch wins.
    for (const lane of replace) {
      const state = this.lanes.get(lane)
      if (state) { delete state.anchor; delete state.receipt }
    }
    for (const { lane, anchor, receipt } of snapshot.lanes) {
      let state = this.lanes.get(lane)
      if (!state) { state = { latest: 0 }; this.lanes.set(lane, state) }
      if (anchor) state.anchor = structuredClone(anchor)
      else delete state.anchor
      if (receipt) state.receipt = receipt
      else delete state.receipt
    }
  }

  // Call before dispatch, not when response headers arrive. Otherwise
  // an older slow request could appear newer than a request already completed.
  begin(body: ChatBody, lane: string, receipt?: string): object {
    const request = {}
    let state = this.lanes.get(lane)
    // A request can pause between preparation and dispatch while another
    // preparation reloads this lane. Never borrow that newer request's receipt
    // or invalidate its anchor with a superseded request body.
    if (receipt !== state?.receipt) return request
    if (!state) {
      state = { latest: 0 }
      this.lanes.set(lane, state)
    }
    const current = fingerprint(body)
    if (state.anchor && !prefix(state.anchor, current)) delete state.anchor
    state.latest = ++this.sequence
    this.pending.set(request, { lane, state, sequence: state.latest, receipt, fingerprint: current })
    return request
  }

  record(request: object, body: ChatBody, lane: string, promptTokens: number) {
    const pending = this.pending.get(request)
    this.pending.delete(request)
    if (!pending || !count(promptTokens) || pending.lane !== lane || this.lanes.get(lane) !== pending.state || pending.sequence !== pending.state.latest || pending.receipt !== pending.state.receipt) return false
    const current = fingerprint(body)
    if (!prefix(pending.fingerprint, current) || current.messages.length !== pending.fingerprint.messages.length) return false
    pending.state.anchor = { ...pending.fingerprint, promptTokens }
    return true
  }

  estimate(body: ChatBody, lane: string, fallbackEstimator: (value: ChatBody) => number): number {
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

// Retain only the unfinished event, never an entire SSE response. Framing is
// scanned as bytes so untouched UTF-8 (and even invalid bytes) stays exact.
class Events {
  pending: Uint8Array = new Uint8Array(0)
  constructor(private readonly event: (frame: Uint8Array) => void) {}

  push(chunk: Uint8Array, eof = false) {
    if (chunk.length) this.pending = Buffer.concat([this.pending, chunk])
    let start = 0
    let line = 0
    for (let index = 0; index < this.pending.length;) {
      const byte = this.pending[index]
      if (byte !== 10 && byte !== 13) { index++; continue }
      if (byte === 13 && index + 1 === this.pending.length && !eof) break
      const end = index + (byte === 13 && this.pending[index + 1] === 10 ? 2 : 1)
      if (index === line) {
        this.event(this.pending.subarray(start, end))
        start = end
      }
      line = end
      index = end
    }
    this.pending = this.pending.slice(start)
  }
}

export function observeResponse(response: Response, onComplete: (receipt: ObservedCompletion) => void | Promise<void>): Response {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  const format = contentType === "text/event-stream" ? "sse" : contentType === "application/json" || contentType?.endsWith("+json") ? "json" : "other"
  if (!response.ok || !response.body || format === "other") return response
  const reader = response.body.getReader()
  const counts: Counts = {}
  const choices = new Set<number>()
  const finishedChoices = new Set<number>()
  let terminal = false
  let invalid = false
  let stopped = false
  let replayable = true
  let finishReason: unknown
  const assistant: WireMessage = { role: "assistant", content: "" }
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>()
  const collect = (value: unknown) => {
    if (!record(value) || !Array.isArray(value.choices)) return
    for (const choice of value.choices) {
      if (!record(choice) || choice.index !== undefined && choice.index !== 0 || value.choices.length > 1) { replayable = false; continue }
      if (choice.finish_reason != null) finishReason = choice.finish_reason
      const part = choice.message ?? choice.delta
      if (!record(part)) continue
      if (Object.keys(part).some((key) => !["role", "content", "reasoning", "reasoning_content", "tool_calls"].includes(key))) replayable = false
      if (part.role !== undefined && part.role !== "assistant") replayable = false
      for (const key of ["content", "reasoning_content"]) {
        const text = key === "reasoning_content" ? part.reasoning_content ?? part.reasoning : part[key]
        if (text == null) continue
        if (typeof text !== "string") { replayable = false; continue }
        assistant[key] = choice.message ? text : String(assistant[key] ?? "") + text
      }
      if (part.reasoning != null && part.reasoning_content != null && part.reasoning !== part.reasoning_content) replayable = false
      if (part.tool_calls == null) continue
      if (!Array.isArray(part.tool_calls)) { replayable = false; continue }
      for (let offset = 0; offset < part.tool_calls.length; offset++) {
        const call = part.tool_calls[offset]
        if (!record(call) || !record(call.function)) { replayable = false; continue }
        if (Object.keys(call).some((key) => !["index", "id", "type", "function"].includes(key)) || Object.keys(call.function).some((key) => !["name", "arguments"].includes(key))) replayable = false
        const index = choice.message ? offset : call.index
        if (!count(index)) { replayable = false; continue }
        const target = calls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } }
        if (call.type !== undefined && call.type !== "function") replayable = false
        // SDK 2.0.41 takes id and name from the first delta and only appends
        // arguments; repeated metadata must not be concatenated.
        if (call.id !== undefined) {
          if (typeof call.id !== "string") replayable = false
          else if (!target.id) target.id = call.id
          else if (call.id !== target.id) replayable = false
        }
        if (call.function.name !== undefined) {
          if (typeof call.function.name !== "string") replayable = false
          else if (!target.function.name) target.function.name = call.function.name
          else if (call.function.name !== target.function.name) replayable = false
        }
        if (call.function.arguments !== undefined) {
          if (typeof call.function.arguments !== "string") replayable = false
          else target.function.arguments += call.function.arguments
        }
        calls.set(index, target)
      }
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
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
    }
  }
  const events = new Events((frame) => {
    let text: string
    try { text = decoder.decode(frame) } catch { invalid = true; return }
    const lines = text.split(/\r\n|\r|\n/)
    const values: string[] = []
    for (const [index, rawLine] of lines.entries()) {
      const line = index === 0 ? rawLine.replace(/^\uFEFF/, "") : rawLine
      const colon = line.indexOf(":")
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
      if (field === "event" && value === "error") invalid = true
      if (field === "data") values.push(value)
    }
    if (!values.length) return
    const raw = values.join("\n")
    if (raw.trim() === "[DONE]") { terminal = true; return }
    let value: unknown
    try { value = JSON.parse(raw) } catch { invalid = true; return }
    inspect(value)
    collect(value)
  })
  const json: Uint8Array[] = []
  const finish = () => {
    let completedAssistant: WireMessage | undefined
    if (replayable && choices.size === 1 && ["stop", "tool_calls"].includes(String(finishReason))) {
      const ordered = [...calls].sort(([a], [b]) => a - b)
      if (ordered.every(([index, call], offset) => {
        if (index !== offset || !call.id || !call.function.name) return false
        // SDK tool inputs are parsed and stringified again on the next turn.
        // Malformed/non-object inputs have schema-dependent recovery; do not replay.
        try {
          const input: unknown = JSON.parse(call.function.arguments)
          if (!record(input)) return false
          call.function.arguments = JSON.stringify(input)
          return true
        } catch { return false }
      })) {
        if (ordered.length) assistant.tool_calls = ordered.map(([, call]) => call)
        completedAssistant = assistant
      }
    }
    return onComplete({
      ...counts,
      ...(completedAssistant ? { assistant: completedAssistant } : {}),
      ...(typeof finishReason === "string" ? { finishReason } : {}),
    })
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(value) {
      if (stopped) return
      try {
        const item = await reader.read()
        if (stopped) return
        if (!item.done) {
          if (format === "sse") events.push(item.value)
          else if (format === "json") json.push(item.value.slice())
          value.enqueue(item.value)
          return
        }
        if (format === "sse") {
          events.push(new Uint8Array(0), true)
          const remaining = events.pending
          if (/(?:^|[\r\n])(?:\uFEFF)?data(?::|[\r\n]|$)/.test(new TextDecoder().decode(remaining))) invalid = true
        } else if (format === "json") {
          let parsed: unknown
          try {
            parsed = JSON.parse(decoder.decode(Buffer.concat(json)).replace(/^\uFEFF/, ""))
          } catch { invalid = true }
          if (!invalid) {
            inspect(parsed)
            terminal = true
            collect(parsed)
          }
        }
        if (terminal && !invalid && choices.size > 0 && [...choices].every((index) => finishedChoices.has(index))) {
          // Persist the completion before EOF; the next request may use it.
          await finish()
        }
        if (stopped) return
        stopped = true
        value.close()
      } catch (error) {
        if (stopped) return
        stopped = true
        value.error(error)
        void reader.cancel(error).catch(() => {})
      }
    },
    cancel(reason) {
      if (stopped) return
      stopped = true
      return reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}
