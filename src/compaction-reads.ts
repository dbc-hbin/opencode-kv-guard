import type { Plugin } from "@opencode/plugin"
import { basename, isAbsolute, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { hasOpaqueContent } from "./compaction-policy"
import { hasSignedState, type Reduction } from "./compaction-shake"
import type { WireMessage } from "./prefix"
import { record } from "./shared"

type History = Awaited<ReturnType<Plugin.Context["session"]["context"]>>
type ReadPage = {
  readonly path: string
  readonly args: string
  readonly text: string
  readonly start: number
  readonly end: number
  readonly rows: readonly string[]
  readonly order: number
}

export type ReadEvidence = ReadonlyMap<string, ReadPage>
type ReadRegion = Readonly<Omit<Extract<Reduction, { kind: "read" }>, "path">> & { readonly text: string }
type Selection = {
  readonly archived: ReadonlySet<number>
  readonly reduced: ReadonlySet<number>
  readonly witnessExcluded?: ReadonlySet<number>
  readonly count: (value: unknown) => number
  readonly evidence?: ReadEvidence
}

function attachmentPath(value: string) {
  if (isAbsolute(value)) return normalize(value)
  const url = URL.parse(value)
  if (url?.protocol !== "file:") return
  try {
    return normalize(fileURLToPath(url))
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof URIError)) throw error
  }
}

function page(input: Record<string, unknown>, text: string, order: number): ReadPage | undefined {
  const { path, offset, limit } = input
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || /[\r\n\0]/.test(path)
    || /(?:^|[/\\])(?:skills|tool-output)(?:[/\\]|$)/i.test(path)
    || /(?:^|[/\\])shell[/\\](?:[^/\\]+[/\\])?sh_[a-f0-9]{12}[^/\\]*\.out$/i.test(path)
    || /^(?:agents\.md|skill\.md|tool_(?:[a-f0-9]{12}_kvguard_|kvguard_)[a-f0-9]+)$/i.test(basename(path))
    || Object.keys(input).some((key) => key !== "path" && key !== "offset" && key !== "limit")) return
  if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) return
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)) return

  // Core v2 read emits exactly this header and one numbered row per line.
  // A continuation footer, a past-end tail or a clamped line is not complete.
  const [header, ...rows] = text.split("\n")
  const prefix = `Read file ${path}, lines `
  if (!header?.startsWith(prefix)) return
  const range = /^([1-9]\d*)-([1-9]\d*)$/.exec(header.slice(prefix.length))
  if (!range) return
  const start = Number(range[1])
  const end = Number(range[2])
  if (start !== (offset || 1) || !Number.isSafeInteger(end) || !rows.length || end - start + 1 !== rows.length) return
  if ((offset !== undefined || limit !== undefined) && rows.length > Math.min(limit || 2000, 2000)) return
  if (rows.some((row, index) => !row.startsWith(`${start + index}: `) || row.endsWith("... (line truncated to 2000 chars)"))) return
  return { path, args: JSON.stringify(input), text, start, end, rows, order }
}

// Tool status and truncation are stripped from the compatible provider wire.
// Only completed local reads positively attested by the public session history qualify.
export function readEvidence(history: History): ReadEvidence {
  const attachments = new Set<string>()
  const attachmentNames = new Set<string>()
  for (const message of history) {
    if (message.type !== "user") continue
    for (const file of message.files ?? []) {
      const location = file.source.type === "uri" ? attachmentPath(file.source.uri) : undefined
      const name = file.name === undefined ? undefined : attachmentPath(file.name)
      if (location) attachments.add(location)
      if (name) attachments.add(name)
      if (!location && !name && file.name) attachmentNames.add(basename(file.name))
    }
  }

  const seen = new Set<string>()
  const evidence = new Map<string, ReadPage>()
  for (const [order, message] of history.entries()) {
    if (message.type !== "assistant") continue
    for (const tool of message.content) {
      if (tool.type !== "tool") continue
      if (seen.has(tool.id)) {
        evidence.delete(tool.id)
        continue
      }
      seen.add(tool.id)
      const state = tool.state
      if (tool.name !== "read" || tool.executed !== false || tool.native !== undefined
        || state.status !== "completed" || state.metadata?.truncated !== false
        || Object.keys(state.metadata).length !== 1 || state.content.length !== 1) continue
      const [part] = state.content
      if (part.type !== "text") continue
      const read = page(state.input, part.text, order)
      if (read && !attachments.has(read.path) && !attachmentNames.has(basename(read.path))) evidence.set(tool.id, read)
    }
  }
  return evidence
}

function coveredBy(read: ReadPage, later: ReadPage) {
  if (read.text === later.text) return true
  if (later.order <= read.order || later.start > read.start || later.end < read.end) return false
  return read.rows.every((row, index) => row === later.rows[read.start - later.start + index])
}

export function readRegions(messages: readonly WireMessage[], { archived, reduced, witnessExcluded, count, evidence }: Selection): ReadRegion[] {
  if (!evidence?.size) return []
  const matches: { readonly index: number; readonly id: string; readonly page: ReadPage }[] = []
  const calls = new Set<string>()
  const results = new Set<string>()
  const ambiguous = new Set<string>()
  const batch = new Map<string, ReadPage>()
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      const id = message.tool_call_id
      if (typeof id !== "string") continue
      if (results.has(id)) ambiguous.add(id)
      results.add(id)
      const read = batch.get(id)
      if (read && !archived.has(index) && !reduced.has(index) && message.content === read.text
        && Object.keys(message).every((key) => key === "role" || key === "tool_call_id" || key === "content")) {
        matches.push({ index, id, page: read })
      }
      continue
    }
    batch.clear()
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
    const safe = message.reasoning_opaque === undefined && !hasOpaqueContent(message) && !hasSignedState(message)
    for (const call of message.tool_calls) {
      if (!record(call) || typeof call.id !== "string") continue
      if (calls.has(call.id)) ambiguous.add(call.id)
      calls.add(call.id)
      const read = evidence.get(call.id)
      if (safe && read && call.type === "function" && record(call.function)
        && call.function.name === "read" && call.function.arguments === read.args) batch.set(call.id, read)
    }
  }

  const witnesses = new Map<string, ReadPage[]>()
  const regions: ReadRegion[] = []
  for (const match of matches.reverse()) {
    if (ambiguous.has(match.id)) continue
    const { index, page: read } = match
    const later = witnesses.get(read.path)
    const covered = later?.some((witness) => coveredBy(read, witness))
    if (covered && (!witnessExcluded || witnessExcluded.has(index))) {
      regions.push({ index, kind: "read", text: read.text, tokens: count(read.text) })
    } else if (!witnessExcluded?.has(index)) {
      if (later) later.push(read)
      else witnesses.set(read.path, [read])
    }
  }
  return regions.reverse()
}
