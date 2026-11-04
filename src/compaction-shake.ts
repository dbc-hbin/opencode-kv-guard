import type { WireMessage } from "./prefix"
import { isGeneratedEnvironment } from "./prefix"
import { instruction, record } from "./shared"

export type ShakeReduction = { index: number; kind: "shake"; path: string; tokens: number }
  | { index: number; kind: "block"; path: string; tokens: number; part: number; start: number; end: number }
export type Reduction = ShakeReduction | { index: number; kind: "media" }
export type ShakeRegion = Omit<Extract<ShakeReduction, { kind: "shake" }>, "path"> & { text: string }
  | Omit<Extract<ShakeReduction, { kind: "block" }>, "path"> & { text: string }

export const shakePlaceholder = (path: string, tokens: number) => `[Content removed from context (~${tokens} tokens); full output: ${JSON.stringify(path)}]`

function protectedResult(message: WireMessage, calls: Map<unknown, Record<string, unknown>>) {
  const call = calls.get(message.tool_call_id)
  if (!call || !record(call.function)) return false
  if (call.function.name === "skill") return true
  if (call.function.name !== "read" || typeof call.function.arguments !== "string") return false
  let args: unknown
  try { args = JSON.parse(call.function.arguments) } catch { return false }
  const path = record(args) ? args.path ?? args.filePath : undefined
  if (typeof path === "string" && (/^(skill|artifact):\/\//.test(path)
    || /(?:^|[/\\])tool_kvguard_(?:[a-f0-9]{48}|[a-f0-9]{64})(?::|$)/.test(path)
    || /(?:^|[/\\])tool-output[/\\]tool_[A-Za-z0-9_-]+(?::|$)/.test(path))) return true
  const details = record(message.details) ? message.details : undefined
  const meta = record(details?.meta) ? details.meta : undefined
  const source = record(meta?.source) ? meta.source : undefined
  return source?.type === "internal" && typeof source.value === "string" && source.value.startsWith("artifact://")
}

export function hasSignedState(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSignedState)
  return record(value) && Object.entries(value).some(([key, entry]) => /signature|encrypted/i.test(key) || typeof entry !== "string" && hasSignedState(entry))
}

// scanTextForBlockRanges from the pinned OMP shake.ts: complete fences and
// top-level lowercase XML only; ignore XML inside fences and nested ranges.
function blockRanges(text: string) {
  const ranges: { start: number; end: number }[] = []
  let fenceStart = -1
  let xmlStart = -1
  const tags: string[] = []
  let lineStart = 0
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== "\n") continue
    const line = text.slice(lineStart, i)
    const trimmed = line.trimStart()
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (fenceStart < 0) fenceStart = lineStart
      else { ranges.push({ start: fenceStart, end: i }); fenceStart = -1 }
    } else if (fenceStart < 0) {
      const opening = line.length === trimmed.length ? /^<([a-z_-]+)(?:\s+[^>]*)?>$/.exec(trimmed) : null
      if (opening?.[1]) {
        if (!tags.length) xmlStart = lineStart
        tags.push(opening[1])
      } else {
        const closing = /^<\/([a-z_-]+)>$/.exec(trimmed)
        if (closing && tags.length && tags.at(-1) === closing[1]) {
          tags.pop()
          if (!tags.length && xmlStart >= 0) { ranges.push({ start: xmlStart, end: i }); xmlStart = -1 }
        }
      }
    }
    lineStart = i + 1
  }
  let end = -1
  return ranges.sort((a, b) => a.start - b.start).filter((range) => {
    if (range.start < end) return false
    end = range.end
    return true
  })
}

export function shakeRegions(messages: WireMessage[], config: { protectTokens: number; minSavings: number; currentUser: number; count: (value: unknown) => number; costs?: number[]; archived: Set<number>; reductions: Reduction[] }) {
  const after: number[] = []
  let accumulated = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    after[index] = accumulated
    accumulated += config.costs?.[index] ?? config.count(messages[index])
  }
  const calls = new Map<unknown, Record<string, unknown>>()
  for (const message of messages) if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) if (record(call)) calls.set(call.id, call)
  const regions: ShakeRegion[] = []
  messages.forEach((message, index) => {
    if (index === config.currentUser || config.archived.has(index) || instruction(message) || isGeneratedEnvironment(message) || hasSignedState(message)) return
    if (config.reductions.some((reduction) => reduction.index === index && reduction.kind !== "media")) return
    const useless = message.useless === true && message.isError !== true
    if (!useless && (after[index] ?? 0) < config.protectTokens) return
    if (message.role === "tool") {
      if (message.prunedAt !== undefined || protectedResult(message, calls)) return
      const fragments = typeof message.content === "string" ? [message.content] : Array.isArray(message.content)
        ? message.content.flatMap((part) => record(part) && part.type === "text" && typeof part.text === "string" && part.text.length ? [part.text] : []) : []
      if (!fragments.length) return
      const text = fragments.join("\n")
      regions.push({ index, kind: "shake", text, tokens: fragments.reduce((sum, fragment) => sum + config.count(fragment), 0) })
      return
    }
    if (message.role !== "user" && message.role !== "assistant") return
    const parts = typeof message.content === "string" ? [{ part: -1, text: message.content }] : Array.isArray(message.content)
      ? message.content.flatMap((part, partIndex) => record(part) && part.type === "text" && typeof part.text === "string" ? [{ part: partIndex, text: part.text }] : []) : []
    for (const { part, text } of parts) for (const range of blockRanges(text)) {
      const original = text.slice(range.start, range.end)
      const tokens = config.count(original)
      if (tokens >= 400) regions.push({ index, kind: "block", part, ...range, tokens, text: original })
    }
  })
  return regions.reduce((sum, region) => sum + Math.max(0, region.tokens - 16), 0) < config.minSavings ? [] : regions
}

export function reductionText(message: WireMessage, reduction: ShakeReduction) {
  if (reduction.kind === "shake") {
    if (typeof message.content === "string") return message.content
    if (Array.isArray(message.content)) return message.content.flatMap((part) => record(part) && part.type === "text" && typeof part.text === "string" && part.text.length ? [part.text] : []).join("\n")
    return undefined
  }
  const part = reduction.part === -1 ? undefined : Array.isArray(message.content) ? message.content[reduction.part] : undefined
  const text = reduction.part === -1 ? message.content : record(part) && part.type === "text" ? part.text : undefined
  return typeof text === "string" && reduction.end <= text.length ? text.slice(reduction.start, reduction.end) : undefined
}

export function applyReductions(messages: WireMessage[], reductions: Reduction[]) {
  if (!reductions.length) return messages
  const result = [...messages]
  const ordered = [...reductions].sort((a, b) => (b.kind === "block" ? b.start : -1) - (a.kind === "block" ? a.start : -1))
  for (const reduction of ordered) {
    const original = result[reduction.index]
    if (!original) continue
    const message = { ...original }
    switch (reduction.kind) {
      case "shake": {
        const replacement = shakePlaceholder(reduction.path, reduction.tokens)
        let replaced = false
        message.content = Array.isArray(message.content) ? message.content.flatMap((part) => {
          if (!record(part) || part.type !== "text") return [part]
          if (replaced || typeof part.text !== "string" || !part.text.length) return []
          replaced = true
          return [{ type: "text", text: replacement }]
        }) : replacement
        break
      }
      case "block": {
        const replacement = shakePlaceholder(reduction.path, reduction.tokens)
        const replace = (text: string) => text.slice(0, reduction.start) + replacement + text.slice(reduction.end)
        if (reduction.part === -1 && typeof message.content === "string") message.content = replace(message.content)
        else if (Array.isArray(message.content)) message.content = message.content.map((part, index) => index === reduction.part && record(part) && typeof part.text === "string" ? { ...part, text: replace(part.text) } : part)
        break
      }
      case "media":
        if (Array.isArray(message.content)) message.content = message.content.map((part) => record(part) && (part.type === "image_url" || part.type === "image" || part.type === "input_image") ? { type: "text", text: `[${part.type} omitted to fit the context]` } : part)
        break
    }
    result[reduction.index] = message
  }
  return result
}
