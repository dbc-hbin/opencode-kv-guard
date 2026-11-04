import { basename, isAbsolute } from "node:path"
import { isGeneratedEnvironment, type WireMessage } from "./prefix"
import { digest as hash, instruction, isSha256, record } from "./shared"
import { compactionOptions, policy, protocolGroups, recentCut, type Options } from "./compaction-policy"
import { applyReductions, hasSignedState, reductionText, shakeRegions, type Reduction } from "./compaction-shake"
import { softSummary, summaryPolicy } from "./compaction-summary"

export type ChatBody = { model: string; messages: WireMessage[]; tools?: unknown; [key: string]: unknown }
export type CompactionContext = {
  session: string
  lane: string
  contextWindow: number
  inputLimit?: number
  outputLimit: number
  modelOutputLimit?: number
  signal?: AbortSignal
  allowSummary?: boolean
  prefixHandoff?: boolean
  restoreReasoning?: (body: ChatBody) => ChatBody
  currentUser?: WireMessage
  estimate?: (body: ChatBody, fallback: (value: unknown) => number) => number
  overflow?: { promptTokens?: number }
  speculate?: boolean
  force?: boolean
  manual?: boolean
  completeSummary: (body: ChatBody, signal?: AbortSignal) => Promise<Response>
  artifacts?: { path: (text: string) => string; save: (path: string, text: string) => Promise<void> }
}
export type CompactionResult = { body: ChatBody; report?: Record<string, number | boolean> } | { response: Response }
type Segment = { summary: string; archived: number[] }
type Replay = { index: number; reasoning?: string; reasoning_content?: string }
type State = { segments: Segment[]; covered: number; fingerprint: string; signature: string; reductions?: Reduction[]; replay?: Replay[] }
type Speculation = { base: string; abort: AbortController; promise: Promise<void>; staged?: State }
type Lane = { session: string; tail: Promise<void>; state?: State; speculation?: Speculation }
export type CompactionSnapshot = { lanes: { key: string; state: State }[] }

export function isCompactionSnapshot(value: unknown): value is CompactionSnapshot {
  if (!record(value) || Object.keys(value).some((key) => key !== "lanes") || !Array.isArray(value.lanes)) return false
  const keys = new Set<string>()
  return value.lanes.every((lane) => {
    if (!record(lane) || Object.keys(lane).some((key) => key !== "key" && key !== "state") || !isSha256(lane.key) || keys.has(lane.key) || !record(lane.state)) return false
    keys.add(lane.key)
    const state = lane.state
    const covered = state.covered
    if (Object.keys(state).some((key) => !["segments", "covered", "fingerprint", "signature", "reductions", "replay"].includes(key)) || !Array.isArray(state.segments) || typeof covered !== "number" || !Number.isSafeInteger(covered) || covered < 1 || !isSha256(state.fingerprint) || !isSha256(state.signature)) return false
    if (state.replay !== undefined) {
      if (!Array.isArray(state.replay)) return false
      let previous = -1
      if (!state.replay.every((entry) => {
        if (!record(entry) || Object.keys(entry).some((key) => !["index", "reasoning", "reasoning_content"].includes(key))
          || typeof entry.index !== "number" || !Number.isSafeInteger(entry.index) || entry.index <= previous || entry.index >= covered
          || (entry.reasoning !== undefined && typeof entry.reasoning !== "string")
          || (entry.reasoning_content !== undefined && typeof entry.reasoning_content !== "string")
          || entry.reasoning === undefined && entry.reasoning_content === undefined) return false
        previous = entry.index
        return true
      })) return false
    }
    let last = -1
    if (!state.segments.every((segment) => {
      if (!record(segment) || Object.keys(segment).some((key) => key !== "summary" && key !== "archived") || typeof segment.summary !== "string" || !segment.summary.trim() || !Array.isArray(segment.archived) || !segment.archived.length) return false
      return segment.archived.every((index) => {
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index <= last || index >= covered) return false
        last = index
        return true
      })
    })) return false
    if (state.reductions === undefined) return last >= 0
    if (!Array.isArray(state.reductions) || !state.reductions.length) return false
    const seen = new Set<string>()
    return state.reductions.every((reduction) => {
      if (!record(reduction) || typeof reduction.index !== "number" || !Number.isSafeInteger(reduction.index) || reduction.index < 0 || reduction.index >= covered) return false
      if (reduction.kind === "media") {
        const key = JSON.stringify([reduction.index, reduction.kind])
        if (seen.has(key)) return false
        seen.add(key)
        return Object.keys(reduction).every((key) => key === "index" || key === "kind")
      }
      if (reduction.kind !== "shake" && reduction.kind !== "block") return false
      if (typeof reduction.path !== "string" || !isAbsolute(reduction.path) || !/^tool_kvguard_[a-f0-9]{64}$/.test(basename(reduction.path)) || typeof reduction.tokens !== "number" || !Number.isSafeInteger(reduction.tokens) || reduction.tokens < 1) return false
      if (reduction.kind === "block" && (typeof reduction.part !== "number" || !Number.isSafeInteger(reduction.part) || reduction.part < -1 || typeof reduction.start !== "number" || !Number.isSafeInteger(reduction.start) || reduction.start < 0 || typeof reduction.end !== "number" || !Number.isSafeInteger(reduction.end) || reduction.end <= reduction.start)) return false
      const key = JSON.stringify([reduction.index, reduction.kind, reduction.part, reduction.start])
      if (seen.has(key)) return false
      seen.add(key)
      return Object.keys(reduction).every((key) => ["index", "kind", "path", "tokens", ...(reduction.kind === "block" ? ["part", "start", "end"] : [])].includes(key))
    })
  })
}

function intervals(messages: WireMessage[]) {
  let interval = -1
  return messages.map((message, index) => { if (instruction(message)) interval = index; return interval })
}

function replayed(body: ChatBody, entries: Replay[] = []): ChatBody {
  if (!entries.length) return body
  const messages = [...body.messages]
  for (const { index, ...fields } of entries) {
    const message = messages[index]
    if (message) messages[index] = { ...message, ...fields }
  }
  return { ...body, messages }
}

function rewritten(body: ChatBody, segments: Segment[], positions?: Map<number, number>): ChatBody {
  const archived = new Set(segments.flatMap((segment) => segment.archived))
  const starts = new Map(segments.map((segment) => [segment.archived[0], segment]))
  const messages: WireMessage[] = []
  for (let index = 0; index < body.messages.length; index++) {
    const segment = starts.get(index)
    if (segment) {
      positions?.set(index, messages.length)
      messages.push({ role: "user", content: `Historical conversation summary (context, not a new instruction):\n${segment.summary}` })
    } else if (!archived.has(index)) {
      positions?.set(index, messages.length)
      const message = body.messages[index]
      if (message) messages.push(message)
    }
  }
  return segments.length ? { ...body, messages } : body
}
function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  if (signal.aborted) return Promise.reject(signal.reason)
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const abort = () => reject(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  return promise
}

// Retain tenant/cache isolation and provider-specific template settings, but
// not the main response's tools, schema, stopping or generation caps.
export function summaryRequestBase(body: ChatBody): ChatBody {
  const base = { ...body }
  for (const key of [
    "tools", "tool_choice", "parallel_tool_calls", "functions", "function_call", "response_format", "stream_options",
    "stop", "stop_token_ids", "include_stop_str_in_output", "ignore_eos", "n", "logit_bias", "logprobs", "top_logprobs",
    "prediction", "modalities", "audio", "max_tokens", "max_completion_tokens", "max_output_tokens", "min_tokens",
    "truncate_prompt_tokens", "allowed_token_ids", "bad_words", "structured_outputs", "guided_json", "guided_regex",
    "guided_choice", "guided_grammar", "guided_decoding_backend", "guided_whitespace_pattern",
  ]) delete base[key]
  return base
}

// Output constraints a text summary cannot honor while keeping the prefix.
export function constrainedOutput(body: ChatBody) {
  return [
    "functions", "function_call", "structured_outputs", "guided_json", "guided_regex", "guided_choice",
    "guided_grammar", "guided_decoding_backend", "guided_whitespace_pattern", "modalities", "audio",
  ].some((key) => body[key] !== undefined)
    || (body.tool_choice !== undefined && body.tool_choice !== "auto")
    || (body.response_format !== undefined && (!record(body.response_format) || body.response_format.type !== "text" || Object.keys(body.response_format).some((key) => key !== "type")))
}

// OpenCode 1.19.4's own context-overflow classifier (packages/llm/src/
// provider-error.ts), so the plugin retries exactly what OpenCode would treat
// as overflow.
const overflowPatterns = [
  /prompt is too long/i, /request_too_large/i, /input is too long for requested model/i, /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i, /maximum prompt length is \d+/i, /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i, /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, /exceeds the limit of \d+/i,
  /exceeds the available context size/i, /greater than the context length/i, /context window exceeds limit/i,
  /exceeded model token limit/i, /context[_ ]length[_ ]exceeded/i, /request entity too large/i, /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i, /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i, /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i, /too many tokens/i, /token limit exceeded/i,
]
const overflowExclusions = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]
function isContextOverflow(message: string) {
  return !overflowExclusions.some((pattern) => pattern.test(message)) && overflowPatterns.some((pattern) => pattern.test(message))
}

// Prompt tokens a provider reported in its overflow error, when it states them.
export function overflowPromptTokens(message: string) {
  const match = /(\d[\d,]*) (?:tokens )?(?:in|from) the (?:input )?messages|prompt has (\d[\d,]*) tokens?|input \((\d[\d,]*) tokens\)/i.exec(message)
  const value = match?.slice(1).find((group) => group !== undefined)
  if (value === undefined) return undefined
  const tokens = Number(value.replaceAll(",", ""))
  return Number.isSafeInteger(tokens) ? tokens : undefined
}

// A provider error response read once. `response()` rebuilds it unchanged.
export type ProviderError = { overflow: boolean; text: string; response: () => Response }
export async function providerError(response: Response): Promise<ProviderError | undefined> {
  if (![400, 413, 422].includes(response.status)) return undefined
  const text = await response.text()
  let message = text
  try {
    const value: unknown = JSON.parse(text)
    const error = record(value) ? value.error ?? value.message : undefined
    message = typeof error === "string" ? error : record(error) && typeof error.message === "string" ? `${error.message} ${typeof error.code === "string" ? error.code : ""}` : text
  } catch {}
  return {
    // OpenCode also classifies a body-less 400/413 as overflow.
    overflow: response.status === 413 || response.status === 400 && (!text.trim() || isContextOverflow(message)),
    text: message,
    response: () => new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }),
  }
}

// Tool-call markup a template-level tool parser would have extracted. With
// tool_choice "none" the server may return it as plain text instead.
const toolCallText = /^<tool_call>|<\/tool_call>$/

// Read one non-streaming summary completion; returns its validated text and the
// parsed completion so callers can forward usage.
export type SummaryResult = { content: string; completion: Record<string, unknown> }
export async function readSummary(response: Response, signal?: AbortSignal): Promise<SummaryResult> {
  let value: unknown
  const reader = response.body?.getReader()
  try {
    if (!reader) throw new Error("Empty summary response body")
    const decoder = new TextDecoder()
    let text = ""
    while (true) {
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    value = JSON.parse(text)
  } catch (error) {
    await reader?.cancel(error).catch(() => {})
    throw new Error("Compaction summary response was interrupted or malformed; no summary state was committed", { cause: error })
  } finally {
    reader?.releaseLock()
  }
  const choice = record(value) && Array.isArray(value.choices) && value.choices.length === 1 ? value.choices[0] : undefined
  const message = record(choice) && record(choice.message) ? choice.message : undefined
  if (!record(choice) || choice.finish_reason !== "stop" || !message || message.role !== "assistant" || typeof message.content !== "string" || !message.content.trim() || toolCallText.test(message.content.trim()) || (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) || message.function_call !== undefined) {
    throw new Error("Compaction summary must contain one nonempty assistant text response with finish_reason stop and no tool calls; truncated or partial summaries are not committed")
  }
  return { content: message.content, completion: value as Record<string, unknown> }
}

export class RollingCompaction {
  readonly options: Readonly<Options> | false
  private readonly lanes = new Map<string, Lane>()
  constructor(input?: unknown) { this.options = compactionOptions(input) }

  private key(body: ChatBody, context: Pick<CompactionContext, "session" | "lane">) {
    return hash(JSON.stringify([context.session, context.lane, body.model]))
  }

  private retained(body: ChatBody, context: Pick<CompactionContext, "session" | "lane" | "currentUser">, candidate?: State) {
    const state = candidate ?? this.lanes.get(this.key(body, context))?.state
    const lastUser = context.currentUser ? body.messages.indexOf(context.currentUser) : body.messages.findLastIndex((message) => message.role === "user" && !isGeneratedEnvironment(message))
    let leading = 0
    while (instruction(body.messages[leading] ?? { role: "" })) leading++
    const signature = hash(JSON.stringify({ policy: this.options, model: body.model, tools: body.tools, response_format: body.response_format, chat_template_kwargs: body.chat_template_kwargs, enable_thinking: body.enable_thinking, preserve_thinking: body.preserve_thinking, reasoning_effort: body.reasoning_effort, cache_salt: body.cache_salt, user: body.user, messages: body.messages.slice(0, leading) }))
    if (!state || state.signature !== signature || body.messages.length < state.covered || hash(JSON.stringify(body.messages.slice(0, state.covered))) !== state.fingerprint) return { signature }
    const units = protocolGroups(body.messages)
    const policies = intervals(body.messages)
    const lastGroup = units.findLast((group) => !isGeneratedEnvironment(body.messages[group.start] ?? { role: "" }))
    const newestTool = units.findLast((group) => group.start > lastUser && Array.isArray(body.messages[group.start]?.tool_calls))
    const archived = new Set(state.segments.flatMap((segment) => segment.archived))
    if (archived.has(lastUser)) return { signature }
    const seen = new Set<number | undefined>()
    for (const segment of state.segments) {
      const interval = policies[segment.archived[0] ?? -1]
      if (seen.has(interval) || segment.archived.some((index) => policies[index] !== interval)) return { signature }
      seen.add(interval)
      const indices = new Set(segment.archived)
      for (const group of units) {
        const count = Array.from({ length: group.end - group.start }, (_, offset) => group.start + offset).filter((index) => indices.has(index)).length
        const message = body.messages[group.start]
        if (count && (count !== group.end - group.start || group === lastGroup || group === newestTool || !message || instruction(message) || isGeneratedEnvironment(message))) return { signature }
      }
    }
    for (const reduction of state.reductions ?? []) {
      const message = body.messages[reduction.index]
      if (!message || instruction(message) || isGeneratedEnvironment(message) || hasSignedState(message)) return { signature }
      if (reduction.kind === "media") {
        if (!Array.isArray(message.content)) return { signature }
      } else {
        if (reduction.index === lastUser || reduction.kind === "shake" && message.role !== "tool") return { signature }
        if (reduction.kind === "block" && message.role !== "user" && message.role !== "assistant") return { signature }
        const text = reductionText(message, reduction)
        if (!text || basename(reduction.path) !== "tool_kvguard_" + hash(text)) return { signature }
        // Re-derive eligibility with the rescue preset, including skill/artifact protections.
        const eligible = shakeRegions(body.messages, { protectTokens: 0, minSavings: 0, currentUser: lastUser, count: () => 400, archived: new Set(), reductions: [] })
        if (!eligible.some((region) => region.index === reduction.index && region.kind === reduction.kind && (region.kind !== "block" || reduction.kind === "block" && region.part === reduction.part && region.start === reduction.start && region.end === reduction.end))) return { signature }
      }
    }
    for (const entry of state.replay ?? []) {
      const message = body.messages[entry.index]
      if (!message || message.role !== "assistant" || hasSignedState(message)
        || state.segments.some((segment) => segment.archived.includes(entry.index))
        || ["reasoning", "reasoning_content"].some((field) => Object.hasOwn(message, field) && Object.hasOwn(entry, field))) return { signature }
    }
    return { signature, state }
  }

  reconstruct(body: ChatBody, context: Pick<CompactionContext, "session" | "lane" | "currentUser">): ChatBody {
    if (this.options === false) return body
    const { state } = this.retained(body, context)
    if (!state) return body
    const restored = replayed(body, state.replay)
    return rewritten({ ...restored, messages: applyReductions(restored.messages, state.reductions ?? []) }, state.segments)
  }

  prepare(body: ChatBody, context: CompactionContext): Promise<CompactionResult> {
    if (this.options === false) return Promise.resolve({ body })
    context.signal?.throwIfAborted()
    const key = this.key(body, context)
    let lane = this.lanes.get(key)
    if (!lane) { lane = { session: context.session, tail: Promise.resolve() }; this.lanes.set(key, lane) }
    const entry = lane
    const active = () => {
      context.signal?.throwIfAborted()
      if (this.lanes.get(key) !== entry) throw new Error("Compaction session was cleared while a request was in flight; prepare the current history again")
    }
    const pending = entry.tail.then(() => { active(); return this.compact(body, context, entry, active) })
    entry.tail = pending.then(() => {}, () => {})
    return abortable(pending, context.signal)
  }

  // Start compacting `body` in the background, as if it had crossed the
  // trigger, without committing. A later prepare that does cross the trigger
  // adopts the result when the committed state and history still match it.
  speculate(body: ChatBody, context: CompactionContext) {
    if (this.options === false) return
    const key = this.key(body, context)
    const lane = this.lanes.get(key)
    if (!lane || lane.speculation) return
    const abort = new AbortController()
    const signal = context.signal ? AbortSignal.any([context.signal, abort.signal]) : abort.signal
    const base = JSON.stringify(lane.state ?? null)
    const scratch: Lane = { session: lane.session, tail: Promise.resolve(), state: lane.state && structuredClone(lane.state) }
    const entry: Speculation = { base, abort, promise: Promise.resolve() }
    const active = () => {
      signal.throwIfAborted()
      if (this.lanes.get(key) !== lane || lane.speculation !== entry) throw new Error("Speculative compaction was superseded")
    }
    lane.speculation = entry
    entry.promise = (async () => {
      try {
        const result = await this.compact(body, { ...context, signal, force: true, speculate: false }, scratch, active)
        // A discarded upstream error must still be consumed: its body holds
        // the endpoint admission slot until EOF or cancellation.
        if ("response" in result) await result.response.body?.cancel().catch(() => {})
        active()
        if ("body" in result && result.report?.compacted && scratch.state && JSON.stringify(lane.state ?? null) === base) entry.staged = scratch.state
      } catch {}
      if (!entry.staged && lane.speculation === entry) lane.speculation = undefined
    })()
  }

  private async compact(source: ChatBody, context: CompactionContext, lane: Lane, active: () => void, adopted = false): Promise<CompactionResult> {
    const config = this.options
    if (config === false) return { body: source }
    for (const [name, value] of [["contextWindow", context.contextWindow], ["outputLimit", context.outputLimit], ["inputLimit", context.inputLimit], ["modelOutputLimit", context.modelOutputLimit]] as const) {
      if ((name === "inputLimit" || name === "modelOutputLimit") && value === undefined) continue
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Compaction requires an actual positive integer ${name}; no model limits are guessed`)
    }
    const rawCount = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") / config.bytesPerToken)
    const measured = (body: ChatBody) => context.estimate?.(body, rawCount) ?? rawCount(body)
    const budget = Math.floor(Math.min(context.inputLimit ?? Infinity, context.contextWindow - context.outputLimit) - config.marginTokens)
    if (budget < 1) throw new Error("Compaction has no input budget after the actual output reserve and margin")
    const resolved = policy(context.contextWindow, config)
    const { trigger, target } = resolved
    const cap = Math.min(context.modelOutputLimit ?? Infinity, resolved.summaryCap)
    const lastUser = context.currentUser ? source.messages.indexOf(context.currentUser) : source.messages.findLastIndex((message) => message.role === "user" && !isGeneratedEnvironment(message))
    if (context.currentUser && lastUser < 0) throw new Error("Cannot compact without the exact current user instruction object in the outgoing history")
    const units = protocolGroups(source.messages)
    const retained = this.retained(source, context, lane.state)
    const state = retained.state
    if (!state) lane.state = undefined
    let segments = structuredClone(state?.segments ?? [])
    let reductions = structuredClone(state?.reductions ?? [])
    let storageFailed = false
    // Re-create expired artifacts from authenticated source bytes before reuse.
    // reconstruct itself stays pure for checkpoint CAS reconciliation.
    if (state?.reductions?.some((reduction) => reduction.kind !== "media")) {
      try {
        if (!context.artifacts) throw new Error("Artifact storage unavailable")
        for (const reduction of state.reductions) {
          if (reduction.kind === "media") continue
          const message = source.messages[reduction.index]
          const text = message && reductionText(message, reduction)
          if (text === undefined || context.artifacts.path(text) !== reduction.path) throw new Error("Artifact source mismatch")
          active()
          await context.artifacts.save(reduction.path, text)
          active()
        }
      } catch (error) {
        active()
        storageFailed = true
        // Do not commit or dispatch a placeholder for a file we could not save.
        segments = []
        reductions = []
        lane.state = undefined
      }
    }
    const initialReductionCount = reductions.length
    let workingSource = replayed(source, lane.state?.replay)
    const effective = () => {
      const body = rewritten(reductions.length ? { ...workingSource, messages: applyReductions(workingSource.messages, reductions) } : workingSource, segments)
      return context.restoreReasoning?.(body) ?? body
    }
    const current = effective()
    // Size and summarize proven replayed fields, while checkpoint fingerprints
    // continue to authenticate the untouched source transcript.
    const positions = new Map<number, number>()
    rewritten({ ...source, messages: applyReductions(source.messages, reductions) }, segments, positions)
    workingSource = { ...source, messages: source.messages.map((message, index) => {
      const position = positions.get(index)
      const restored = position === undefined ? undefined : current.messages[position]
      if (!restored || restored.role !== "assistant" || message.role !== "assistant") return message
      const fields = Object.fromEntries(["reasoning", "reasoning_content"].flatMap((field) =>
        !Object.hasOwn(message, field) && typeof restored[field] === "string" ? [[field, restored[field]]] : []))
      return Object.keys(fields).length ? { ...message, ...fields } : message
    }) }
    const before = measured(source)
    const observed = measured(current)
    const correction = Math.max(1, observed / Math.max(1, rawCount(current)))
    // OMP prepareCompaction compares provider prompt occupancy to conversation
    // messages, not to tools/system scaffolding, when correcting the kept tail.
    const tailCorrection = context.estimate ? Math.max(1, observed / Math.max(1, current.messages.filter((message) => !instruction(message)).reduce((sum, message) => sum + rawCount(message), 0))) : 1
    let overflow = context.overflow !== undefined
    let overflowScale = overflow ? Math.max(1, Math.max(context.overflow?.promptTokens ?? 0, budget + 1) / Math.max(1, observed)) : 1
    const estimate = (body: ChatBody) => Math.ceil((body === current ? observed : Math.max(measured(body), rawCount(body) * correction)) * overflowScale)
    let calls = 0
    let prefixHandoff = false
    let rescue = false
    const report = (body: ChatBody, compacted: boolean) => ({
      estimatedBefore: before, estimatedAfter: estimate(body), budget, trigger, target, compacted, reused: !!state,
      summaryRequests: calls, coveredMessages: new Set(segments.flatMap((segment) => segment.archived)).size,
      shakenResults: reductions.filter((reduction) => reduction.kind === "shake").length,
      shakenBlocks: reductions.filter((reduction) => reduction.kind === "block").length,
      droppedMedia: reductions.filter((reduction) => reduction.kind === "media").length,
      prefixHandoff, rescue, ...(storageFailed ? { shakeStorageFailed: true } : {}),
    })
    if (context.allowSummary === false) {
      if (estimate(current) > budget) throw new Error(`Summary-disabled request estimates ${estimate(current)} input tokens, exceeding budget ${budget}; native/manual compaction must fit without recursive summarization`)
      return { body: current, report: report(current, false) }
    }
    if (estimate(current) <= trigger && estimate(current) <= budget && !context.force && !context.manual && !overflow) {
      // Pinned OMP speculation-lead.ts.
      const lead = Math.min(32000, Math.max(8192, Math.floor(trigger * 0.125)))
      return { body: current, report: { ...report(current, false), ...(context.speculate && estimate(current) >= trigger - lead ? { speculate: true } : {}) } }
    }
    const speculation = lane.speculation
    if (speculation && overflow) {
      speculation.abort.abort(new Error("Speculative compaction was superseded by overflow recovery"))
      lane.speculation = undefined
    } else if (speculation && !adopted) {
      await abortable(speculation.promise, context.signal)
      active()
      if (lane.speculation === speculation) lane.speculation = undefined
      if (speculation.staged && speculation.base === JSON.stringify(lane.state ?? null) && this.retained(source, context, speculation.staged).state) {
        const previous = lane.state
        lane.state = speculation.staged
        try {
          const result = await this.compact(source, context, lane, active, true)
          if ("body" in result) return { body: result.body, report: { ...result.report, compacted: true, speculative: true } }
          lane.state = previous
          return result
        } catch (error) { lane.state = previous; throw error }
      }
    }
    const limit = () => overflow || context.manual ? budget : Math.min(target, budget)
    const progressed = (body: ChatBody) => estimate(body) <= limit() && estimate(body) < estimate(current)
    const commit = () => {
      const body = effective()
      if (estimate(body) > budget) throw new Error(`Compaction cannot fit input budget ${budget}; no summary state was committed`)
      active()
      const archived = new Set(segments.flatMap((segment) => segment.archived))
      const replay: Replay[] = workingSource.messages.flatMap((message, index) => {
        const original = source.messages[index]
        if (!original || archived.has(index) || message.role !== "assistant") return []
        const entry: Replay = { index }
        if (!Object.hasOwn(original, "reasoning") && typeof message.reasoning === "string") entry.reasoning = message.reasoning
        if (!Object.hasOwn(original, "reasoning_content") && typeof message.reasoning_content === "string") entry.reasoning_content = message.reasoning_content
        return entry.reasoning !== undefined || entry.reasoning_content !== undefined ? [entry] : []
      })
      const covered = Math.max(-1, ...archived, ...reductions.map((reduction) => reduction.index), ...replay.map((entry) => entry.index)) + 1
      if (covered) lane.state = { segments: structuredClone(segments), reductions: reductions.length ? structuredClone(reductions) : undefined, replay: replay.length ? replay : undefined, covered, fingerprint: hash(JSON.stringify(source.messages.slice(0, covered))), signature: retained.signature }
      return { body, report: { ...report(body, true), shook: reductions.filter((reduction) => reduction.kind === "shake" || reduction.kind === "block").length - (state?.reductions?.filter((reduction) => reduction.kind !== "media").length ?? 0) } }
    }
    const policies = intervals(source.messages)
    const fixed = { ...source, messages: source.messages.filter(instruction) }
    if (estimate(fixed) > budget) throw new Error(`Compaction cannot fit input budget ${budget}: fixed system/tools/format exceed the hard limit; no summary state was committed`)
    const preparePlans = () => {
      const archived = new Set(segments.flatMap((segment) => segment.archived))
      const liveUnits = units.filter((group) => !archived.has(group.start))
      const tail = Math.max(1, Math.floor(resolved.keepRecentTokens / tailCorrection / overflowScale))
      const cut = recentCut(liveUnits, applyReductions(workingSource.messages, reductions), tail, rawCount)
      const lastGroup = units.findLast((group) => !isGeneratedEnvironment(source.messages[group.start] ?? { role: "" }))
      const newestTool = units.findLast((group) => group.start > lastUser && Array.isArray(source.messages[group.start]?.tool_calls))
      const splitTurnStart = source.messages[cut]?.role === "assistant"
        ? source.messages.findLastIndex((message, index) => index < cut && message.role === "user" && !isGeneratedEnvironment(message))
        : -1
      const plans = new Map<number | undefined, { previous?: Segment; additions: number[]; splitTurnStart: number }>()
      for (const group of units) {
        const message = source.messages[group.start]
        if (group.start >= cut || group === lastGroup || group === newestTool || !message || instruction(message) || isGeneratedEnvironment(message) || group.start <= lastUser && group.end > lastUser || archived.has(group.start)) continue
        const interval = policies[group.start]
        let plan = plans.get(interval)
        if (!plan) { plan = { previous: segments.find((segment) => policies[segment.archived[0] ?? -1] === interval), additions: [], splitTurnStart }; plans.set(interval, plan) }
        for (let index = group.start; index < group.end; index++) plan.additions.push(index)
      }
      return [...plans.values()]
    }
    const update = (plan: { previous?: Segment; additions: number[] }, summary: string) => {
      if (plan.previous) segments = segments.filter((segment) => segment !== plan.previous)
      segments.push({ summary, archived: [...(plan.previous?.archived ?? []), ...plan.additions].sort((a, b) => a - b) })
      segments.sort((a, b) => (a.archived[0] ?? 0) - (b.archived[0] ?? 0))
    }
    // Handoff is one stage, before any shake. All requests share exactly the
    // same current prefix, even when authority requires multiple local summaries.
    const handoffPlans = preparePlans()
    if (context.prefixHandoff && !constrainedOutput(current) && !overflow && handoffPlans.length) {
      const prior = structuredClone(segments)
      const positions = new Map<number, number>()
      rewritten({ ...source, messages: applyReductions(source.messages, reductions) }, segments, positions)
      let failed = false
      for (const plan of handoffPlans) {
        const selected = [...(plan.previous ? [positions.get(plan.previous.archived[0] ?? -1)] : []), ...plan.additions.map((index) => positions.get(index))].filter((index): index is number => index !== undefined).sort((a, b) => a - b)
        const request: ChatBody = { ...summaryRequestBase(current), ...(current.tools !== undefined ? { tools: current.tools, tool_choice: "none" } : {}), messages: [...current.messages, { role: "user", content: `${summaryPolicy}\nProduce the historical checkpoint using only the messages at these zero-based positions: ${JSON.stringify(selected)}. Other messages remain verbatim and must not be incorporated.` }], stream: false, ...(source.max_completion_tokens !== undefined ? { max_completion_tokens: cap } : { max_tokens: cap }) }
        const summaryBudget = Math.min(context.inputLimit ?? Infinity, context.contextWindow - cap) - config.marginTokens
        if (estimate(request) > summaryBudget) { failed = true; break }
        active()
        calls++
        try {
          const response = await context.completeSummary(request, context.signal)
          try { active() } catch (error) { await response.body?.cancel(error).catch(() => {}); throw error }
          if (!response.ok) {
            const error = await providerError(response)
            if (error?.overflow) {
              overflow = true
              overflowScale = Math.max(overflowScale, Math.max(overflowPromptTokens(error.text) ?? 0, budget + 1) / Math.max(1, observed))
            } else if (!error) await response.body?.cancel().catch(() => {})
            failed = true
            break
          }
          const summary = (await readSummary(response, context.signal)).content
          active()
          if (rawCount(summary) > cap) { failed = true; break }
          update(plan, summary)
          prefixHandoff = true
        } catch (error) {
          active()
          if (!(error instanceof Error)) throw error
          failed = true
          break
        }
      }
      if (!failed && progressed(effective())) return commit()
      segments = prior
      prefixHandoff = false
    }
    const shake = async (protectTokens: number, minSavings: number) => {
      if (!context.artifacts) return
      const positions = new Map<number, number>()
      const projected = rewritten({ ...workingSource, messages: applyReductions(workingSource.messages, reductions) }, segments, positions)
      const restored = context.restoreReasoning?.(projected) ?? projected
      const costs = source.messages.map((_, index) => {
        const position = positions.get(index)
        const message = position === undefined ? undefined : restored.messages[position]
        return message ? rawCount(message) : 0
      })
      const regions = shakeRegions(source.messages, { protectTokens, minSavings, currentUser: lastUser, count: rawCount, costs, archived: new Set(segments.flatMap((segment) => segment.archived)), reductions })
      for (const region of regions) {
        const path = context.artifacts.path(region.text)
        active()
        try { await context.artifacts.save(path, region.text) } catch (error) { active(); storageFailed = true; continue }
        active()
        const { text: _, ...reduction } = region
        reductions.push({ ...reduction, path })
      }
    }
    await shake(16000, 4000)
    if (progressed(effective())) return commit()
    // Soft consumes previous summary + newly archived history, once, with an
    // actual generated result per authority interval rather than reserved maxima.
    const plans = preparePlans()
    for (const plan of plans) {
      const history = plan.splitTurnStart < 0 ? plan.additions : plan.additions.filter((index) => index < plan.splitTurnStart)
      const prefix = plan.splitTurnStart < 0 ? [] : plan.additions.filter((index) => index >= plan.splitTurnStart)
      let summary = plan.previous?.summary ?? ""
      if (history.length) {
        const result = await softSummary({ body: { ...workingSource, messages: applyReductions(workingSource.messages, reductions) }, context, additions: history, previous: plan.previous?.summary, cap, margin: config.marginTokens, count: rawCount, active, onRequest: () => { calls++ } })
        if ("response" in result) return result
        summary = result.summary
      }
      if (prefix.length) {
        const prefixCap = Math.max(1, Math.min(Math.floor(0.5 * resolved.summaryReserve), 16384, context.modelOutputLimit ?? Infinity, config.summaryOutputTokens ?? Infinity))
        const result = await softSummary({ body: { ...workingSource, messages: applyReductions(workingSource.messages, reductions) }, context, additions: prefix, turnPrefix: true, cap: prefixCap, margin: config.marginTokens, count: rawCount, active, onRequest: () => { calls++ } })
        if ("response" in result) return result
        summary = summary ? `${summary}\n\n---\n\n**Turn Context (split turn):**\n\n${result.summary}` : result.summary
      }
      update(plan, summary)
    }
    if (progressed(effective())) return commit()
    if (context.manual && !plans.length && estimate(current) <= budget && reductions.length === initialReductionCount) return { body: current, report: { ...report(current, false), manualNoop: true } }
    rescue = true
    await shake(0, 0)
    if (progressed(effective())) return commit()
    source.messages.forEach((message, index) => {
      if (instruction(message) || isGeneratedEnvironment(message) || hasSignedState(message) || !Array.isArray(message.content) || reductions.some((reduction) => reduction.index === index && reduction.kind === "media")) return
      if (message.content.some((part) => record(part) && ["image_url", "image", "input_image"].includes(String(part.type)))) reductions.push({ index, kind: "media" })
    })
    if (progressed(effective())) return commit()
    const after = estimate(effective())
    throw new Error(`Compaction dead-end: ${after > budget ? `cannot fit input budget ${budget}` : `cannot reach recovery target ${target} (hard input budget ${budget} fits)`}; residual estimate ${after} after handoff, shake, soft and rescue; no summary state was committed`)
  }

  snapshot(session: string): CompactionSnapshot {
    return { lanes: [...this.lanes].flatMap(([key, lane]) => lane.session === session && lane.state ? [{ key, state: structuredClone(lane.state) }] : []) }
  }

  async restore(session: string, value: unknown) {
    if (!isCompactionSnapshot(value)) return false
    const existing = [...this.lanes].filter(([, lane]) => lane.session === session).map(([key, lane]) => ({ key, lane, tail: lane.tail }))
    await Promise.all(existing.map(({ tail }) => tail))
    if (existing.some(({ key, lane, tail }) => this.lanes.get(key) !== lane || lane.tail !== tail)) return false
    for (const { lane } of existing) lane.state = undefined
    for (const lane of value.lanes) {
      const prior = this.lanes.get(lane.key)
      if (prior?.session === session && existing.some((entry) => entry.lane === prior)) prior.state = structuredClone(lane.state)
      else if (!prior) this.lanes.set(lane.key, { session, tail: Promise.resolve(), state: structuredClone(lane.state) })
    }
    return true
  }

  delete(session: string) {
    for (const [key, lane] of this.lanes) if (lane.session === session) {
      lane.speculation?.abort.abort(new Error("Compaction session was deleted"))
      this.lanes.delete(key)
    }
  }

  clear() {
    for (const lane of this.lanes.values()) lane.speculation?.abort.abort(new Error("Compaction state was cleared"))
    this.lanes.clear()
  }
}
