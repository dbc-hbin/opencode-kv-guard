import type { CompactionContext } from "./compaction"
import { providerError, readSummary, summaryRequestBase } from "./compaction"
import type { WireMessage } from "./prefix"
import { record, type ChatBody } from "./shared"
import { summarizationSystem, summaryPrompt } from "./compaction-prompts"

// OMP's generic transcript format, adapted from its internal message union to
// OpenAI wire messages. Provider signatures and media payloads are never text.
function transcriptMessage(message: WireMessage): string {
  const blocks = Array.isArray(message.content) ? message.content.filter(record) : []
  const text = typeof message.content === "string" ? message.content : blocks.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("")
  if (message.role === "user") return `[User]: ${text || "[No text content; non-text payload omitted from the summary transcript]"}`
  if (message.role === "tool") {
    const clipped = text.length > 2000 ? `${text.slice(0, 2000)}\n\n[... ${text.length - 2000} more characters truncated]` : text
    return `[Tool Result]: ${clipped || "[No text content; non-text payload omitted from the summary transcript]"}`
  }
  if (message.role !== "assistant") return ""
  const parts: string[] = []
  const thinking = [message.reasoning, message.reasoning_content, ...blocks.filter((part) => part.type === "thinking").map((part) => part.thinking)].flatMap((value) =>
    Array.isArray(value) ? value.filter(record).map((part) => part.text) : [value]).filter((part): part is string => typeof part === "string" && part.length > 0)
  if (thinking.length) parts.push(`[Think]: ${thinking.join("\n")}`)
  if (text) parts.push(`[Assistant]: ${text}`)
  if (Array.isArray(message.tool_calls)) {
    const calls = message.tool_calls.filter(record).flatMap((call) => {
      if (!record(call.function) || typeof call.function.name !== "string") return []
      let args = call.function.arguments
      if (typeof args === "string") { try { args = JSON.parse(args) } catch {} }
      const rendered = record(args) ? Object.entries(args).map(([key, value]) => `${key}=${JSON.stringify(value) ?? "null"}`).join(", ") : String(args ?? "")
      return [`${call.function.name}(${rendered})`]
    })
    if (calls.length) parts.push(`[Tool Call]: ${calls.join("; ")}`)
  }
  return parts.join("\n\n") || "[Assistant]: [No text content; non-text payload omitted from the summary transcript]"
}

type SummaryInput = {
  body: ChatBody
  context: CompactionContext
  additions: number[]
  previous?: string
  turnPrefix?: boolean
  cap: number
  margin: number
  count: (value: unknown) => number
  promptCount: (body: ChatBody) => number
  active: () => void
  onRequest: () => void
}

// generateSummary's bounded, carried-summary windows. Only an oversized single summary-input message may be
// truncated, as upstream clampConversationToBudget does; live messages never are.
export async function softSummary(input: SummaryInput): Promise<{ summary: string } | { response: Response }> {
  const { body, context, cap, count, active } = input
  const minInput = Math.min(16384, Math.max(1024, Math.floor(context.contextWindow / 8)))
  const inputBudget = Math.max(minInput, Math.floor(context.contextWindow * 0.8) - cap - 16384)
  const hardBudget = Math.floor(Math.min(context.inputLimit ?? Infinity, context.contextWindow - cap) - input.margin)
  const entries = input.additions.map((index) => transcriptMessage(body.messages[index] ?? { role: "user", content: "" })).filter(Boolean)
  const pending: { entries: string[]; budget: number }[] = []
  const pack = (lines: string[], budget: number) => {
    const windows: { entries: string[]; budget: number }[] = []
    let current: string[] = []
    let tokens = 0
    for (const line of lines) {
      const size = count(line)
      if (tokens > 0 && tokens + size > budget) { windows.push({ entries: current, budget }); current = []; tokens = 0 }
      current.push(line)
      tokens += size
    }
    if (current.length) windows.push({ entries: current, budget })
    return windows
  }
  pending.push(...pack(entries, inputBudget))
  let summary = input.previous ?? ""
  while (pending.length) {
    const window = pending[0]
    if (!window) break
    const text = window.entries.join("\n\n")
    const tokens = count(text)
    let sent = text
    if (tokens > window.budget) {
      const keep = Math.max(1024, Math.floor(text.length * window.budget * 0.95 / tokens))
      if (keep < text.length) sent = `${text.slice(0, keep)}\n\n[... ${text.length - keep} more characters truncated]`
    }
    const request: ChatBody = {
      ...summaryRequestBase(body),
      messages: [{ role: "system", content: summarizationSystem }, { role: "user", content: summaryPrompt(sent, summary, input.turnPrefix && !summary) }],
      stream: false,
      ...(body.max_completion_tokens !== undefined ? { max_completion_tokens: cap } : { max_tokens: cap }),
    }
    // Server input limits include adapter scaffolding and the carried summary.
    // Repack before dispatch rather than silently changing the main output cap.
    if (input.promptCount(request) > hardBudget) {
      const halved = Math.floor(Math.min(window.budget, count(sent)) / 2)
      if (halved < 1) throw new Error(`Compaction summarizer cannot fit input budget ${hardBudget}; no summary state was committed`)
      pending.splice(0, 1, ...pack(window.entries, halved))
      continue
    }
    active()
    input.onRequest()
    const response = await context.completeSummary(request, context.signal)
    try { active() } catch (error) { await response.body?.cancel(error).catch(() => {}); throw error }
    if (!response.ok) {
      const failure = await providerError(response)
      const halved = Math.floor(Math.min(window.budget, count(sent)) / 2)
      if (failure?.overflow && halved >= minInput) { pending.splice(0, 1, ...pack(window.entries, halved)); continue }
      return { response: failure ? failure.response() : response }
    }
    summary = (await readSummary(response, context.signal)).content
    active()
    if (count(summary) > cap) throw new Error(`Compaction summary exceeds its heuristic output reserve ${cap}; no summary state was committed`)
    pending.shift()
  }
  return { summary }
}
