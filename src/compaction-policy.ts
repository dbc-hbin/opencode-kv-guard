import type { WireMessage } from "./prefix"
import { record } from "./shared"

// Policy port: can1357/oh-my-pi@1c291b87e4b889398cc4b8e4ccdfa650b56a0486,
// packages/agent/src/compaction/compaction.ts. Provider limits stay separate.
export type CompactionOptions = false | {
  bytesPerToken?: number
  reserveTokens?: number
  thresholdTokens?: number
  thresholdPercent?: number
  keepRecentTokens?: number
  marginTokens?: number
  summaryOutputTokens?: number
}
export type Options = Exclude<CompactionOptions, false> & {
  bytesPerToken: number
  keepRecentTokens: number
  marginTokens: number
}

export function compactionOptions(input: unknown): Options | false {
  if (input === false) return false
  if (input !== undefined && !record(input)) throw new Error("compaction must be false or an options object")
  const result: Options = { bytesPerToken: 4, keepRecentTokens: 20000, marginTokens: 0 }
  for (const [key, value] of Object.entries(input ?? {})) {
    if (["triggerRatio", "targetRatio", "keepRecentTurns"].includes(key)) throw new Error(`compaction.${key} was removed; migrate to reserveTokens/thresholdTokens/thresholdPercent and keepRecentTokens (default 20000)`)
    if (!["bytesPerToken", "reserveTokens", "thresholdTokens", "thresholdPercent", "keepRecentTokens", "marginTokens", "summaryOutputTokens"].includes(key)) throw new Error(`Unknown compaction option: ${key}`)
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`compaction.${key} must be a finite number`)
    if (key === "bytesPerToken") {
      if (value <= 0) throw new Error("compaction.bytesPerToken must be positive")
      result.bytesPerToken = value
    } else if (key === "thresholdPercent") result.thresholdPercent = value
    else {
      if (!Number.isSafeInteger(value) || value < (key === "summaryOutputTokens" ? 1 : key === "thresholdTokens" ? -1 : 0)) throw new Error(`compaction.${key} must be ${key === "thresholdTokens" ? "-1 or a nonnegative integer" : `a ${key === "summaryOutputTokens" ? "positive" : "nonnegative"} integer`}`)
      switch (key) {
        case "reserveTokens": result.reserveTokens = value; break
        case "thresholdTokens": result.thresholdTokens = value; break
        case "keepRecentTokens": result.keepRecentTokens = value; break
        case "marginTokens": result.marginTokens = value; break
        case "summaryOutputTokens": result.summaryOutputTokens = value; break
      }
    }
  }
  return result
}

export function policy(window: number, config: Options) {
  const effectiveReserve = Math.max(Math.floor(window * 0.15), config.reserveTokens ?? 16384)
  const proportionalReserve = Math.max(1, Math.floor(window * 0.15))
  const reserve = config.reserveTokens === undefined && effectiveReserve >= window - proportionalReserve || effectiveReserve >= window ? proportionalReserve : effectiveReserve
  const promptBudget = Math.max(0, Math.min(window - 1, window - reserve))
  const trigger = config.thresholdTokens !== undefined && config.thresholdTokens > 0
    ? config.thresholdTokens >= window ? promptBudget : Math.min(window - 1, Math.max(1, config.thresholdTokens))
    : config.thresholdPercent !== undefined && config.thresholdPercent > 0
      ? Math.floor(window * Math.min(99, Math.max(1, config.thresholdPercent)) / 100)
      : promptBudget
  const target = Math.floor(trigger * 0.8)
  const reserveFloor = Math.min(reserve, config.reserveTokens ?? 16384)
  const tailBudget = target > reserveFloor ? target - reserveFloor : Math.floor(target / 2)
  // compact() passes the configured reserve, not effectiveReserveTokens(), to
  // generateSummary/generateTurnPrefixSummary at upstream lines 1752/2322.
  const summaryReserve = config.reserveTokens ?? 16384
  return { reserve, summaryReserve, trigger, target, keepRecentTokens: Math.min(config.keepRecentTokens, Math.max(1, tailBudget)), summaryCap: Math.max(1, Math.min(Math.floor(0.8 * summaryReserve), 16384, config.summaryOutputTokens ?? Infinity)) }
}

export type Group = { start: number; end: number }
export function protocolGroups(messages: WireMessage[]): Group[] {
  const result: Group[] = []
  for (let index = 0; index < messages.length;) {
    const message = messages[index]
    if (!message) break
    if (message.role === "tool") throw new Error(`Cannot compact orphan tool result at message ${index}`)
    let end = index + 1
    if (message.tool_calls !== undefined) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) throw new Error(`Cannot compact malformed tool calls at message ${index}`)
      const pending = new Set<string>()
      for (const call of message.tool_calls) {
        if (!record(call) || typeof call.id !== "string" || !call.id || pending.has(call.id)) throw new Error(`Cannot compact missing or duplicate tool call IDs at message ${index}`)
        pending.add(call.id)
      }
      while (messages[end]?.role === "tool") {
        const id = messages[end]?.tool_call_id
        if (typeof id !== "string" || !pending.delete(id)) throw new Error(`Cannot compact unmatched tool result at message ${end}`)
        end++
      }
      if (pending.size) throw new Error(`Cannot compact incomplete tool batch at message ${index}; missing results: ${[...pending].join(", ")}`)
    }
    result.push({ start: index, end })
    index = end
  }
  return result
}

// findCutPoint: walk complete groups backwards, keeping the newest even when
// oversized. Authority and current-user pinning are applied by the wire adapter.
export function recentCut(groups: Group[], messages: WireMessage[], budget: number, count: (value: unknown) => number) {
  let cut = groups.at(-1)?.start ?? 0
  let accumulated = 0
  for (const group of [...groups].reverse()) {
    accumulated += messages.slice(group.start, group.end).reduce((sum, message) => sum + count(message), 0)
    if (accumulated > budget) break
    cut = group.start
  }
  return cut
}
