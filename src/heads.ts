import { createHash, randomUUID } from "node:crypto"
import type { ChatBody } from "./compaction"
import { canonical, type WireMessage } from "./prefix"

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const instruction = (message: WireMessage) => message.role === "system" || message.role === "developer"
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const equal = (a: unknown, b: unknown) => hash(a) === hash(b)
const key = (session: string, lane: string, model?: string) => hash([session, lane, model ?? null])
type HeadTool = { type: "function"; function: { name: string; [field: string]: unknown }; [field: string]: unknown }

function json(value: unknown, depth = 0): boolean {
  if (depth > 100) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => json(item, depth + 1))
  return object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.values(value).every((item) => json(item, depth + 1))
}

function tools(value: unknown): HeadTool[] | null | false {
  if (value === undefined) return null
  if (!Array.isArray(value)) return false
  const names = new Set<string>()
  for (const tool of value) {
    if (!object(tool) || !json(tool) || tool.type !== "function" || !object(tool.function) || typeof tool.function.name !== "string" || !tool.function.name || names.has(tool.function.name)) return false
    names.add(tool.function.name)
  }
  return canonical([...value].sort((a, b) => {
    const left = a.function.name
    const right = b.function.name
    return left < right ? -1 : left > right ? 1 : 0
  })) as HeadTool[]
}

function chain(messages: WireMessage[]) {
  let previous = hash([])
  return messages.map((message) => previous = hash([previous, message]))
}

export type HeadContext = { session: string; lane: string; currentUser?: WireMessage; parentSession?: string; parentLane?: string }
export type HeadResetReason = "tools-added" | "tools-removed" | "tools-replaced" | "tools-schema-changed" | "tools-availability-changed" | "system-contract-changed" | "unanchored-system-addition" | "history-edited" | "history-reverted"
export type HeadReport = {
  status: "initialized" | "stable" | "appended" | "reset" | "unsupported"
  reason?: HeadResetReason | "unsupported-tools"
  notices: number
  parent?: "shared" | "incompatible" | "missing"
}
type HeadNotice = { anchor: string; system: WireMessage[] }
type HeadLane = { lane: string; model: string; system: WireMessage[]; tools: HeadTool[] | null; chain: string[]; notices: HeadNotice[] }
export type SessionHeadsSnapshot = { version: 1; session: string; lanes: HeadLane[] }

export function isSessionHeadsSnapshot(value: unknown, session: string): value is SessionHeadsSnapshot {
  if (!object(value) || !exactKeys(value, ["version", "session", "lanes"]) || value.version !== 1 || value.session !== session || !Array.isArray(value.lanes)) return false
  const lanes = new Set<string>()
  const systems = (items: unknown): items is WireMessage[] => Array.isArray(items) && items.every((item) => object(item) && typeof item.role === "string" && instruction(item as WireMessage) && json(item))
  return value.lanes.every((lane) => {
    if (!object(lane) || !exactKeys(lane, ["lane", "model", "system", "tools", "chain", "notices"]) || typeof lane.lane !== "string" || !lane.lane || typeof lane.model !== "string" || !lane.model || !systems(lane.system) || !Array.isArray(lane.chain) || !lane.chain.every(sha256) || new Set(lane.chain).size !== lane.chain.length || !Array.isArray(lane.notices)) return false
    const id = key(session, lane.lane, lane.model)
    if (lanes.has(id)) return false
    lanes.add(id)
    const normalized = tools(lane.tools === null ? undefined : lane.tools)
    if (normalized === false || JSON.stringify(normalized) !== JSON.stringify(lane.tools)) return false
    let anchor = -1
    return lane.notices.every((notice) => {
      if (!object(notice) || !exactKeys(notice, ["anchor", "system"]) || !sha256(notice.anchor) || !systems(notice.system) || !notice.system.length) return false
      const index = (lane.chain as string[]).indexOf(notice.anchor)
      if (index < anchor || index < 0) return false
      anchor = index
      return true
    })
  })
}

function toolReset(previous: HeadTool[] | null, next: HeadTool[] | null): HeadResetReason | undefined {
  if (equal(previous, next)) return
  if (previous === null || next === null) return "tools-availability-changed"
  const before = new Set(previous.map((item) => item.function.name))
  const after = new Set(next.map((item) => item.function.name))
  const added = [...after].some((name) => !before.has(name))
  const removed = [...before].some((name) => !after.has(name))
  return added && removed ? "tools-replaced" : removed ? "tools-removed" : added ? "tools-added" : "tools-schema-changed"
}

// Only complete, still-authoritative instruction messages can move to a notice.
// Edited text and every tool-contract change establish a new head instead.
export class SessionHeads {
  private readonly lanes = new Map<string, { session: string; state: HeadLane }>()

  apply(body: ChatBody, context: HeadContext): { body: ChatBody; report: HeadReport } {
    const id = key(context.session, context.lane, body.model)
    const normalizedTools = tools(body.tools)
    if (normalizedTools === false) {
      this.lanes.delete(id)
      return { body, report: { status: "unsupported", reason: "unsupported-tools", notices: 0 } }
    }
    let count = 0
    while (count < body.messages.length && instruction(body.messages[count]!)) count++
    const system = body.messages.slice(0, count)
    const conversation = body.messages.slice(count)
    const anchors = chain(conversation)
    const previous = this.lanes.get(id)?.state
    let state: HeadLane
    const report: HeadReport = { status: previous ? "stable" : "initialized", notices: 0 }
    const fresh = (): HeadLane => ({ lane: context.lane, model: body.model, system: structuredClone(system), tools: structuredClone(normalizedTools), chain: anchors, notices: [] })
    if (!previous) {
      state = fresh()
      if (context.parentSession) {
        const parent = this.lanes.get(key(context.parentSession, context.parentLane ?? context.lane, body.model))?.state
        if (!parent) report.parent = "missing"
        else if (!equal([...parent.system, ...parent.notices.flatMap((notice) => notice.system)], system) || !equal(parent.tools, normalizedTools) || parent.notices.length && (!anchors.length || conversation.some(instruction))) report.parent = "incompatible"
        else {
          state.system = structuredClone(parent.system)
          state.tools = structuredClone(parent.tools)
          // Equal policy text is already authoritative in the child's input.
          // Re-anchor it locally; parent conversation anchors never cross over.
          if (parent.notices.length) state.notices = [{ anchor: anchors.at(-1)!, system: structuredClone(system.slice(parent.system.length)) }]
          report.parent = "shared"
        }
      }
    } else {
      const effective = [...previous.system, ...previous.notices.flatMap((notice) => notice.system)]
      let shared = 0
      while (shared < previous.chain.length && previous.chain[shared] === anchors[shared]) shared++
      let reason = toolReset(previous.tools, normalizedTools)
      if (!reason && shared < previous.chain.length) reason = shared === anchors.length ? "history-reverted" : "history-edited"
      const compatible = system.length >= effective.length && effective.every((message, index) => equal(message, system[index]))
      if (!reason && !compatible) reason = "system-contract-changed"
      // Moving an instruction across another original instruction can change
      // same-role precedence, even if both messages retain their roles.
      if (!reason && (previous.notices.length || system.length > effective.length) && conversation.some(instruction)) reason = "system-contract-changed"
      if (!reason && system.length > effective.length && !anchors.length) reason = "unanchored-system-addition"
      if (reason) {
        state = fresh()
        report.status = "reset"
        report.reason = reason
      } else {
        state = structuredClone(previous)
        state.chain = anchors
        if (system.length > effective.length) {
          state.notices.push({ anchor: anchors.at(-1)!, system: structuredClone(system.slice(effective.length)) })
          report.status = "appended"
        }
      }
    }
    this.lanes.set(id, { session: context.session, state })
    report.notices = state.notices.reduce((total, notice) => total + notice.system.length, 0)
    const messages = [...structuredClone(state.system)]
    for (let index = 0; index < conversation.length; index++) {
      messages.push(conversation[index]!)
      for (const notice of state.notices) if (notice.anchor === anchors[index]) messages.push(...structuredClone(notice.system))
    }
    const result: ChatBody = { ...body, messages }
    if (state.tools !== null) result.tools = structuredClone(state.tools)
    return { body: result, report }
  }

  snapshot(session: string): SessionHeadsSnapshot {
    return { version: 1, session, lanes: [...this.lanes.values()].filter((entry) => entry.session === session).map((entry) => structuredClone(entry.state)) }
  }

  restore(session: string, value: unknown) {
    if (!isSessionHeadsSnapshot(value, session)) return false
    this.delete(session)
    for (const state of value.lanes) this.lanes.set(key(session, state.lane, state.model), { session, state: structuredClone(state) })
    return true
  }

  delete(session: string) { for (const [id, lane] of this.lanes) if (lane.session === session) this.lanes.delete(id) }
  clear() { this.lanes.clear() }
}

type MessageHashes = { hash: string; role: string; fields: Record<string, string> }
type RequestHashes = { fields: Record<string, string>; messages: MessageHashes[] }
type RequestBinding = { fields: string; length: number; chain: string }
type AssistantRecord = { request: RequestBinding; assistant: WireMessage }
type PrefixLane = { lane: string; receipt: string; previous: RequestHashes; records: AssistantRecord[] }
export type PrefixGuardSnapshot = { version: 1; session: string; lanes: PrefixLane[] }
export type PrefixContext = { session: string; lane: string; currentUser?: WireMessage; replay?: boolean; observe?: boolean }
export type AssistantContext = PrefixContext & { outcome: "success" | "failed" | "aborted"; finishReason: string; receipt?: string }
export type PrefixDivergence = {
  kind: "request-field-added" | "request-field-removed" | "request-field-changed" | "message-field-added" | "message-field-removed" | "message-field-changed" | "messages-appended" | "history-truncated"
  field?: string
  index?: number
  count?: number
  classification?: "model" | "tools" | "system" | "developer" | "role" | "content" | "tool-calls" | "reasoning" | "other"
}
export type PrefixGuardReport = { receipt: string; firstRequest: boolean; sharedMessages: number; previousMessages: number; currentMessages: number; divergences: PrefixDivergence[]; replayed: { index: number; fields: string[] }[] }

function messageHashes(message: WireMessage): MessageHashes {
  return { hash: hash(message), role: message.role, fields: Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined).map(([field, value]) => [field, hash(value)])) }
}

function structure(body: ChatBody): RequestHashes {
  return {
    fields: Object.fromEntries(Object.entries(body).filter(([field, value]) => field !== "messages" && value !== undefined).map(([field, value]) => [field, hash(value)])),
    messages: body.messages.map(messageHashes),
  }
}

function structuralChain(messages: MessageHashes[]) {
  let previous = hash([])
  return messages.map((message) => previous = hash([previous, message.hash]))
}

function bound(request: RequestBinding, fields: string, anchors: string[]) {
  return request.fields === fields && anchors.length >= request.length && request.chain === (request.length ? anchors[request.length - 1] : hash([]))
}

function plainAssistant(value: unknown): value is WireMessage {
  if (!object(value) || !json(value) || value.role !== "assistant" || Object.keys(value).some((field) => !["role", "content", "tool_calls", "name", "reasoning_content", "reasoning"].includes(field))) return false
  if (value.content !== undefined && value.content !== null && typeof value.content !== "string") return false
  if (value.name !== undefined && typeof value.name !== "string") return false
  if (["reasoning_content", "reasoning"].some((field) => value[field] !== undefined && typeof value[field] !== "string")) return false
  if (value.tool_calls !== undefined) {
    const ids = new Set<string>()
    if (!Array.isArray(value.tool_calls) || !value.tool_calls.every((call) => {
      if (!object(call) || !exactKeys(call, ["id", "type", "function"]) || call.type !== "function" || typeof call.id !== "string" || !call.id || ids.has(call.id) || !object(call.function) || !exactKeys(call.function, ["name", "arguments"]) || typeof call.function.name !== "string" || !call.function.name || typeof call.function.arguments !== "string") return false
      ids.add(call.id)
      return true
    })) return false
  }
  return (typeof value.content === "string" && value.content.length > 0 || Array.isArray(value.tool_calls) && value.tool_calls.length > 0) && ["reasoning_content", "reasoning"].some((field) => typeof value[field] === "string" && value[field].length > 0)
}

function isRequestHashes(value: unknown): value is RequestHashes {
  const fields = (items: unknown): items is Record<string, string> => object(items) && Object.keys(items).every((field) => field.length > 0) && Object.values(items).every(sha256)
  return object(value) && exactKeys(value, ["fields", "messages"]) && fields(value.fields) && Object.hasOwn(value.fields, "model") && !Object.hasOwn(value.fields, "messages") && Array.isArray(value.messages) && value.messages.every((message) => object(message) && exactKeys(message, ["hash", "role", "fields"]) && sha256(message.hash) && typeof message.role === "string" && !!message.role && fields(message.fields) && message.fields.role === hash(message.role))
}

export function isPrefixGuardSnapshot(value: unknown, session: string): value is PrefixGuardSnapshot {
  if (!object(value) || !exactKeys(value, ["version", "session", "lanes"]) || value.version !== 1 || value.session !== session || !Array.isArray(value.lanes)) return false
  const lanes = new Set<string>()
  return value.lanes.every((lane) => {
    if (!object(lane) || !exactKeys(lane, ["lane", "receipt", "previous", "records"]) || typeof lane.lane !== "string" || !lane.lane || lanes.has(lane.lane) || typeof lane.receipt !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(lane.receipt) || !isRequestHashes(lane.previous) || !Array.isArray(lane.records)) return false
    lanes.add(lane.lane)
    const previous = lane.previous
    const fields = hash(previous.fields)
    const anchors = structuralChain(previous.messages)
    const records = new Set<string>()
    return lane.records.every((entry) => {
      if (!object(entry) || !exactKeys(entry, ["request", "assistant"]) || !object(entry.request) || !exactKeys(entry.request, ["fields", "length", "chain"]) || !sha256(entry.request.fields) || !sha256(entry.request.chain) || !Number.isSafeInteger(entry.request.length) || (entry.request.length as number) < 0 || !plainAssistant(entry.assistant)) return false
      const request = entry.request as RequestBinding
      if (!bound(request, fields, anchors)) return false
      const assistant = previous.messages[request.length]
      if (assistant && assistant.hash !== hash(entry.assistant)) return false
      const id = hash(entry)
      if (records.has(id)) return false
      records.add(id)
      return true
    })
  })
}

function differences(previous: RequestHashes, next: RequestHashes): PrefixDivergence[] {
  const result: PrefixDivergence[] = []
  for (const field of [...new Set([...Object.keys(previous.fields), ...Object.keys(next.fields)])].sort()) {
    if (previous.fields[field] === next.fields[field]) continue
    result.push({ kind: !Object.hasOwn(previous.fields, field) ? "request-field-added" : !Object.hasOwn(next.fields, field) ? "request-field-removed" : "request-field-changed", field, classification: field === "model" ? "model" : field === "tools" || field === "tool_choice" ? "tools" : "other" })
  }
  for (let index = 0; index < Math.min(previous.messages.length, next.messages.length); index++) {
    const before = previous.messages[index]!
    const after = next.messages[index]!
    if (before.hash === after.hash) continue
    for (const field of [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])].sort()) {
      if (before.fields[field] === after.fields[field]) continue
      const classification = field === "role" ? "role" : before.role === "system" || after.role === "system" ? "system" : before.role === "developer" || after.role === "developer" ? "developer" : field === "content" ? "content" : field === "tool_calls" || field === "tool_call_id" ? "tool-calls" : ["reasoning", "reasoning_content"].includes(field) ? "reasoning" : "other"
      result.push({ kind: !Object.hasOwn(before.fields, field) ? "message-field-added" : !Object.hasOwn(after.fields, field) ? "message-field-removed" : "message-field-changed", index, field, classification })
    }
  }
  if (next.messages.length > previous.messages.length) result.push({ kind: "messages-appended", index: previous.messages.length, count: next.messages.length - previous.messages.length })
  if (next.messages.length < previous.messages.length) result.push({ kind: "history-truncated", index: next.messages.length, count: previous.messages.length - next.messages.length })
  return result
}

// The caller records only complete successful responses, against the exact body
// dispatched to the provider. Existing values, signed data and edited history
// are never repaired. A missing value alone is not evidence of a matching turn.
export class PrefixGuard {
  private readonly lanes = new Map<string, { session: string; state: PrefixLane }>()

  apply(body: ChatBody, context: PrefixContext): { body: ChatBody; report: PrefixGuardReport } {
    const id = key(context.session, context.lane)
    const prior = this.lanes.get(id)?.state
    const report: PrefixGuardReport = { receipt: randomUUID(), firstRequest: !prior, sharedMessages: 0, previousMessages: prior?.previous.messages.length ?? 0, currentMessages: body.messages.length, divergences: [], replayed: [] }
    let result = body
    const current = structure(body)
    const fields = hash(current.fields)
    const anchors: string[] = []
    const available = new Map<number, AssistantRecord[]>()
    for (const entry of prior?.records ?? []) available.set(entry.request.length, [...(available.get(entry.request.length) ?? []), entry])
    for (let index = 0; index < body.messages.length; index++) {
      const message = result.messages[index]!
      const candidates: WireMessage[] = []
      if (context.replay !== false && message.role === "assistant" && message !== context.currentUser) {
        for (const entry of available.get(index) ?? []) {
          if (!bound(entry.request, fields, anchors)) continue
          const candidate = { ...message }
          for (const field of ["reasoning_content", "reasoning"]) {
            if (!Object.hasOwn(message, field) && typeof entry.assistant[field] === "string" && entry.assistant[field].length > 0) candidate[field] = entry.assistant[field]
          }
          if (!equal(candidate, message) && equal(candidate, entry.assistant) && !candidates.some((item) => equal(item, candidate))) candidates.push(candidate)
        }
      }
      if (candidates.length === 1) {
        const candidate = candidates[0]!
        if (result === body) result = { ...body, messages: [...body.messages] }
        result.messages[index] = candidate
        report.replayed.push({ index, fields: ["reasoning_content", "reasoning"].filter((field) => !Object.hasOwn(message, field) && Object.hasOwn(candidate, field)) })
        current.messages[index] = messageHashes(candidate)
      }
      anchors.push(hash([anchors.at(-1) ?? hash([]), current.messages[index]!.hash]))
    }
    let records = prior?.records ?? []
    if (prior) {
      report.divergences = differences(prior.previous, current)
      while (report.sharedMessages < prior.previous.messages.length && prior.previous.messages[report.sharedMessages]?.hash === current.messages[report.sharedMessages]?.hash) report.sharedMessages++
      if (!equal(prior.previous.fields, current.fields)) records = []
      else if (report.sharedMessages < prior.previous.messages.length) records = records.filter((entry) => entry.request.length < report.sharedMessages)
      records = records.filter((entry) => bound(entry.request, fields, anchors) && (!current.messages[entry.request.length] || current.messages[entry.request.length]!.hash === hash(entry.assistant)))
    }
    if (context.observe !== false) this.lanes.set(id, { session: context.session, state: { lane: context.lane, receipt: report.receipt, previous: current, records } })
    return { body: result, report }
  }

  record(body: ChatBody, assistant: WireMessage, context: AssistantContext) {
    if (context.outcome !== "success" || !["stop", "tool_calls"].includes(context.finishReason) || !plainAssistant(assistant) || context.finishReason === "tool_calls" && (!Array.isArray(assistant.tool_calls) || !assistant.tool_calls.length)) return false
    const id = key(context.session, context.lane)
    const request = structure(body)
    const prior = this.lanes.get(id)?.state
    // A receipt binds this completion to one preparation, including ABA reverts
    // whose request bytes happen to equal an earlier request.
    if (!prior || context.receipt !== prior.receipt || !equal(prior.previous, request)) return false
    const state = prior
    const entry = { request: { fields: hash(request.fields), length: request.messages.length, chain: structuralChain(request.messages).at(-1) ?? hash([]) }, assistant: structuredClone(assistant) }
    if (!state.records.some((item) => equal(item, entry))) state.records.push(entry)
    this.lanes.set(id, { session: context.session, state })
    return true
  }

  snapshot(session: string): PrefixGuardSnapshot {
    return { version: 1, session, lanes: [...this.lanes.values()].filter((entry) => entry.session === session).map((entry) => structuredClone(entry.state)) }
  }

  restore(session: string, value: unknown) {
    if (!isPrefixGuardSnapshot(value, session)) return false
    this.delete(session)
    for (const state of value.lanes) this.lanes.set(key(session, state.lane), { session, state: structuredClone(state) })
    return true
  }

  delete(session: string) { for (const [id, lane] of this.lanes) if (lane.session === session) this.lanes.delete(id) }
  clear() { this.lanes.clear() }
}
